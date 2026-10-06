import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockJob, claimJob, completeAsCaller, completeJob, postJob, resumeJob } from "../src/jobs";
import { legacyAgent } from "../src/agents";

// The seat completing a blocked job it does not hold (job_85b8ac3e0c7e), the way it can
// already fail one. The job stays held by the driver that did the work, so the outcome
// row credits that driver, where resume with take then complete credits the seat. Real
// D1; GitHub is a fetch stub, as in test-integration/outcome-result-ref.test.ts.

const SECRET = "test-root-secret";
const NS = "sample";
const PR = "https://github.com/example/sample/pull/3";
const SHA = "a".repeat(40);
const DRIVER_ACTOR = "agent:driver-aaaa";
const DRIVER = legacyAgent("write", DRIVER_ACTOR);
// legacyAgent("write") is the admin, so a driver that is not the seat is built from it
// with the admin identity and the merge flag taken away.
function driverOnly(actor: string) {
  const base = legacyAgent("write", actor);
  return { ...base, admin: false, scopes: { ...base.scopes, flags: { ...base.scopes.flags, can_merge: false } } };
}
const OTHER = driverOnly("agent:driver-bbbb");
const HOLDER_B = driverOnly("agent:driver-cccc");
const SEAT_ACTOR = "access:seat@example.com";
const SEAT = legacyAgent("write", SEAT_ACTOR);
const NOW = new Date("2026-10-06T12:00:00.000Z");
const LATER = new Date("2026-10-06T13:00:00.000Z");
const VERIFIED = { prs_opened: true, prs_merged: true, commits: true, files_changed: true, ci_green: true };

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

function stubGitHub(extra?: (url: string) => Response | null) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const special = extra?.(url);
    if (special) return special;
    if (url.includes("/pulls/3")) {
      return Response.json({ merged: true, commits: 2, changed_files: 3, head: { sha: SHA }, node_id: "PR_node_3", created_at: "2026-10-06T10:00:00Z" });
    }
    if (url.includes("/actions/runs")) {
      return Response.json({
        workflow_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success", head_sha: SHA, head_branch: "x", event: "pull_request", html_url: "https://github.com/example/sample/actions/runs/1", created_at: "2026-10-06T10:30:00Z", updated_at: "2026-10-06T10:40:00Z" }],
      });
    }
    return new Response("not stubbed", { status: 404 });
  });
}

async function job(id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<Record<string, unknown>>();
}
async function outcome(id: string) {
  return env.DB.prepare("SELECT * FROM job_outcomes WHERE job_id = ?1").bind(id).first<Record<string, unknown>>();
}
async function outcomeCount() {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM job_outcomes").first<{ n: number }>())?.n ?? 0;
}

// The gate counts a review comment only when an audit row shows Capsid posted it for a
// reviewer (src/review.ts reviewerCommentIds); a human actor counts.
async function postedForReviewer(commentId: number) {
  await env.DB.prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('access:reviewer@example.com', 'manage_pr', ?1, NULL, ?2)")
    .bind(NS, JSON.stringify({ repo: "example/sample", number: 3, action: "comment", comment_id: commentId }))
    .run();
}

async function post(title: string, over: Record<string, unknown> = {}) {
  const posted = await postJob(jobsEnv(), SEAT, NOW, { namespace: NS, title, body: "do the thing", gate_required: true, ...over } as Parameters<typeof postJob>[3]);
  return posted.job!.id;
}

// A job the driver holds and then blocks on a gate, which is the state the seat completes.
async function blocked(title: string, over: Record<string, unknown> = {}) {
  const id = await post(title, over);
  const claim = await claimJob(jobsEnv(), DRIVER, NOW, { id });
  expect(claim.ok, claim.refusal).toBe(true);
  const block = await blockJob(jobsEnv(), DRIVER, NOW, id, { reason: "needs the seat", command: "git push -u origin feat/x" });
  expect(block.ok, block.refusal).toBe(true);
  return id;
}

beforeEach(async () => {
  for (const table of ["job_outcomes", "jobs", "audit_log", "agents", "job_outcome_prs", "job_claims", "job_touches", "job_evaluations"]) {
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

describe("the seat completes a blocked job it does not hold", () => {
  it("REPRODUCED: the outcome stays the driver's, verified through result_ref, and the audit row names the seat", async () => {
    stubGitHub();
    const id = await blocked("seat completes it");
    const done = await completeAsCaller(jobsEnv(), SEAT, LATER, id, { result_summary: "merged by the seat", result_ref: PR });
    expect(done.ok, done.refusal).toBe(true);

    const row = await job(id);
    expect(row?.status).toBe("done");
    expect(row?.claimed_by).toBe(DRIVER_ACTOR);
    expect(row?.lease_expires).toBeNull();

    const out = await outcome(id);
    expect(out?.agent).toBe(DRIVER_ACTOR);
    expect(JSON.parse(String(out?.verified))).toEqual(VERIFIED);
    expect([out?.prs_opened, out?.prs_merged, out?.commits, out?.files_changed, out?.ci_green]).toEqual([1, 1, 2, 3, 1]);
    expect(await outcomeCount()).toBe(1);

    const audit = await env.DB.prepare("SELECT actor, params FROM audit_log WHERE action = 'job-admin-complete' AND json_extract(params, '$.job_id') = ?1").bind(id).first<{ actor: string; params: string }>();
    expect(audit?.actor).toBe(SEAT_ACTOR);
    expect(JSON.parse(String(audit?.params))).toMatchObject({ status: "done", held_by: DRIVER_ACTOR, result_ref: PR });
    // The claim is the seat's account of the call, recorded under the seat, not the driver.
    const claim = await env.DB.prepare("SELECT agent FROM job_claims WHERE job_id = ?1 AND action = 'complete'").bind(id).first<{ agent: string }>();
    expect(claim?.agent).toBe(SEAT_ACTOR);
    const mirror = await env.DB.prepare("SELECT body, status FROM documents WHERE namespace = ?1 AND path = ?2").bind(NS, `jobs/${id}.md`).first<{ body: string; status: string }>();
    expect(mirror?.body).toContain("status: **done**");
    expect(mirror?.status).toBe("closed");
  });

  it("contrast: resume with take, then complete, still credits the taker", async () => {
    stubGitHub();
    const id = await blocked("seat takes it");
    const taken = await resumeJob(jobsEnv(), SEAT, NOW, id, "the seat finishes it", { take: true });
    expect(taken.ok, taken.refusal).toBe(true);
    const done = await completeAsCaller(jobsEnv(), SEAT, LATER, id, { result_summary: "merged", result_ref: PR });
    expect(done.ok, done.refusal).toBe(true);
    expect((await outcome(id))?.agent).toBe(SEAT_ACTOR);
  });

  it("refuses a job nobody worked, a job still held, and a job already finished, each saying what to do instead", async () => {
    stubGitHub();
    const queued = await post("queued");
    const refusedQueued = await completeAsCaller(jobsEnv(), SEAT, LATER, queued, { result_summary: "x", result_ref: PR });
    expect(refusedQueued.ok).toBe(false);
    expect(refusedQueued.refusal).toMatch(/queued/);

    const held = await post("held");
    await claimJob(jobsEnv(), HOLDER_B, NOW, { id: held });
    const refusedHeld = await completeAsCaller(jobsEnv(), SEAT, LATER, held, { result_summary: "x", result_ref: PR });
    expect(refusedHeld.ok).toBe(false);
    expect(refusedHeld.refusal).toMatch(/Its holder completes it, or the seat releases/);
    expect((await job(held))?.status).toBe("claimed");

    const finished = await blocked("finished");
    expect((await completeAsCaller(jobsEnv(), SEAT, LATER, finished, { result_summary: "first", result_ref: PR })).ok).toBe(true);
    const again = await completeAsCaller(jobsEnv(), SEAT, LATER, finished, { result_summary: "second", result_ref: PR });
    expect(again.ok).toBe(false);
    expect(again.refusal).toMatch(/already done/);
    expect(await outcomeCount()).toBe(1);
  });

  it("refuses a driver, and an empty summary, and writes nothing", async () => {
    stubGitHub();
    const id = await blocked("not for a driver");
    const byDriver = await completeAsCaller(jobsEnv(), OTHER, LATER, id, { result_summary: "mine now", result_ref: PR });
    expect(byDriver.ok).toBe(false);
    expect(byDriver.refusal).toMatch(/may only complete a job it holds|is blocked, not claimed/);
    const empty = await completeAsCaller(jobsEnv(), SEAT, LATER, id, { result_summary: "  ", result_ref: PR });
    expect(empty.ok).toBe(false);
    expect(empty.refusal).toMatch(/result_summary/);
    expect((await job(id))?.status).toBe("blocked");
    expect(await outcomeCount()).toBe(0);
  });

  it("refuses a seat key scoped away from the job's namespace", async () => {
    stubGitHub();
    const id = await blocked("out of scope");
    const narrow = { ...SEAT, admin: false, scopes: { ...SEAT.scopes, namespaces: ["other"] }, actor: "agent:seat-narrow", id: "agent:seat-narrow", name: "agent" };
    // A narrow key that still holds the merge flag is the seat for the purpose of the rule,
    // but only inside its own namespaces.
    narrow.scopes = { ...narrow.scopes, flags: { ...narrow.scopes.flags, can_merge: true } };
    const refused = await completeAsCaller(jobsEnv(), narrow, LATER, id, { result_summary: "x", result_ref: PR });
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/cannot complete .* outside|not in|scope|namespace/i);
    expect((await job(id))?.status).toBe("blocked");
  });

  it("a review_required job is not completed around its review: no APPROVE, no completion, and nothing is written", async () => {
    stubGitHub((url) => (url.includes("/pulls/3/") || url.includes("/issues/3/comments") ? Response.json([]) : null));
    const id = await blocked("needs a review", { review_required: true });
    const refused = await completeAsCaller(jobsEnv(), SEAT, LATER, id, { result_summary: "x", result_ref: PR });
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/review/i);
    expect((await job(id))?.status).toBe("blocked");
    expect(await outcomeCount()).toBe(0);
  });

  it("a reviewer's CHANGES is answered, not escaped: the seat's close is refused and writes nothing", async () => {
    const comments = [{ id: 1, user: { login: "reviewer" }, body: "REVIEW: the scope check is wrong. CHANGES", created_at: "2026-10-06T11:00:00Z" }];
    stubGitHub((url) => (url.includes("/issues/3/comments") ? Response.json(comments) : null));
    await postedForReviewer(1);
    const id = await blocked("changes requested", { review_required: true });
    const before = await job(id);
    const refused = await completeAsCaller(jobsEnv(), SEAT, LATER, id, { result_summary: "x", result_ref: PR });
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/cannot be completed around its review: review by reviewer: CHANGES/);
    const after = await job(id);
    expect(after?.status).toBe("blocked");
    expect(after?.corrections_count).toBe(before?.corrections_count);
    expect(after?.updated_at).toBe(before?.updated_at);
    expect(await outcomeCount()).toBe(0);
  });

  it("an APPROVE on the pull request's head lets the seat complete, and the driver is still credited", async () => {
    const comments = [{ id: 2, user: { login: "reviewer" }, body: `REVIEW: right at ${SHA.slice(0, 7)}. APPROVE`, created_at: "2026-10-06T11:00:00Z" }];
    stubGitHub((url) => (url.includes("/issues/3/comments") ? Response.json(comments) : null));
    await postedForReviewer(2);
    const id = await blocked("approved", { review_required: true });
    const done = await completeAsCaller(jobsEnv(), SEAT, LATER, id, { result_summary: "merged", result_ref: PR });
    expect(done.ok, done.refusal).toBe(true);
    expect((await outcome(id))?.agent).toBe(DRIVER_ACTOR);
    expect((await job(id))?.claimed_by).toBe(DRIVER_ACTOR);
  });

  it("the holder completing its own claimed job is unchanged", async () => {
    stubGitHub();
    const id = await post("holder completes");
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    const done = await completeJob(jobsEnv(), DRIVER, LATER, id, { result_summary: "landed", result_ref: PR });
    expect(done.ok, done.refusal).toBe(true);
    expect((await outcome(id))?.agent).toBe(DRIVER_ACTOR);
  });
});
