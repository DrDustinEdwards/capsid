import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockJob, claimJob, completeJob, failAsCaller, failJob, postJob } from "../src/jobs";
import { legacyAgent } from "../src/agents";
import { buildServer } from "../src/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Claims apart from verified outcomes, against a real D1 (migrations/0023). What the
// agent said lands in job_claims in the transition's own batch, before GitHub is read,
// and the worker's checks land beside it in job_evaluations. Append-only is a trigger,
// so it is exercised here rather than read off the DDL.
//
// job_claims and job_evaluations refuse DELETE once they hold a row, so nothing here
// empties them: every assertion is scoped to the job id the test posted, and ids are
// minted fresh per post.

const SEAT = "access:admin@example.com";
const DRIVER_ACTOR = "agent:driver-aaaa";
const DRIVER = legacyAgent("write", DRIVER_ACTOR);
const NS = "sample";
const PR = "https://github.com/example/sample/pull/3";
const HEAD = "c".repeat(40);
const NOW = new Date("2026-09-29T12:00:00.000Z");
const LATER = new Date("2026-09-29T13:00:00.000Z");

function jobsEnv() {
  return { ...env } as unknown as Parameters<typeof postJob>[0];
}

async function claimed(title: string, actor = DRIVER) {
  const posted = await postJob(jobsEnv(), legacyAgent("write", SEAT), NOW, { namespace: NS, title, body: "do the thing" });
  expect(posted.ok, posted.refusal).toBe(true);
  const id = posted.job!.id;
  const claim = await claimJob(jobsEnv(), actor, NOW, { id });
  expect(claim.ok, claim.refusal).toBe(true);
  return id;
}

async function claimsFor(id: string) {
  return (await env.DB.prepare("SELECT * FROM job_claims WHERE job_id = ?1 ORDER BY id").bind(id).all<Record<string, unknown>>()).results;
}

async function evaluationsFor(id: string) {
  return (await env.DB.prepare("SELECT * FROM job_evaluations WHERE job_id = ?1 ORDER BY id").bind(id).all<Record<string, unknown>>()).results;
}

async function jobRow(id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<Record<string, unknown>>();
}

// GitHub, faked at fetch: the pull request is merged with five commits and eight files,
// and CI on its head is green. The driver will say otherwise.
function fakeGitHub() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/\/repos\/example\/sample\/pulls\/3$/.test(url)) {
      return Response.json({ merged: true, commits: 5, changed_files: 8, head: { sha: HEAD } });
    }
    if (/\/repos\/example\/sample\/actions\/runs/.test(url)) {
      return Response.json({
        workflow_runs: [
          { id: 1, name: "ci", head_sha: HEAD, status: "completed", conclusion: "success", event: "pull_request", created_at: "2026-09-29T11:00:00Z", html_url: "https://github.com/example/sample/actions/runs/1" },
        ],
      });
    }
    return new Response(`no route for ${url}`, { status: 404 });
  });
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("INSERT OR REPLACE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
    .bind(NS, JSON.stringify([{ repo: "example/sample", label: "primary" }]))
    .run();
  await env.APP_KV.put("gh:token:v3:example/sample", "test-token");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.APP_KV.delete("gh:token:v3:example/sample");
});

describe("job_claims: what the agent said", () => {
  it("PLANT: the claim row keeps the driver's count when GitHub's differs", async () => {
    const id = await claimed("claim beside github");
    fakeGitHub();
    const done = await completeJob(jobsEnv(), DRIVER, LATER, id, {
      result_summary: "landed",
      result_ref: PR,
      evidence: { prs: [PR], commits: 2, files_changed: 1, tests_added: 3 },
      claim: { prs_merged: [PR], tests: { run: 40, passed: 40, failed: 0, result: "pass" }, deploy_state: "none" },
    });
    expect(done.ok, done.refusal).toBe(true);

    const claims = await claimsFor(id);
    expect(claims.length, "exactly one claim row per complete").toBe(1);
    const claim = claims[0];
    expect(claim.action).toBe("complete");
    expect(claim.agent).toBe(DRIVER_ACTOR);
    expect(claim.namespace).toBe(NS);
    // The driver's numbers, not GitHub's five and eight.
    expect(claim.commits).toBe(2);
    expect(claim.files_changed).toBe(1);
    expect(claim.tests_added).toBe(3);
    expect(claim.prs_opened).toBe(1);
    expect(claim.prs_merged).toBe(1);
    expect([claim.tests_run, claim.tests_passed, claim.tests_failed, claim.tests_result]).toEqual([40, 40, 0, "pass"]);
    expect(claim.deploy_state).toBe("none");
    expect(claim.capsid_sha).toBe("integration");
    expect(JSON.parse(String(claim.raw))).toMatchObject({ evidence: { commits: 2 }, result_summary: "landed", result_ref: PR });

    // job_outcomes is unchanged: it still stores GitHub's number.
    const outcome = await env.DB.prepare("SELECT commits, files_changed FROM job_outcomes WHERE job_id = ?1").bind(id).first<Record<string, unknown>>();
    expect(outcome).toEqual({ commits: 5, files_changed: 8 });
  });

  it("the evaluations sit beside the claim, one per worker check, naming the claim row", async () => {
    const id = await claimed("evaluations side by side");
    fakeGitHub();
    const done = await completeJob(jobsEnv(), DRIVER, LATER, id, {
      result_summary: "landed",
      result_ref: PR,
      evidence: { prs: [PR], commits: 2, files_changed: 8 },
      claim: { prs_merged: [PR] },
    });
    expect(done.ok, done.refusal).toBe(true);
    const [claim] = await claimsFor(id);
    const evaluations = await evaluationsFor(id);
    expect(evaluations.map((e) => e.name).sort()).toEqual(["ci_green", "commits", "files_changed", "pr_merged", "prs_opened"]);
    const by = Object.fromEntries(evaluations.map((e) => [String(e.name), e]));
    for (const e of evaluations) {
      expect(e.claim_id, `${e.name} does not name the claim row`).toBe(claim.id);
      expect(e.evaluator).toBe("worker");
      expect(e.evaluator_id).toBe("capsid@integration");
    }
    expect([by.commits.claimed, by.commits.verified, by.commits.agreement]).toEqual(["2", "5", "disagree"]);
    expect([by.files_changed.claimed, by.files_changed.verified, by.files_changed.agreement]).toEqual(["8", "8", "agree"]);
    expect([by.pr_merged.claimed, by.pr_merged.verified, by.pr_merged.agreement, by.pr_merged.score_label]).toEqual(["1", "1", "agree", "pass"]);
    expect([by.ci_green.claimed, by.ci_green.verified, by.ci_green.agreement, by.ci_green.score_value]).toEqual([null, "1", "unclaimed", 1]);
  });

  it("PLANT: an absent field is NULL, never 0, in the stored row", async () => {
    const id = await claimed("nothing said");
    const done = await completeJob(jobsEnv(), DRIVER, LATER, id, { result_summary: "landed" });
    expect(done.ok, done.refusal).toBe(true);
    const [claim] = await claimsFor(id);
    for (const column of [
      "prs_opened_urls", "prs_merged_urls", "prs_opened", "prs_merged", "commits", "files_changed", "tests_added",
      "tests_run", "tests_passed", "tests_failed", "tests_result", "deploy_state", "files_touched",
      "model_id", "client_name", "client_version", "permission_mode",
    ]) {
      expect(claim[column], `${column} was stored as something other than NULL with nothing said`).toBeNull();
    }
    for (const e of await evaluationsFor(id)) {
      expect(e.claimed, `${e.name}.claimed`).toBeNull();
      expect(e.verified, `${e.name}.verified`).toBeNull();
      expect(e.score_value, `${e.name}.score_value`).toBeNull();
      expect(e.score_label).toBe("unknown");
    }
  });

  it("block writes a claim and no evaluation", async () => {
    const id = await claimed("blocks with a claim");
    const blocked = await blockJob(jobsEnv(), DRIVER, LATER, id, {
      reason: "needs a push",
      command: "git push origin feat/x",
      claim: { files_touched: ["src/a.ts"], versions: { client_name: "claude-code" } },
    });
    expect(blocked.ok, blocked.refusal).toBe(true);
    const claims = await claimsFor(id);
    expect(claims.length).toBe(1);
    expect(claims[0].action).toBe("block");
    expect(JSON.parse(String(claims[0].files_touched))).toEqual(["src/a.ts"]);
    expect(claims[0].client_name).toBe("claude-code");
    expect(JSON.parse(String(claims[0].raw))).toEqual({
      claim: { files_touched: ["src/a.ts"], versions: { client_name: "claude-code" } },
      reason: "needs a push",
      command: "git push origin feat/x",
    });
    expect(await evaluationsFor(id)).toEqual([]);
  });

  it("fail writes a claim and its evaluations, unchecked because fail carries no evidence", async () => {
    const id = await claimed("fails with a claim");
    const failed = await failJob(jobsEnv(), DRIVER, LATER, id, "the approach did not work", undefined, {
      claim: { tests: { run: 3, failed: 3, result: "fail" } },
    });
    expect(failed.ok, failed.refusal).toBe(true);
    const claims = await claimsFor(id);
    expect(claims.length).toBe(1);
    expect(claims[0].action).toBe("fail");
    expect(claims[0].tests_failed).toBe(3);
    expect(claims[0].tests_passed).toBeNull();
    const evaluations = await evaluationsFor(id);
    expect(evaluations.length).toBe(5);
    for (const e of evaluations) expect(e.claim_id).toBe(claims[0].id);
  });

  it("the seat failing somebody else's job writes no claim: the agent made none", async () => {
    const id = await claimed("the seat fails it");
    const seat = legacyAgent("write", SEAT);
    const failed = await failAsCaller(jobsEnv(), seat, LATER, id, "the driver is gone");
    expect(failed.ok, failed.refusal).toBe(true);
    expect(failed.action).toBe("admin-fail");
    expect(await claimsFor(id)).toEqual([]);
    expect(await evaluationsFor(id)).toEqual([]);
  });

  it("PLANT: the seat sending a claim on somebody else's job is refused, not dropped, and the job stays claimed", async () => {
    const id = await claimed("the seat fails it with a claim");
    const seat = legacyAgent("write", SEAT);
    const failed = await failAsCaller(jobsEnv(), seat, LATER, id, "the driver is gone", undefined, { claim: { deploy_state: "none" } });
    expect(failed.ok).toBe(false);
    expect(failed.refusal).toContain("takes no claim");
    expect(await claimsFor(id)).toEqual([]);
    const row = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?1").bind(id).first<{ status: string }>();
    expect(row?.status).toBe("claimed");
  });
});

describe("a refused call writes no claim", () => {
  it("PLANT: a claim that does not parse is refused, and the job stays claimed with nothing written", async () => {
    const id = await claimed("bad claim");
    for (const bad of ["{not json", JSON.stringify({ prs_opened: [PR], vibes: "good" }), { tests: { result: "green" } }]) {
      const out = await completeJob(jobsEnv(), DRIVER, LATER, id, { result_summary: "landed", claim: bad as never });
      expect(out.ok, `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
    expect((await jobRow(id))?.status).toBe("claimed");
    expect(await claimsFor(id)).toEqual([]);
    expect(await evaluationsFor(id)).toEqual([]);
  });

  it("a caller that does not hold the job writes no claim", async () => {
    const id = await claimed("held by another");
    const other = legacyAgent("write", "agent:driver-bbbb");
    const out = await completeJob(jobsEnv(), other, LATER, id, { result_summary: "mine now", claim: { deploy_state: "deployed" } });
    expect(out.ok).toBe(false);
    expect(out.refusal).toMatch(/held by agent:driver-aaaa/);
    expect(await claimsFor(id)).toEqual([]);
  });

  it("PLANT: a transition the guard aborts leaves no claim row either", async () => {
    // The tick requeues the job while GitHub is being read; the batch aborts, and the
    // claim in it goes with the transition.
    const id = await claimed("raced by the tick");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await env.DB.prepare("UPDATE jobs SET status = 'queued', claimed_by = NULL, claimed_at = NULL, lease_expires = NULL, updated_at = ?2 WHERE id = ?1")
        .bind(id, "2026-09-29T12:30:00.000Z")
        .run();
      return new Response("unavailable", { status: 503 });
    });
    const out = await completeJob(jobsEnv(), DRIVER, LATER, id, { result_summary: "landed", evidence: { prs: [PR] }, claim: { prs_merged: [PR] } });
    expect(out.ok).toBe(false);
    expect(await claimsFor(id)).toEqual([]);
    expect(await evaluationsFor(id)).toEqual([]);
  });
});

describe("the jobs tool takes claim as an object or a JSON string", () => {
  async function connected() {
    const server = buildServer(jobsEnv() as never, DRIVER);
    const client = new Client({ name: "claim-forms", version: "1.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    return client;
  }

  it("both forms land in the row, and raw holds the parsed claim, not a string of it", async () => {
    const client = await connected();
    try {
      const claim = { tests: { run: 7, result: "pass" }, versions: { model_id: "model-x" } };
      for (const [form, sent] of [["object", claim], ["string", JSON.stringify(claim)]] as const) {
        const id = await claimed(`claim as ${form}`);
        const result = (await client.callTool({
          name: "jobs",
          arguments: { action: "complete", namespace: NS, id, result_summary: "done", claim: sent },
        })) as { isError?: boolean; content: Array<{ text: string }> };
        expect(result.isError, `${form}: ${result.content[0]?.text}`).toBeFalsy();
        const [row] = await claimsFor(id);
        expect(row?.tests_run, form).toBe(7);
        expect(row?.model_id, form).toBe("model-x");
        expect(JSON.parse(String(row?.raw)).claim, form).toEqual(claim);
      }
    } finally {
      await client.close();
    }
  });

  it("an unknown key in a claim string is refused through the tool, and nothing is written", async () => {
    const client = await connected();
    try {
      const id = await claimed("unknown key through the tool");
      const result = (await client.callTool({
        name: "jobs",
        arguments: { action: "block", namespace: NS, id, reason: "needs a push", claim: JSON.stringify({ deploy_state: "none", mood: "fine" }) },
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/mood/);
      expect((await jobRow(id))?.status).toBe("claimed");
      expect(await claimsFor(id)).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

describe("append-only", () => {
  it("PLANT: job_claims refuses UPDATE and DELETE", async () => {
    const id = await claimed("append only claims");
    const blocked = await blockJob(jobsEnv(), DRIVER, LATER, id, { reason: "needs a push", claim: { deploy_state: "pending" } });
    expect(blocked.ok, blocked.refusal).toBe(true);
    expect((await claimsFor(id)).length, "no row to protect, so this proves nothing").toBe(1);
    await expect(env.DB.prepare("UPDATE job_claims SET commits = 99 WHERE job_id = ?1").bind(id).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM job_claims WHERE job_id = ?1").bind(id).run()).rejects.toThrow(/append-only/);
    const [row] = await claimsFor(id);
    expect(row.commits).toBeNull();
    expect(row.deploy_state).toBe("pending");
  });

  it("PLANT: job_evaluations refuses UPDATE and DELETE", async () => {
    const id = await claimed("append only evaluations");
    const done = await completeJob(jobsEnv(), DRIVER, LATER, id, { result_summary: "landed" });
    expect(done.ok, done.refusal).toBe(true);
    expect((await evaluationsFor(id)).length, "no row to protect, so this proves nothing").toBe(5);
    await expect(env.DB.prepare("UPDATE job_evaluations SET agreement = 'agree' WHERE job_id = ?1").bind(id).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM job_evaluations WHERE job_id = ?1").bind(id).run()).rejects.toThrow(/append-only/);
    expect((await evaluationsFor(id)).length).toBe(5);
  });
});
