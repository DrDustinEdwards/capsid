import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultScopes, serializeScopes } from "../src/agents-schema";
import type { Agent } from "../src/agents";
import { blockJob, completeJob, failJob } from "../src/jobs";
import { atCorrectionCap } from "../src/jobs-schema";

// THE REVIEW GATE ON THE HOLDER TRANSITIONS, AGAINST A REAL D1.
//
// Moved from test/review-queue.test.ts (audit 2026-09-25, item C2-15). That file drove
// the real completeJob, blockJob and failJob against a fake D1 that applied each
// UPDATE only when its SQL text matched a pattern (corrections_count =
// corrections_count + 1, SET status = ?2, COALESCE(?3), so an equivalent rewrite of
// the SQL silently stopped the fake applying it. Here SQLite applies every statement,
// the reviewer's identity comes from real audit_log and agents rows joined as the gate
// joins them, and only GitHub's issue-comments and pull request endpoints are stubbed.

const REPO = "DrDustinEdwards/capsid-mcp";
const JOB_ID = "job_reviewme1234";
const PR = `https://github.com/${REPO}/pull/27`;
const OLDER_PR = `https://github.com/${REPO}/pull/26`;
const NOW = new Date("2026-09-12T12:00:00Z");

// The head commit every pull request reports. An APPROVE counts only when it quotes
// this sha, so the approving comments below quote SHORT.
const HEAD_SHA = "abc1234def5678abc1234def5678abc1234def56";
const SHORT = HEAD_SHA.slice(0, 7);

// The comment ids the fake GitHub hands out, in the order it hands them out.
const COMMENT_IDS = [100, 101, 102, 103];

function driver(): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  return { id: "agent_dddd", name: "capsid-driver", kind: "driver", actor: "agent:capsid-driver", scopes, admin: false, row: null };
}

function reviewEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: "s" } as unknown as Parameters<typeof completeJob>[0];
}

// THE AUDIT ROWS THAT SAY WHICH COMMENTS CAPSID POSTED, AND FOR WHOM. The gate reads
// these to tell a reviewer's verdict from prose anybody with a `gh` token wrote on the
// pull request. Default: every comment the fake serves was posted for an agent holding
// can_comment_pr.
async function seedReviewer(opts: { actor?: string; canComment?: boolean } = {}) {
  const actor = opts.actor ?? "agent:capsid-reviewer";
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  scopes.flags.can_comment_pr = opts.canComment !== false;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO agents (id, name, kind, key_hash, scopes, created_by, created_at)
     VALUES (?1, ?2, 'driver', ?3, ?4, 'github:DrDustinEdwards', '2026-09-10 00:00:00')`
  )
    .bind(`agent_${actor.slice(6, 18).padEnd(12, "0")}`, actor.slice("agent:".length), `hash-${actor}`, serializeScopes(scopes))
    .run();
  for (const id of COMMENT_IDS) {
    await env.DB.prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, 'manage_pr', 'capsid', NULL, ?2)")
      .bind(actor, JSON.stringify({ repo: REPO, number: 27, action: "comment", comment_id: id }))
      .run();
  }
}

// A claimed job that asked for a review, inserted as the row a claim leaves.
async function claimedJob(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: JOB_ID,
    namespace: "capsid",
    title: "work that needs a second reader",
    body: "do the thing",
    priority: 0,
    status: "claimed",
    posted_by: "github:DrDustinEdwards",
    claimed_by: "agent:capsid-driver",
    claimed_at: "2026-09-12T09:00:00.000Z",
    lease_expires: "2026-09-12T13:00:00.000Z",
    result_ref: PR,
    result_summary: null,
    gate_required: 0,
    required_scopes: null,
    min_record: null,
    blocked_count: 0,
    resumed_count: 0,
    corrections_count: 0,
    review_required: 1,
    created_at: "2026-09-12T08:00:00.000Z",
    updated_at: "2026-09-12T09:00:00.000Z",
    ...overrides,
  };
  const columns = Object.keys(row);
  await env.DB.prepare(`INSERT INTO jobs (${columns.join(", ")}) VALUES (${columns.map((_, i) => `?${i + 1}`).join(", ")})`)
    .bind(...columns.map((c) => row[c]))
    .run();
}

async function jobRow() {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(JOB_ID).first<Record<string, unknown>>();
}

// A fake GitHub. Comments are served per pull request number (the key "*" serves any
// number), comment i posted at 1i:00, and every pull request's head is HEAD_SHA.
// Returns every URL requested.
function github(comments: Record<string, string[]>): string[] {
  const asked: string[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    asked.push(url);
    const onComments = /\/issues\/(\d+)\/comments/.exec(url);
    if (onComments) {
      const bodies = comments[onComments[1]] ?? comments["*"] ?? [];
      return json(bodies.map((body, i) => ({ id: COMMENT_IDS[i], user: { login: "reviewer" }, body, created_at: `2026-09-12T1${i}:00:00Z` })));
    }
    if (/\/pulls\/\d+$/.test(new URL(url).pathname)) return json({ head: { sha: HEAD_SHA } });
    return new Response("not modelled", { status: 404 });
  });
  return asked;
}

const withComments = (bodies: string[]) => github({ "*": bodies });

const finish = () => completeJob(reviewEnv(), driver(), NOW, JOB_ID, { result_summary: "opened PR 27", result_ref: PR });

beforeEach(async () => {
  for (const table of ["jobs", "audit_log", "agents", "job_outcomes"]) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
  await env.DB.prepare("INSERT OR REPLACE INTO namespaces (namespace, repos) VALUES ('capsid', ?1)")
    .bind(JSON.stringify([{ repo: REPO, label: "primary" }]))
    .run();
  // The installation token, cached as the client caches it, so no App JWT is minted;
  // and no cached GitHub read survives from another test.
  await env.APP_KV.put(`gh:token:v3:${REPO}`, "test-token");
  for (const key of (await env.APP_KV.list({ prefix: "gh:get:" })).keys) await env.APP_KV.delete(key.name);
  await seedReviewer();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the verdicts", () => {
  it("NO REVIEW YET: complete is refused and the job stays claimed", async () => {
    await claimedJob();
    withComments(["nice work"]);
    const result = await finish();
    expect(result.ok).toBe(false);
    expect(String(result.refusal)).toMatch(/no review yet/);
    expect((await jobRow())?.status, "a job waiting on a review must not move").toBe("claimed");
  });

  it("APPROVE: complete proceeds exactly as it would with no reviewer", async () => {
    await claimedJob();
    withComments([`REVIEW: the scope check is right at ${SHORT}. APPROVE`]);
    const result = await finish();
    expect(result.ok, `an approved job was refused: ${JSON.stringify(result)}`).toBe(true);
    const row = await jobRow();
    expect(row?.status).toBe("done");
    expect(row?.corrections_count, "an approval must not spend a correction").toBe(0);
  });

  it("CHANGES: the job goes back to the driver and SPENDS A CORRECTION", async () => {
    await claimedJob();
    withComments(["REVIEW: the error path swallows the refusal. CHANGES"]);
    const result = await finish();
    expect(result.ok).toBe(false);
    const row = await jobRow();
    expect(row?.status, "CHANGES sends the work back to the driver, it does not finish the job").toBe("claimed");
    expect(row?.corrections_count, "a rewrite that costs nothing is a loop with no ceiling").toBe(1);
    expect(String(row?.result_summary)).toMatch(/CHANGES/);
    expect(String(row?.result_summary), "the row must carry what the reviewer actually said").toMatch(/error path swallows the refusal/);
    expect(String(result.refusal), "the driver is told how much of the budget is left").toMatch(/1 of 2/);
  });

  it("A SECOND CHANGES REACHES THE CAP, so a review loop is bounded by the same ceiling a gate loop is", async () => {
    await claimedJob({ corrections_count: 1 });
    withComments(["REVIEW: still wrong. CHANGES"]);
    await finish();
    const row = await jobRow();
    expect(row?.corrections_count).toBe(2);
    expect(atCorrectionCap(Number(row?.corrections_count))).toBe(true);
  });

  it("PLANT: AT the cap, a further CHANGES BLOCKS for the seat instead of going round again", async () => {
    // The cap was enforced only on `resume`, which this path never touches (audit
    // 2026-09-13, finding 8). Driven through completeJob, the path a driver calls. THE
    // DRIVER ASKED TO COMPLETE AND THE JOB WAS BLOCKED, so the call is a refusal of the
    // complete with the block recorded (audit 2026-09-25, F3-3).
    await claimedJob({ corrections_count: 2 });
    withComments(["REVIEW: still not right. CHANGES"]);
    const result = await finish();
    expect(result.ok, "a complete that ended blocked reported success").toBe(false);
    expect(result.action).toBe("complete");
    expect(result.job?.status).toBe("blocked");
    expect(String(result.refusal)).toMatch(/blocked it for the seat/);
    const row = await jobRow();
    expect(row?.status, "a review loop past the cap sent the work back to the driver again").toBe("blocked");
    expect(row?.corrections_count, "a blocked-for-the-seat job must not also spend another correction").toBe(2);
    expect(String(row?.result_summary)).toMatch(/retry cap; human decision required/);
    expect(String(row?.result_summary), "the seat needs the reviewer's actual objection").toMatch(/still not right/);
  });

  it("THE INNOCENT DIRECTION: below the cap, CHANGES still goes back to the driver", async () => {
    await claimedJob({ corrections_count: 0 });
    withComments(["REVIEW: one more pass. CHANGES"]);
    await finish();
    const row = await jobRow();
    expect(row?.status, "an ordinary CHANGES must stay with the driver").toBe("claimed");
    expect(row?.corrections_count).toBe(1);
  });

  it("BLOCK: the job is blocked for the seat, carrying the objection", async () => {
    await claimedJob();
    withComments(["REVIEW: this changes the auth model and needs a ruling. BLOCK"]);
    const result = await finish();
    expect(result.ok, "a complete that ended blocked reported success").toBe(false);
    expect(result.action).toBe("complete");
    expect(result.job?.status).toBe("blocked");
    expect(String(result.refusal), "the refusal must carry the reviewer's objection").toMatch(/needs a ruling/);
    const row = await jobRow();
    expect(row?.status).toBe("blocked");
    expect(String(row?.result_summary)).toMatch(/BLOCK/);
    expect(String(row?.result_summary)).toMatch(/needs a ruling/);
    expect(row?.corrections_count, "a BLOCK is not a correction; nobody is being asked to fix anything").toBe(0);
  });

  it("A BLOCK THAT MEETS A REVIEWER BLOCK ended where it asked, so it reports ok", async () => {
    await claimedJob();
    withComments(["REVIEW: needs a ruling. BLOCK"]);
    const result = await blockJob(reviewEnv(), driver(), NOW, JOB_ID, { reason: "stopping" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.action).toBe("block");
    expect((await jobRow())?.status).toBe("blocked");
  });
});

describe("the gate sits on every way out", () => {
  it("THE GATE IS ON BLOCK TOO, so a driver cannot bypass it by blocking instead", async () => {
    await claimedJob();
    withComments(["nothing to see here"]);
    const result = await blockJob(reviewEnv(), driver(), NOW, JOB_ID, { reason: "ready for the seat", command: "gh pr merge 27" });
    expect(result.ok).toBe(false);
    expect(String(result.refusal)).toMatch(/no review yet/);
    expect((await jobRow())?.status).toBe("claimed");
  });

  it("A JOB WITHOUT review_required IS UNTOUCHED, which is almost every job", async () => {
    await claimedJob({ review_required: 0 });
    const result = await finish();
    expect(result.ok, `an ordinary job was held by the review gate: ${JSON.stringify(result)}`).toBe(true);
    expect((await jobRow())?.status).toBe("done");
  });

  it("PLANT: complete with a DOCUMENT KEY is refused, because the reviewed party chose the ref", async () => {
    await claimedJob({ result_ref: null });
    const result = await completeJob(reviewEnv(), driver(), NOW, JOB_ID, { result_summary: "wrote the ruling", result_ref: "capsid/decisions.md" });
    expect(result.ok, "a review_required job closed with a document key and no verdict").toBe(false);
    expect(String(result.refusal)).toMatch(/names no pull request/);
    expect((await jobRow())?.status).toBe("claimed");
  });

  it("EVIDENCE NAMES THE PULL REQUEST TOO, so reporting it there is not a way past the gate", async () => {
    await claimedJob({ result_ref: null });
    withComments([`REVIEW: reads fine at ${SHORT}. APPROVE`]);
    const result = await completeJob(reviewEnv(), driver(), NOW, JOB_ID, {
      result_summary: "opened PR 27",
      result_ref: "capsid/decisions.md",
      evidence: { prs: [PR] },
    });
    expect(result.ok, `an approved job was refused: ${JSON.stringify(result)}`).toBe(true);
    expect((await jobRow())?.status).toBe("done");
  });

  it("PLANT: a REVIEW comment Capsid did not post for a reviewer is not a verdict", async () => {
    // The identity half. A driver with local `gh` can write the envelope; what it cannot
    // do is make Capsid record that a can_comment_pr actor asked for that comment.
    await env.DB.prepare("DELETE FROM audit_log").run();
    await seedReviewer({ actor: "agent:capsid-driver", canComment: false });
    await claimedJob();
    withComments([`REVIEW: looks good to me at ${SHORT}. APPROVE`]);
    const result = await finish();
    expect(result.ok, "a comment from an actor with no can_comment_pr counted as a review").toBe(false);
    expect(String(result.refusal)).toMatch(/no review yet/);
    expect((await jobRow())?.status).toBe("claimed");
  });

  it("THE GATE IS ON FAIL TOO, so a driver cannot walk away from a CHANGES by failing", async () => {
    await claimedJob();
    withComments(["REVIEW: the refusal is swallowed. CHANGES"]);
    const result = await failJob(reviewEnv(), driver(), NOW, JOB_ID, "giving up");
    expect(result.ok).toBe(false);
    const row = await jobRow();
    expect(row?.status, "fail closed a job the reviewer had sent back").toBe("claimed");
    expect(String(row?.result_summary)).toMatch(/CHANGES/);
  });

  it("FAIL WITH NO PULL REQUEST STILL WORKS, because work that could not be done has none", async () => {
    await claimedJob({ result_ref: null });
    const result = await failJob(reviewEnv(), driver(), NOW, JOB_ID, "the API this needs was retired");
    expect(result.ok, `a genuinely failed job was stranded: ${JSON.stringify(result)}`).toBe(true);
    expect((await jobRow())?.status).toBe("failed");
  });
});

// ---- the gate is bound to the job's own pull request and head (audit 2026-09-25, F2-4)

describe("the gate is bound to the job's own pull request and head", () => {
  it("PLANT: after CHANGES, completing with an older APPROVED pull request is refused", async () => {
    await claimedJob({ result_ref: null });
    github({ "27": ["REVIEW: the error path is wrong. CHANGES"], "26": [`REVIEW: fine at ${SHORT}. APPROVE`] });
    await finish();
    expect((await jobRow())?.corrections_count).toBe(1);
    const result = await completeJob(reviewEnv(), driver(), NOW, JOB_ID, { result_summary: "done, see PR 26", result_ref: OLDER_PR });
    expect(result.ok, "an approval of a different pull request passed the gate").toBe(false);
    expect(String(result.refusal)).toMatch(/bound to/);
    const row = await jobRow();
    expect(row?.status).toBe("claimed");
    expect(row?.result_ref, "the first read did not record the job's pull request").toBe(PR);
  });

  it("PLANT: an APPROVE that quotes no head sha does not pass", async () => {
    await claimedJob();
    withComments(["REVIEW: reads fine. APPROVE"]);
    const result = await finish();
    expect(result.ok, "an APPROVE that names no commit passed the gate").toBe(false);
    expect(String(result.refusal)).toMatch(/quote/);
    const row = await jobRow();
    expect(row?.status).toBe("claimed");
    expect(row?.corrections_count, "an unpinned approval is not a correction").toBe(0);
  });

  it("PLANT: an APPROVE quoting an older head sha does not pass", async () => {
    await claimedJob();
    withComments(["REVIEW: reviewed at 1111111, reads fine. APPROVE"]);
    const result = await finish();
    expect(result.ok, "an approval of an older head passed the gate").toBe(false);
    expect(String(result.refusal)).toMatch(/needs a fresh review/);
    const row = await jobRow();
    expect(row?.status).toBe("claimed");
    expect(row?.corrections_count, "a stale approval is not a correction").toBe(0);
  });

  it("AN APPROVE QUOTING THE CURRENT HEAD passes, as a 7-character prefix or the full sha", async () => {
    for (const quoted of [HEAD_SHA.slice(0, 7), HEAD_SHA, HEAD_SHA.toUpperCase().slice(0, 12)]) {
      await env.DB.prepare("DELETE FROM jobs").run();
      await env.DB.prepare("DELETE FROM job_outcomes").run();
      for (const key of (await env.APP_KV.list({ prefix: "gh:get:" })).keys) await env.APP_KV.delete(key.name);
      vi.restoreAllMocks();
      await claimedJob();
      withComments([`REVIEW: reviewed at ${quoted}, reads fine. APPROVE`]);
      const result = await finish();
      expect(result.ok, `an approval quoting ${quoted} was refused: ${JSON.stringify(result)}`).toBe(true);
      expect((await jobRow())?.status).toBe("done");
    }
  });

  it("A CHANGES QUOTING AN OLDER HEAD STILL SENDS THE JOB BACK, because only APPROVE needs the sha", async () => {
    await claimedJob();
    withComments(["REVIEW: at 1111111 the error path is wrong. CHANGES"]);
    await finish();
    const row = await jobRow();
    expect(row?.status).toBe("claimed");
    expect(row?.corrections_count, "a CHANGES on an older head was not acted on").toBe(1);
  });

  it("A 6-CHARACTER PREFIX IS NOT A QUOTED SHA", async () => {
    await claimedJob();
    withComments([`REVIEW: reviewed at ${HEAD_SHA.slice(0, 6)}. APPROVE`]);
    const result = await finish();
    expect(result.ok, "a 6-character prefix counted as the head sha").toBe(false);
    expect((await jobRow())?.status).toBe("claimed");
  });

  it("PLANT: a pull request in a repo the namespace does not map is refused, and GitHub is not asked about it", async () => {
    await claimedJob({ result_ref: null });
    const asked = withComments([`REVIEW: fine at ${SHORT}. APPROVE`]);
    const result = await completeJob(reviewEnv(), driver(), NOW, JOB_ID, {
      result_summary: "opened PR 5",
      result_ref: "https://github.com/someone-else/other-repo/pull/5",
    });
    expect(result.ok, "a pull request outside the namespace mapping passed the gate").toBe(false);
    expect(String(result.refusal)).toMatch(/is not mapped to namespace capsid/);
    const row = await jobRow();
    expect(row?.status).toBe("claimed");
    expect(row?.result_ref, "an unmapped pull request must not become the job's bound one").toBeNull();
    expect(asked.filter((u) => u.includes("someone-else"))).toEqual([]);
  });

  it("THE NORMAL CASE: the job's own pull request, approved at its current head, proceeds and stays bound", async () => {
    await claimedJob({ result_ref: null });
    github({ "27": [`REVIEW: the scope check is right at ${SHORT}. APPROVE`] });
    const result = await finish();
    expect(result.ok, `an approved job was refused: ${JSON.stringify(result)}`).toBe(true);
    const row = await jobRow();
    expect(row?.status).toBe("done");
    expect(row?.result_ref).toBe(PR);
  });

  it("AN UNREADABLE GITHUB HOLDS THE JOB rather than waving it through", async () => {
    // An unreadable comment list is not evidence that anyone looked, so it must never
    // read as an approval.
    await claimedJob();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("upstream is down", { status: 503 }));
    const result = await finish();
    expect(result.ok).toBe(false);
    expect(String(result.refusal)).toMatch(/GitHub could not be read/);
    expect(String(result.refusal)).toMatch(/rather than treating an unreadable review as an approval/);
    expect((await jobRow())?.status).toBe("claimed");
  });
});
