import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockJob, claimJob, completeJob, postJob, resumeJob } from "../src/jobs";
import { legacyAgent } from "../src/agents";
import { reverifySweep } from "../src/outcome-prs";

// A pull request named only in result_ref is verified against GitHub, whoever completes
// the job (job_d5262df1dc32). Before the fix, verification read evidence.prs and nothing
// else, so a complete that sent result_ref and no evidence recorded every verified
// field false for a merged, green pull request. Real D1; GitHub is a fetch stub, the
// way test-integration/job-outcomes.test.ts drives it.

const SECRET = "test-root-secret";
const NS = "sample";
const PR = "https://github.com/example/sample/pull/3";
const SHA = "a".repeat(40);
const DRIVER_ACTOR = "agent:driver-aaaa";
const DRIVER = legacyAgent("write", DRIVER_ACTOR);
const SEAT_ACTOR = "access:seat@example.com";
const SEAT = legacyAgent("write", SEAT_ACTOR);
const NOW = new Date("2026-10-05T12:00:00.000Z");
const LATER = new Date("2026-10-05T13:00:00.000Z");

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

// What GitHub says about example/sample#3: merged, 2 commits, 3 files, one green run.
function stubGitHub(): { calls: string[] } {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/pulls/3")) {
      return Response.json({ merged: true, commits: 2, changed_files: 3, head: { sha: SHA }, node_id: "PR_node_3", created_at: "2026-10-05T10:00:00Z" });
    }
    if (url.includes("/actions/runs")) {
      return Response.json({
        workflow_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success", head_sha: SHA, head_branch: "x", event: "pull_request", html_url: "https://github.com/example/sample/actions/runs/1", created_at: "2026-10-05T10:30:00Z", updated_at: "2026-10-05T10:40:00Z" }],
      });
    }
    return new Response("not stubbed", { status: 404 });
  });
  return { calls };
}

async function outcome(id: string) {
  return env.DB.prepare("SELECT * FROM job_outcomes WHERE job_id = ?1").bind(id).first<Record<string, unknown>>();
}

async function claimed(title: string) {
  const posted = await postJob(jobsEnv(), SEAT, NOW, { namespace: NS, title, body: "do the thing", gate_required: true } as Parameters<typeof postJob>[3]);
  const id = posted.job!.id;
  const claim = await claimJob(jobsEnv(), DRIVER, NOW, { id });
  expect(claim.ok, claim.refusal).toBe(true);
  return id;
}

const VERIFIED = { prs_opened: true, prs_merged: true, commits: true, files_changed: true, ci_green: true };

beforeEach(async () => {
  for (const table of ["job_outcomes", "jobs", "audit_log", "agents", "job_outcome_prs", "job_claims"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run().catch(() => undefined);
  }
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
  await env.DB.prepare("INSERT OR REPLACE INTO namespaces (namespace, repos) VALUES (?1, ?2)").bind(NS, JSON.stringify([{ repo: "example/sample", label: "primary" }])).run();
  await env.APP_KV.put("gh:token:v3:example/sample", "test-token");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.APP_KV.delete("gh:token:v3:example/sample");
});

describe("a pull request named only in result_ref is verified", () => {
  it("REPRODUCED: the holder completes with result_ref and no evidence, and the row is verified", async () => {
    stubGitHub();
    const id = await claimed("holder, result_ref only");
    const done = await completeJob(jobsEnv(), DRIVER, LATER, id, { result_summary: "landed", result_ref: PR });
    expect(done.ok, done.refusal).toBe(true);
    const row = await outcome(id);
    expect(JSON.parse(String(row?.verified))).toEqual(VERIFIED);
    expect([row?.prs_opened, row?.prs_merged, row?.commits, row?.files_changed, row?.ci_green]).toEqual([1, 1, 2, 3, 1]);
    const joined = await env.DB.prepare("SELECT pr_url, merged, pr_node_id FROM job_outcome_prs WHERE job_id = ?1").bind(id).all();
    expect(joined.results).toEqual([{ pr_url: PR, merged: 1, pr_node_id: "PR_node_3" }]);
  });

  it("REPRODUCED: the seat takes a blocked job and completes it with result_ref only, and the row is verified", async () => {
    stubGitHub();
    const id = await claimed("seat takes it");
    const blocked = await blockJob(jobsEnv(), DRIVER, NOW, id, { reason: "needs the seat", command: "git push -u origin feat/x" });
    expect(blocked.ok, blocked.refusal).toBe(true);
    const taken = await resumeJob(jobsEnv(), SEAT, NOW, id, "the seat finishes it", { take: true });
    expect(taken.ok, taken.refusal).toBe(true);
    const done = await completeJob(jobsEnv(), SEAT, LATER, id, { result_summary: "merged", result_ref: PR });
    expect(done.ok, done.refusal).toBe(true);
    const row = await outcome(id);
    expect(JSON.parse(String(row?.verified))).toEqual(VERIFIED);
    expect([row?.prs_opened, row?.prs_merged, row?.commits, row?.files_changed, row?.ci_green]).toEqual([1, 1, 2, 3, 1]);
    // Who completed it is its own record, apart from the outcome.
    const claim = await env.DB.prepare("SELECT agent FROM job_claims WHERE job_id = ?1 AND action = 'complete'").bind(id).first<{ agent: string }>();
    expect(claim?.agent).toBe(SEAT_ACTOR);
  });

  it("control: the seat's complete with evidence.prs was verified before the fix too, so the take path was never the cause", async () => {
    stubGitHub();
    const id = await claimed("seat with evidence");
    await blockJob(jobsEnv(), DRIVER, NOW, id, { reason: "needs the seat", command: "git push -u origin feat/x" });
    const taken = await resumeJob(jobsEnv(), SEAT, NOW, id, "the seat finishes it", { take: true });
    expect(taken.ok, taken.refusal).toBe(true);
    await completeJob(jobsEnv(), SEAT, LATER, id, { result_summary: "merged", evidence: { prs: [PR] } });
    expect(JSON.parse(String((await outcome(id))?.verified))).toEqual(VERIFIED);
  });

  it("the same pull request in evidence and in result_ref is counted once", async () => {
    const { calls } = stubGitHub();
    const id = await claimed("named twice");
    await completeJob(jobsEnv(), DRIVER, LATER, id, { result_summary: "landed", result_ref: PR, evidence: { prs: [PR] } });
    const row = await outcome(id);
    expect(row?.prs_opened).toBe(1);
    expect(calls.filter((u) => u.includes("/pulls/3")).length).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM job_outcome_prs WHERE job_id = ?1").bind(id).first<{ n: number }>())?.n).toBe(1);
  });

  it("a result_ref that is a document path verifies nothing, and reads nothing from GitHub", async () => {
    const { calls } = stubGitHub();
    const id = await claimed("doc result");
    await completeJob(jobsEnv(), DRIVER, LATER, id, { result_summary: "written", result_ref: "sample/decisions.md" });
    const row = await outcome(id);
    expect(row?.prs_opened).toBeNull();
    expect(JSON.parse(String(row?.verified))).toEqual({ prs_opened: false, prs_merged: false, commits: false, files_changed: false, ci_green: false });
    expect(calls).toEqual([]);
  });
});

// Rows the bug already wrote. The sweep reads GitHub for them and corrects them through
// an audit row, never by hand.
describe("the sweep corrects outcomes recorded before the fix", () => {
  const UNVERIFIED = JSON.stringify({ prs_opened: false, prs_merged: false, commits: false, files_changed: false, ci_green: false });

  async function plant(jobId: string, resultRef: string, verified = UNVERIFIED) {
    await env.DB.prepare(
      `INSERT INTO jobs (id, namespace, title, body, status, posted_by, claimed_by, result_ref, result_summary)
       VALUES (?1, ?2, ?3, 'b', 'done', 'github:x', ?4, ?5, 'merged')`
    ).bind(jobId, NS, `planted ${jobId}`, DRIVER_ACTOR, resultRef).run();
    await env.DB.prepare(
      `INSERT INTO job_outcomes (job_id, agent, namespace, blocked_count, resumed_count, result_kind, verified, recorded_at)
       VALUES (?1, ?2, ?3, 0, 0, 'pr', ?4, '2026-10-05T11:00:00.000Z')`
    ).bind(jobId, DRIVER_ACTOR, NS, verified).run();
  }

  it("REPRODUCED: an outcome recorded unverified for a merged, green pull request is corrected with an audit row", async () => {
    stubGitHub();
    await plant("job_affected001", PR);
    const report = await reverifySweep(jobsEnv(), LATER);
    expect(report.backfilled).toBe(1);
    const row = await outcome("job_affected001");
    expect(JSON.parse(String(row?.verified))).toEqual(VERIFIED);
    expect([row?.prs_opened, row?.prs_merged, row?.commits, row?.files_changed, row?.ci_green]).toEqual([1, 1, 2, 3, 1]);
    const audit = await env.DB.prepare("SELECT actor, params FROM audit_log WHERE action = 'outcome-backfilled' AND path = 'jobs/job_affected001.md'").all<{ actor: string; params: string }>();
    expect(audit.results.length).toBe(1);
    expect(audit.results[0].actor).toBe("system:outcome-backfill");
    const params = JSON.parse(audit.results[0].params);
    expect(params.before).toMatchObject({ commits: null, ci_green: null, verified: UNVERIFIED });
    expect(params.after).toMatchObject({ commits: 2, files_changed: 3, ci_green: 1 });
    // A second sweep finds nothing left to correct.
    expect((await reverifySweep(jobsEnv(), LATER)).backfilled).toBe(0);
  });

  it("a row already verified is not read or rewritten, and a pull request GitHub will not answer for is left as it was", async () => {
    await plant("job_verified001", PR, JSON.stringify(VERIFIED));
    await env.DB.prepare("UPDATE job_outcomes SET commits = 9 WHERE job_id = 'job_verified001'").run();
    await plant("job_unread00001", "https://github.com/example/sample/pull/404");
    const { calls } = stubGitHub();
    const report = await reverifySweep(jobsEnv(), LATER);
    expect(report.backfilled).toBe(0);
    expect((await outcome("job_verified001"))?.commits).toBe(9);
    expect(JSON.parse(String((await outcome("job_unread00001"))?.verified))).toEqual(JSON.parse(UNVERIFIED));
    expect(calls.some((u) => u.includes("/pulls/404"))).toBe(true);
    const audits = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'outcome-backfilled'").first<{ n: number }>();
    expect(audits?.n).toBe(0);
  });
});
