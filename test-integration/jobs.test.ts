import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { adminFailJob, blockJob, claimJob, completeJob, expireJobLeases, failJob, heartbeatJob, jobsSummary, listJobs, postJob, resumeJob, supersedeJob } from "../src/jobs";
import { improveStatus } from "../src/improve-run";
import { legacyAgent, type Agent } from "../src/agents";
import { defaultScopes } from "../src/agents-schema";
import { loadRecordRows } from "../src/agent-record";
import { CORRECTION_CAP, JOB_LEASE_SECONDS, RETRY_CAP_REASON, jobDocPath } from "../src/jobs-schema";
import { splitSignedTask, verifyTaskDoc } from "../src/improve-task";
import { MAX_TITLE } from "../src/limits";

// THE WORK QUEUE, AGAINST A REAL D1.
//
// This suite lives in the integration layer rather than beside the unit tests, and
// that is the whole point of it: every property under test is a property of the
// DATABASE, not of a handler.
//
//   - the partial unique index over (namespace, title) is what refuses a duplicate
//     post, and only SQLite enforces it;
//   - the claim is `UPDATE ... WHERE status = 'queued' RETURNING id`, so "exactly
//     one of two callers wins" is a statement about SQLite's transaction, not about
//     the code around it;
//   - the lease sweep is a keyed UPDATE with RETURNING over a real datetime
//     comparison.
//
// A fake that answered these by SQL shape would agree with whatever it was asked,
// which is the failure mode test/fakes.ts's own header records.

const SECRET = "test-root-secret";
const SEAT = "github:DrDustinEdwards";
const DRIVER_ACTOR = "opkey:aaaabbbbcccc";
const OTHER_ACTOR = "opkey:ddddeeeeffff";
// A claim is authorized against a CALLER now, not an actor string (migrations/0008).
// These two are the legacy operator identity, which is what every existing claim in
// the portfolio still presents and what these tests are about: the lease, the CAS and
// the unique index are properties of SQLite and do not change with the caller.
const DRIVER = legacyAgent("write", DRIVER_ACTOR);
const OTHER = legacyAgent("write", OTHER_ACTOR);

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

const at = (iso: string) => new Date(iso);
const NOW = at("2026-09-10T12:00:00.000Z");

async function row(id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<Record<string, unknown>>();
}

async function auditActions(id: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT action FROM audit_log WHERE params LIKE ?1 ORDER BY id ASC"
  )
    .bind(`%${id}%`)
    .all<{ action: string }>();
  return (results ?? []).map((r) => r.action);
}

// AN ENV WHOSE FIRST BATCH RUNS `between` FIRST, against the real D1. Every job
// transition now reads the row and then commits one guarded batch, so this puts a
// competing write exactly in the gap the guard exists for.
function racingEnv(between: () => Promise<void>) {
  let armed = true;
  return {
    ...jobsEnv(),
    DB: {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        if (armed) {
          armed = false;
          await between();
        }
        return env.DB.batch(statements);
      },
    },
  } as unknown as Parameters<typeof postJob>[0];
}

async function post(over: Partial<{ namespace: string; title: string; body: string; priority: number; gate_required: boolean }> = {}) {
  return postJob(jobsEnv(), legacyAgent("write", SEAT), NOW, {
    namespace: "capsid",
    title: "a job",
    body: "do the thing",
    ...over,
  });
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("DELETE FROM audit_log").run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
  // jobs post requires a registered namespace (audit 2026-09-25, F2-8).
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)").bind("capsid", JSON.stringify([{ repo: "example/capsid", label: "primary" }])).run();
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)").bind("germomics", JSON.stringify([{ repo: "example/germomics", label: "primary" }])).run();
});

describe("the lifecycle", () => {
  it("post, claim, complete, and the row carries what each step recorded", async () => {
    const posted = await post({ title: "post claim complete" });
    expect(posted.ok, posted.refusal).toBe(true);
    const id = posted.job!.id;
    expect(id).toMatch(/^job_[0-9a-f]{12}$/);
    expect(posted.job!.status).toBe("queued");
    expect(posted.job!.posted_by).toBe(SEAT);

    const claimed = await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    expect(claimed.ok, claimed.refusal).toBe(true);
    expect(claimed.job!.id).toBe(id);
    expect(claimed.job!.claimed_by).toBe(DRIVER_ACTOR);
    // The lease is four hours out, from the clock the caller passed rather than the
    // runner's, so this is an assertion about the value and not about timing.
    expect(claimed.job!.lease_expires).toBe(new Date(NOW.getTime() + JOB_LEASE_SECONDS * 1000).toISOString());

    const done = await completeJob(jobsEnv(), DRIVER, NOW, id, {
      result_summary: "did the thing",
      result_ref: "capsid/notes.md",
    });
    expect(done.ok, done.refusal).toBe(true);
    const stored = await row(id);
    expect(stored?.status).toBe("done");
    expect(stored?.result_summary).toBe("did the thing");
    expect(stored?.result_ref).toBe("capsid/notes.md");
    // The lease is given back, so a done job holds nothing.
    expect(stored?.lease_expires).toBeNull();
  });

  it("every action writes an audit row naming the caller", async () => {
    const posted = await post({ title: "audited" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    await heartbeatJob(jobsEnv(), DRIVER, NOW, id);
    await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "s" });

    // Both the queue's own audit row and the mirrored document's write land, which
    // is what makes the snapshot rule hold for a job document as for any other.
    const actions = await auditActions(id);
    expect(actions).toContain("job-posted");
    expect(actions).toContain("job-claimed");
    expect(actions).toContain("job-heartbeat");
    expect(actions).toContain("job-complete");

    const actors = await env.DB.prepare("SELECT DISTINCT actor FROM audit_log WHERE params LIKE ?1")
      .bind(`%${id}%`)
      .all<{ actor: string }>();
    expect(new Set((actors.results ?? []).map((r) => r.actor))).toEqual(new Set([SEAT, DRIVER_ACTOR]));
  });

  // The innocent direction of two refusals in test/jobs.test.ts: the swallowed-tag
  // guard and the skills check. A guard that refuses ordinary work gets deleted rather
  // than fixed, so each is driven here to a completed row.
  it("a clean summary that mentions tags and parameter names completes: the tag guard is not a wall", async () => {
    const id = (await post({ title: "tag guard innocent" })).job!.id;
    expect((await claimJob(jobsEnv(), DRIVER, NOW, { id })).ok).toBe(true);
    const summary = "landed it; evidence is in the PR and the result_ref is a document key";
    const done = await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: summary });
    expect(done.ok, done.refusal).toBe(true);
    const stored = await row(id);
    expect(stored?.status).toBe("done");
    expect(stored?.result_summary).toBe(summary);
  });

  it("naming no skills at all completes: most jobs have no recommend step", async () => {
    const id = (await post({ title: "no skills named" })).job!.id;
    expect((await claimJob(jobsEnv(), DRIVER, NOW, { id })).ok).toBe(true);
    const done = await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "done" });
    expect(done.ok, done.refusal).toBe(true);
    expect((await row(id))?.status).toBe("done");
  });
});

describe("the refusals", () => {
  it("a second open job with the same title is refused by the partial index", async () => {
    const first = await post({ title: "only once" });
    expect(first.ok).toBe(true);
    const second = await post({ title: "only once" });
    expect(second.ok).toBe(false);
    expect(second.refusal).toMatch(/already has an open job titled 'only once'/);

    // And the index is PARTIAL, so the same title is postable again once the first
    // one is out of the open statuses. A plain unique index would make a recurring
    // job impossible, which is the thing the partial clause buys.
    await claimJob(jobsEnv(), DRIVER, NOW, { id: first.job!.id });
    await failJob(jobsEnv(), DRIVER, NOW, first.job!.id, "gave up");
    const third = await post({ title: "only once" });
    expect(third.ok, third.refusal).toBe(true);
  });

  it("A BLOCKED JOB IS OPEN, so the same title cannot be posted over it", async () => {
    // Measured 2026-09-18: the watcher re-posted an identical finding 12 minutes
    // after the first copy was blocked for the seat, because the index counted only
    // queued and claimed. A blocked job is the most open a job can be, since somebody
    // is waiting on it, and a second copy costs a driver run to close and tells the
    // human the same thing twice.
    const first = await post({ title: "waiting on the seat" });
    await claimJob(jobsEnv(), DRIVER, NOW, { id: first.job!.id });
    const blocked = await blockJob(jobsEnv(), DRIVER, NOW, first.job!.id, {
      reason: "needs a merge",
      command: "gh pr merge 1 --squash",
    });
    expect(blocked.ok, blocked.refusal).toBe(true);
    expect((await row(first.job!.id))?.status).toBe("blocked");

    const second = await post({ title: "waiting on the seat" });
    expect(second.ok).toBe(false);
    // THE REFUSAL NAMES THE ROW. "there is already one" sends the reader to the
    // console to find out which one and whether anyone is waiting on it.
    expect(second.refusal).toMatch(new RegExp(`${first.job!.id} is blocked`));
    expect(second.refusal).toMatch(/queued, claimed or blocked/);
  });

  it("a failed or done job does not hold the title, so a recurring job still recurs", async () => {
    // The other direction of the same rule, kept explicit: widening the index to
    // blocked must not quietly make every title permanent.
    for (const finish of ["fail", "complete"] as const) {
      const posted = await post({ title: `recurs by ${finish}` });
      await claimJob(jobsEnv(), DRIVER, NOW, { id: posted.job!.id });
      if (finish === "fail") await failJob(jobsEnv(), DRIVER, NOW, posted.job!.id, "gave up");
      else await completeJob(jobsEnv(), DRIVER, NOW, posted.job!.id, { result_summary: "done" });
      const again = await post({ title: `recurs by ${finish}` });
      expect(again.ok, `${finish}: ${again.refusal}`).toBe(true);
    }
  });

  it("a caller that already holds a claim cannot take another", async () => {
    const a = await post({ title: "first" });
    const b = await post({ title: "second" });
    expect((await claimJob(jobsEnv(), DRIVER, NOW, { id: a.job!.id })).ok).toBe(true);
    const again = await claimJob(jobsEnv(), DRIVER, NOW, { id: b.job!.id });
    expect(again.ok).toBe(false);
    expect(again.refusal).toMatch(new RegExp(`already holds ${a.job!.id}`));
    // And the second job is untouched, not half-claimed.
    expect((await row(b.job!.id))?.status).toBe("queued");
  });

  it("an agent, an OAuth session and an operator key can each hold a lease", async () => {
    // claimed_by has the shape of audit_log.actor, so one query joins a job to what its
    // driver did. Each of the three caller kinds claims its own job.
    for (const [title, actor] of [
      ["held by an agent", "agent:capsid-driver"],
      ["held by a session", "github:someone"],
      ["held by a key", "opkey:0123456789ab"],
    ] as const) {
      const posted = await post({ title });
      const claimed = await claimJob(jobsEnv(), legacyAgent("write", actor), NOW, { id: posted.job!.id });
      expect(claimed.ok, `${actor}: ${claimed.refusal}`).toBe(true);
      expect(claimed.job!.claimed_by).toBe(actor);
    }
  });

  it("two drivers racing one job resolve to exactly one winner", async () => {
    const posted = await post({ title: "contested" });
    const id = posted.job!.id;
    const [one, two] = await Promise.all([
      claimJob(jobsEnv(), DRIVER, NOW, { id }),
      claimJob(jobsEnv(), OTHER, NOW, { id }),
    ]);
    const winners = [one, two].filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const stored = await row(id);
    expect(stored?.status).toBe("claimed");
    expect(stored?.claimed_by).toBe(winners[0].job!.claimed_by);
  });

  it("a holder is the only caller that can finish the job", async () => {
    const posted = await post({ title: "held" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    const stolen = await completeJob(jobsEnv(), OTHER, NOW, id, { result_summary: "not mine" });
    expect(stolen.ok).toBe(false);
    expect(stolen.refusal).toMatch(new RegExp(`held by ${DRIVER_ACTOR}, not by ${OTHER_ACTOR}`));
    expect((await row(id))?.status).toBe("claimed");
  });

  it("complete without a summary and fail without a reason are refused", async () => {
    const posted = await post({ title: "needs words" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    expect((await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "  " })).refusal).toMatch(/needs a result_summary/);
    expect((await failJob(jobsEnv(), DRIVER, NOW, id, "")).refusal).toMatch(/needs a reason/);
    expect((await row(id))?.status).toBe("claimed");
  });

  it("post refuses when there is no key to sign with", async () => {
    const unconfigured = { ...env, IMPROVE_SCORE_SECRET: undefined } as unknown as Parameters<typeof postJob>[0];
    const result = await postJob(unconfigured, legacyAgent("write", SEAT), NOW, { namespace: "capsid", title: "unsignable", body: "x" });
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/IMPROVE_SCORE_SECRET is unset/);
    // Fail closed: nothing queued.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>())?.n).toBe(0);
  });
});

describe("the lease", () => {
  it("an expired lease returns the job to queued, and a live one does not", async () => {
    const live = await post({ title: "still working" });
    const dead = await post({ title: "driver died" });
    await claimJob(jobsEnv(), DRIVER, NOW, { id: dead.job!.id });
    await claimJob(jobsEnv(), OTHER, NOW, { id: live.job!.id });

    // One second before the lease is up: nothing moves. This is the innocent case,
    // and a sweep that fires on it would return a job somebody is still doing.
    const justBefore = new Date(NOW.getTime() + JOB_LEASE_SECONDS * 1000 - 1000);
    expect((await expireJobLeases(jobsEnv(), justBefore)).requeued).toEqual([]);
    expect((await row(dead.job!.id))?.status).toBe("claimed");

    // The live one heartbeats and the dead one does not, so an hour later only one
    // of them is expired. This is what the heartbeat is FOR, asserted rather than
    // assumed.
    const later = new Date(NOW.getTime() + JOB_LEASE_SECONDS * 1000 + 1000);
    await heartbeatJob(jobsEnv(), OTHER, new Date(NOW.getTime() + 60_000), live.job!.id);
    const swept = await expireJobLeases(jobsEnv(), later);
    expect(swept.requeued).toEqual([dead.job!.id]);

    const returned = await row(dead.job!.id);
    expect(returned?.status).toBe("queued");
    expect(returned?.claimed_by).toBeNull();
    expect(returned?.lease_expires).toBeNull();
    expect((await row(live.job!.id))?.status).toBe("claimed");

    // And it is claimable again, by anyone.
    const reclaimed = await claimJob(jobsEnv(), legacyAgent("write", SEAT.replace("github:", "opkey:")), later, { id: dead.job!.id });
    expect(reclaimed.ok, reclaimed.refusal).toBe(true);
  });

  it("a caller cannot finish a job whose lease the sweep already returned", async () => {
    const posted = await post({ title: "too slow" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    const later = new Date(NOW.getTime() + JOB_LEASE_SECONDS * 1000 + 1000);
    await expireJobLeases(jobsEnv(), later);
    const late = await completeJob(jobsEnv(), DRIVER, later, id, { result_summary: "finished eventually" });
    expect(late.ok).toBe(false);
    expect(late.refusal).toMatch(/is queued, not claimed/);
    expect(late.refusal).toMatch(/claim it again/);
  });
});

describe("blocked", () => {
  it("block records the exact command, and the job stops there", async () => {
    const posted = await post({ title: "needs a push", gate_required: true });
    const id = posted.job!.id;
    expect(posted.job!.gate_required).toBe(1);
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    const blocked = await blockJob(jobsEnv(), DRIVER, NOW, id, {
      reason: "the change is ready but pushing deploys the Worker",
      command: "git push origin feat/thing",
    });
    expect(blocked.ok, blocked.refusal).toBe(true);
    const stored = await row(id);
    expect(stored?.status).toBe("blocked");
    // The command is what the human needs, so it is IN the summary rather than
    // described by it. The console shows this string.
    expect(String(stored?.result_summary)).toContain("git push origin feat/thing");
    expect(String(stored?.result_summary)).toContain("deploys the Worker");
  });
});

// BLOCKED IS A PAUSE, NOT AN ENDING (2026-09-10). Before resume existed, the only
// door into a claim was from queued, so a job stopped at a gate could never carry
// its own outcome: job_1b957927a714 shipped a commit and four pull requests while
// its row still said the push had not happened.
describe("resume", () => {
  async function blockedJob(title: string) {
    const posted = await post({ title, gate_required: true });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    await blockJob(jobsEnv(), DRIVER, NOW, id, { reason: "needs a human", command: "git push origin main" });
    return id;
  }

  it("block, resume, complete: the same job carries its own outcome", async () => {
    const id = await blockedJob("block resume complete");
    expect((await row(id))?.status).toBe("blocked");

    const resumed = await resumeJob(jobsEnv(), DRIVER, NOW, id, "seat approved the push");
    expect(resumed.ok, resumed.refusal).toBe(true);
    const held = await row(id);
    expect(held?.status).toBe("claimed");
    expect(held?.claimed_by).toBe(DRIVER_ACTOR);
    // A FRESH LEASE, not the expired one it was blocked with.
    expect(held?.lease_expires).toBe(new Date(NOW.getTime() + JOB_LEASE_SECONDS * 1000).toISOString());
    expect(held?.resumed_count).toBe(1);
    expect(held?.blocked_count).toBe(1);

    const done = await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "pushed and verified", result_ref: "abc1234" });
    expect(done.ok, done.refusal).toBe(true);
    const final = await row(id);
    expect(final?.status).toBe("done");
    expect(final?.result_summary).toBe("pushed and verified");
    expect(await auditActions(id)).toEqual(["job-posted", "job-claimed", "job-block", "job-resumed", "job-complete"]);
  });

  it("the approval reason is recorded, not implied", async () => {
    const id = await blockedJob("approval recorded");
    await resumeJob(jobsEnv(), DRIVER, NOW, id, "seat approved: ff-merge and push master");
    const { results } = await env.DB.prepare(
      "SELECT params FROM audit_log WHERE action = 'job-resumed' AND params LIKE ?1"
    )
      .bind(`%${id}%`)
      .all<{ params: string }>();
    expect(results?.length).toBe(1);
    expect(String(results?.[0].params)).toContain("ff-merge and push master");
  });

  it("resume needs a reason, because a gate nobody signed for did not happen", async () => {
    const id = await blockedJob("no reason");
    const refused = await resumeJob(jobsEnv(), DRIVER, NOW, id, "   ");
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/needs a reason/);
    expect((await row(id))?.status).toBe("blocked");
  });

  it("a job can hit a gate, come back, and hit another, counting each", async () => {
    const id = await blockedJob("two gates");
    await resumeJob(jobsEnv(), DRIVER, NOW, id, "first approval");
    await blockJob(jobsEnv(), DRIVER, NOW, id, { reason: "a second gate", command: "npx wrangler deploy" });
    let stored = await row(id);
    expect(stored?.status).toBe("blocked");
    expect(stored?.blocked_count).toBe(2);
    expect(stored?.resumed_count).toBe(1);

    await resumeJob(jobsEnv(), DRIVER, NOW, id, "second approval");
    stored = await row(id);
    expect(stored?.blocked_count).toBe(2);
    expect(stored?.resumed_count).toBe(2);

    const summary = await jobsSummary(env.DB, "capsid", NOW);
    await blockJob(jobsEnv(), DRIVER, NOW, id, { reason: "a third", command: "echo hi" });
    const after = await jobsSummary(env.DB, "capsid", NOW);
    expect(summary.blocked_jobs.length).toBe(0); // it was claimed at that moment
    const listed = after.blocked_jobs.find((j) => j.id === id);
    expect(listed?.blocked_times).toBe(3);
    expect(listed?.resumed).toBe(2);
  });

  it("a different caller may resume, and the job goes back to the driver that blocked it", async () => {
    // Ruled 2026-09-16, after the seat's resume of job_4918f3519cba left the job held
    // by the seat.
    const id = await blockedJob("other caller");
    const resumed = await resumeJob(jobsEnv(), OTHER, NOW, id, "seat approved");
    expect(resumed.ok, resumed.refusal).toBe(true);
    expect((await row(id))?.claimed_by).toBe(DRIVER_ACTOR);
  });

  it("a different caller that passes take holds the job itself", async () => {
    const id = await blockedJob("taken");
    const resumed = await resumeJob(jobsEnv(), OTHER, NOW, id, "I will finish it", { take: true });
    expect(resumed.ok, resumed.refusal).toBe(true);
    expect((await row(id))?.claimed_by).toBe(OTHER_ACTOR);
  });

  it("resume keeps the first claim's timestamp", async () => {
    const id = await blockedJob("first claim");
    const claimedAt = (await row(id))?.claimed_at;
    await resumeJob(jobsEnv(), OTHER, at("2026-09-11T09:00:00.000Z"), id, "approved");
    expect((await row(id))?.claimed_at).toBe(claimedAt);
  });

  it("resume refuses a queued job and a done job", async () => {
    const queued = await post({ title: "still queued" });
    const onQueued = await resumeJob(jobsEnv(), DRIVER, NOW, queued.job!.id, "approved");
    expect(onQueued.ok).toBe(false);
    expect(onQueued.refusal).toMatch(/is queued, not blocked/);

    const id = await blockedJob("already done");
    await resumeJob(jobsEnv(), DRIVER, NOW, id, "approved");
    await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "finished" });
    const onDone = await resumeJob(jobsEnv(), DRIVER, NOW, id, "approved again");
    expect(onDone.ok).toBe(false);
    expect(onDone.refusal).toMatch(/is done, not blocked/);
  });

  it("PLANT: a job that leaves blocked while resume is deciding is not taken back", async () => {
    // resume reads the row, checks it, then moves it in one guarded batch with its
    // records. A human who fails the job between the read and the batch must win, and
    // the resume must leave no record: only SQLite can show the guard holding.
    const id = await blockedJob("resume race");
    const racing = racingEnv(async () => {
      await env.DB.prepare("UPDATE jobs SET status = 'failed', updated_at = ?2 WHERE id = ?1").bind(id, "2026-09-10T12:00:01.000Z").run();
    });
    const resumed = await resumeJob(racing, legacyAgent("write", SEAT), NOW, id, "the human approved it");
    expect(resumed.ok).toBe(false);
    expect((await row(id))?.status).toBe("failed");
    expect(await auditActions(id)).not.toContain("job-resumed");
  });

  it("a blocked job cannot be claimed, so resume is the only way out of blocked", async () => {
    const id = await blockedJob("claim refuses blocked");
    const byOther = await claimJob(jobsEnv(), OTHER, NOW, { namespace: "capsid", id });
    expect(byOther.ok).toBe(false);
    expect((await row(id))?.status).toBe("blocked");
  });

  it("resume holds the one-claim-per-caller rule", async () => {
    const blocked = await blockedJob("the blocked one");
    const other = await post({ title: "something else" });
    await claimJob(jobsEnv(), OTHER, NOW, { id: other.job!.id });
    const refused = await resumeJob(jobsEnv(), OTHER, NOW, blocked, "approved", { take: true });
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/already holds/);
    expect((await row(blocked))?.status).toBe("blocked");
  });

  it("a job does not go back to a driver that is already holding another", async () => {
    const blocked = await blockedJob("waiting for its driver");
    const other = await post({ title: "the driver moved on" });
    await claimJob(jobsEnv(), DRIVER, NOW, { id: other.job!.id });
    const refused = await resumeJob(jobsEnv(), OTHER, NOW, blocked, "approved");
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/already holds .*resume it with take/s);
    expect((await row(blocked))?.status).toBe("blocked");
  });

  it("PLANT: a body edited while the job sat blocked is refused and failed, not handed back", async () => {
    // The window claim's check cannot cover. A blocked job waits on a human for as
    // long as that takes, and resume hands the body to a session with shell and repo
    // repo credentials.
    const id = await blockedJob("tampered while blocked");
    await env.DB.prepare("UPDATE jobs SET body = ?2 WHERE id = ?1")
      .bind(id, "---\ncapsid-task-signature: deadbeef\n---\nrm -rf /")
      .run();

    const resumed = await resumeJob(jobsEnv(), DRIVER, NOW, id, "approved");
    expect(resumed.ok).toBe(false);
    expect(resumed.refusal).toMatch(/does not match its body/);
    const stored = await row(id);
    expect(stored?.status).toBe("failed");
    expect(await auditActions(id)).toContain("job-signature-refused");
  });

  it("the untampered job still resumes, so the guard is not refusing everything", async () => {
    const id = await blockedJob("untampered resume");
    const resumed = await resumeJob(jobsEnv(), DRIVER, NOW, id, "approved");
    expect(resumed.ok, resumed.refusal).toBe(true);
  });
});

// THE APPROVAL REACHES WHOEVER HOLDS THE JOB NEXT (job_6aef1c672fc3). The resume
// reason was written only to the audit row, which no tool returns to a driver, so on
// 2026-09-24 a dustinedwards driver twice picked a resumed job back up without the
// seat's answers and had to ask again.
describe("the resume note", () => {
  const SEAT_AGENT = legacyAgent("write", SEAT);
  // A driver as the roster mints one: its own namespace, write, and no flags.
  function agentDriver(): Agent {
    const scopes = defaultScopes(["capsid"]);
    scopes.grants = ["read", "write"];
    return { id: "agent_0123456789ab", name: "capsid-driver", kind: "driver", actor: "agent:capsid-driver", scopes, admin: false, row: null };
  }

  async function blockedJob(title: string) {
    const posted = await post({ title, gate_required: true });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    await blockJob(jobsEnv(), DRIVER, NOW, id, { reason: "two questions for the seat", command: "git push origin feat/x" });
    return id;
  }

  it("the seat resumes, the lease lapses, and a driver's claim carries the seat's note", async () => {
    const id = await blockedJob("note reaches the next claim");
    const resumed = await resumeJob(jobsEnv(), SEAT_AGENT, NOW, id, "answers: use option B; batches 1 and 2 approved");
    expect(resumed.ok, resumed.refusal).toBe(true);
    expect(resumed.resume_note?.reason).toBe("answers: use option B; batches 1 and 2 approved");
    expect(resumed.resume_note?.by).toBe(SEAT);

    const later = new Date(NOW.getTime() + JOB_LEASE_SECONDS * 1000 + 1000);
    expect((await expireJobLeases(jobsEnv(), later)).requeued).toEqual([id]);

    const claimed = await claimJob(jobsEnv(), agentDriver(), later, { namespace: "capsid", id });
    expect(claimed.ok, claimed.refusal).toBe(true);
    expect(claimed.resume_note?.reason).toBe("answers: use option B; batches 1 and 2 approved");
    expect(claimed.resume_note?.by).toBe(SEAT);
  });

  it("the driver the job went back to reads the note from its heartbeat and from list", async () => {
    const id = await blockedJob("note reaches the holder");
    await resumeJob(jobsEnv(), SEAT_AGENT, NOW, id, "ruling: keep the old route");
    const beat = await heartbeatJob(jobsEnv(), DRIVER, NOW, id);
    expect(beat.ok, beat.refusal).toBe(true);
    expect(beat.resume_note?.reason).toBe("ruling: keep the old route");

    const listed = await listJobs(jobsEnv(), { namespace: "capsid", id });
    expect(listed.resume_note?.reason).toBe("ruling: keep the old route");
  });

  it("the mirrored document carries it, so brief does", async () => {
    const id = await blockedJob("note in the mirror");
    await resumeJob(jobsEnv(), SEAT_AGENT, NOW, id, "approved the migration");
    const doc = await env.DB.prepare("SELECT body FROM documents WHERE namespace = 'capsid' AND path = ?1")
      .bind(jobDocPath(id))
      .first<{ body: string }>();
    expect(doc?.body).toContain(`last resume, by ${SEAT}`);
    expect(doc?.body).toContain("approved the migration");

    // And a later transition, which reads the note back rather than being handed it,
    // keeps the line.
    await heartbeatJob(jobsEnv(), DRIVER, NOW, id);
    const after = await env.DB.prepare("SELECT body FROM documents WHERE namespace = 'capsid' AND path = ?1")
      .bind(jobDocPath(id))
      .first<{ body: string }>();
    expect(after?.body).toContain("approved the migration");
  });

  // THE SEAT'S FULL NOTE (requested by the seat, 2026-09-25). reason is bounded at
  // MAX_TITLE and holds one line; an approval carrying rulings or a plan went nowhere,
  // and the driver received "gave the six rulings" without the rulings.
  const LONG_NOTE = [
    "Approved the whole report. The six rulings, in order:",
    ...Array.from({ length: 6 }, (_, i) =>
      `${i + 1}. Ruling ${i + 1}: keep the existing route for item ${i + 1}, add a behavior test that fails without the change, and open one pull request per item so each can be reviewed and merged on its own schedule.`
    ),
    "",
    "Plan: work the items in the order above. Stop at the first gate and block with the exact command. Do not merge anything; the seat merges.",
    "Last paragraph, the one a truncation would lose: the sixth ruling outranks the report where they disagree.",
  ].join("\n");

  it("a note longer than a reason reaches resume, claim, heartbeat, list and the mirror in full", async () => {
    expect(LONG_NOTE.length).toBeGreaterThan(MAX_TITLE);
    const id = await blockedJob("full note reaches everyone");
    const resumed = await resumeJob(jobsEnv(), SEAT_AGENT, NOW, id, "approved the report and gave the six rulings", {
      note: LONG_NOTE,
    });
    expect(resumed.ok, resumed.refusal).toBe(true);
    expect(resumed.resume_note?.reason).toBe("approved the report and gave the six rulings");
    expect(resumed.resume_note?.note).toBe(LONG_NOTE);

    const beat = await heartbeatJob(jobsEnv(), DRIVER, NOW, id);
    expect(beat.ok, beat.refusal).toBe(true);
    expect(beat.resume_note?.note).toBe(LONG_NOTE);

    expect((await listJobs(jobsEnv(), { namespace: "capsid", id })).resume_note?.note).toBe(LONG_NOTE);

    const doc = await env.DB.prepare("SELECT body FROM documents WHERE namespace = 'capsid' AND path = ?1")
      .bind(jobDocPath(id))
      .first<{ body: string }>();
    expect(doc?.body).toContain(LONG_NOTE);

    const later = new Date(NOW.getTime() + JOB_LEASE_SECONDS * 1000 + 1000);
    expect((await expireJobLeases(jobsEnv(), later)).requeued).toEqual([id]);
    const claimed = await claimJob(jobsEnv(), agentDriver(), later, { namespace: "capsid", id });
    expect(claimed.ok, claimed.refusal).toBe(true);
    expect(claimed.resume_note?.note).toBe(LONG_NOTE);

    // The mirror rewritten by the claim reads the note back from the audit row.
    const after = await env.DB.prepare("SELECT body FROM documents WHERE namespace = 'capsid' AND path = ?1")
      .bind(jobDocPath(id))
      .first<{ body: string }>();
    expect(after?.body).toContain(LONG_NOTE);
  });

  it("a resume without a note carries no note", async () => {
    const id = await blockedJob("no note");
    const resumed = await resumeJob(jobsEnv(), SEAT_AGENT, NOW, id, "one line is enough");
    expect(resumed.resume_note?.note).toBeUndefined();
    expect((await heartbeatJob(jobsEnv(), DRIVER, NOW, id)).resume_note?.note).toBeUndefined();
  });

  it("the newest resume wins", async () => {
    const id = await blockedJob("two resumes");
    await resumeJob(jobsEnv(), SEAT_AGENT, NOW, id, "first answer");
    await blockJob(jobsEnv(), DRIVER, NOW, id, { reason: "a second question", command: "git push origin feat/y" });
    await resumeJob(jobsEnv(), SEAT_AGENT, NOW, id, "second answer");
    const beat = await heartbeatJob(jobsEnv(), DRIVER, NOW, id);
    expect(beat.resume_note?.reason).toBe("second answer");
  });

  it("a job never resumed carries no note", async () => {
    const posted = await post({ title: "never resumed" });
    const claimed = await claimJob(jobsEnv(), agentDriver(), NOW, { id: posted.job!.id });
    expect(claimed.ok, claimed.refusal).toBe(true);
    expect(claimed.resume_note).toBeUndefined();
    expect((await listJobs(jobsEnv(), { namespace: "capsid", id: posted.job!.id })).resume_note).toBeUndefined();
  });
});

describe("the mirrored document", () => {
  it("tracks the row through every transition, and carries the signed prompt", async () => {
    const posted = await post({ title: "mirrored", body: "the full prompt" });
    const id = posted.job!.id;
    const path = jobDocPath(id);

    const readDoc = async () =>
      env.DB.prepare("SELECT title, body, status FROM documents WHERE namespace = 'capsid' AND path = ?1")
        .bind(path)
        .first<{ title: string; body: string; status: string }>();

    const atPost = await readDoc();
    expect(atPost, `no mirrored document at capsid/${path}`).toBeTruthy();
    expect(atPost!.title).toBe("Job: mirrored");
    expect(atPost!.body).toContain("status: **queued**");

    // THE PROMPT IN THE DOCUMENT IS THE SIGNED BODY, byte for byte, so a driver that
    // reads the document rather than the row verifies the same bytes. Checked
    // through the real verifier rather than by string comparison.
    const prompt = atPost!.body.slice(atPost!.body.indexOf("## The prompt"));
    const signedPart = prompt.slice(prompt.indexOf("---\n"));
    expect(splitSignedTask(signedPart).body.trim()).toBe("the full prompt");
    const verdict = await verifyTaskDoc(SECRET, signedPart, "improve-loop", "improve-loop");
    expect(verdict.ok, "reason" in verdict ? verdict.reason : "").toBe(true);

    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    expect((await readDoc())!.body).toContain("status: **claimed**");
    expect((await readDoc())!.body).toContain(DRIVER_ACTOR);

    await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "landed" });
    const atDone = await readDoc();
    expect(atDone!.body).toContain("status: **done**");
    expect(atDone!.body).toContain("landed");
    // A done job's document is closed, so brief stops carrying it as open work.
    expect(atDone!.status).toBe("closed");

    // Every rewrite snapshotted the one it replaced. The snapshot rule applies to a job
    // document as to any other: three writes, two snapshots.
    const versions = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM document_versions WHERE namespace = 'capsid' AND path = ?1"
    )
      .bind(path)
      .first<{ n: number }>();
    expect(versions?.n).toBeGreaterThanOrEqual(2);
  });

  it("PLANT: a failed job's document is closed too, because failed is terminal", async () => {
    // THE DEFECT THIS PINS. The mirror's document status was written as
    // `job.status === "done" ? "closed" : "active"`, so a FAILED job, which is as
    // finished as a done one, projected as `active` forever. `fail` did rewrite the
    // mirror; the status it wrote was the wrong one. Three capsid job documents sat
    // at active against failed rows before this was fixed.
    const posted = await post({ title: "failed is terminal" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    await failJob(jobsEnv(), DRIVER, NOW, id, "could not reach the thing");

    const doc = await env.DB.prepare(
      "SELECT body, status FROM documents WHERE namespace = 'capsid' AND path = ?1"
    )
      .bind(jobDocPath(id))
      .first<{ body: string; status: string }>();
    expect(doc!.body).toContain("status: **failed**");
    expect(doc!.status).toBe("closed");
  });

  it("a blocked job's document stays active, because blocked is a pause", async () => {
    // The innocent case, in the same commit as the fix. Closing every status that is
    // not `done` would be the same bug pointed the other way: a blocked job is
    // waiting for a human and is still open work, so brief must keep carrying it.
    const posted = await post({ title: "blocked is not terminal" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    await blockJob(jobsEnv(), DRIVER, NOW, id, { reason: "needs a push", command: "git push origin HEAD" });

    const doc = await env.DB.prepare(
      "SELECT body, status FROM documents WHERE namespace = 'capsid' AND path = ?1"
    )
      .bind(jobDocPath(id))
      .first<{ body: string; status: string }>();
    expect(doc!.body).toContain("status: **blocked**");
    expect(doc!.status).toBe("active");
  });
});

describe("list", () => {
  it("filters by namespace and status, highest priority first", async () => {
    await post({ title: "low", priority: 0 });
    await post({ title: "high", priority: 10 });
    await post({ title: "elsewhere", namespace: "germomics" });

    const capsid = await listJobs(jobsEnv(), { namespace: "capsid" });
    expect(capsid.jobs!.map((j) => j.title)).toEqual(["high", "low"]);

    const everything = await listJobs(jobsEnv(), {});
    expect(everything.jobs!).toHaveLength(3);

    const claimed = await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    expect(claimed.job!.title).toBe("high");
    const stillQueued = await listJobs(jobsEnv(), { namespace: "capsid", status: "queued" });
    expect(stillQueued.jobs!.map((j) => j.title)).toEqual(["low"]);
  });

  it("carries no body, unless one job is named and the body was asked for", async () => {
    // AUDIT-2026-09-16.md. The column list is SQL a fake cannot check; this can.
    const posted = await post({ title: "has a body" });
    const id = posted.job!.id;

    const listed = await listJobs(jobsEnv(), { namespace: "capsid" });
    expect(listed.jobs!.length).toBeGreaterThan(0);
    for (const job of listed.jobs!) expect(job).not.toHaveProperty("body");

    // withBody without an id is ignored: a whole-namespace list never carries bodies.
    const wide = await listJobs(jobsEnv(), { namespace: "capsid" }, { withBody: true });
    for (const job of wide.jobs!) expect(job).not.toHaveProperty("body");

    const one = await listJobs(jobsEnv(), { namespace: "capsid", id }, { withBody: true });
    expect(one.jobs!).toHaveLength(1);
    expect((one.jobs![0] as { body?: string }).body).toContain("capsid-task-signature");

    const oneNoBody = await listJobs(jobsEnv(), { namespace: "capsid", id });
    expect(oneNoBody.jobs![0]).not.toHaveProperty("body");
  });
});

describe("the improve_status jobs block", () => {
  it("counts the open states per namespace and hands back the blocked jobs themselves", async () => {
    // Four jobs in three states, plus one in another namespace that must not be
    // counted here. The namespace filter is the assertion: a summary that summed the
    // whole table would report the same numbers for every project.
    await post({ title: "waiting" });
    const running = await post({ title: "running" });
    const stuck = await post({ title: "stuck", gate_required: true });
    const finished = await post({ title: "finished" });
    await post({ title: "elsewhere", namespace: "germomics" });

    await claimJob(jobsEnv(), DRIVER, NOW, { id: running.job!.id });
    await claimJob(jobsEnv(), OTHER, NOW, { id: stuck.job!.id });
    await blockJob(jobsEnv(), OTHER, NOW, stuck.job!.id, {
      reason: "the deploy needs confirming",
      command: "npm run deploy",
    });
    await claimJob(jobsEnv(), OTHER, NOW, { id: finished.job!.id });
    await completeJob(jobsEnv(), OTHER, NOW, finished.job!.id, { result_summary: "done" });

    const summary = await jobsSummary(env.DB, "capsid", NOW);
    expect(summary.queued).toBe(1);
    expect(summary.claimed).toBe(1);
    expect(summary.blocked).toBe(1);
    // done_today keys on the day the row was last touched, and completeJob stamped
    // it with the clock this test passed in.
    expect(summary.done_today).toBe(1);

    // THE BLOCKED JOBS COME BACK AS ROWS, with the command in them. A count would
    // tell the console there is something to look at and nothing about what to run.
    expect(summary.blocked_jobs).toHaveLength(1);
    expect(summary.blocked_jobs[0].id).toBe(stuck.job!.id);
    expect(summary.blocked_jobs[0].title).toBe("stuck");
    expect(String(summary.blocked_jobs[0].waiting_on)).toContain("npm run deploy");

    // The other namespace is not in these numbers.
    const other = await jobsSummary(env.DB, "germomics", NOW);
    expect(other.queued).toBe(1);
    expect(other.blocked_jobs).toEqual([]);
  });

  it("a namespace with no jobs reports zeroes, not an absent block", async () => {
    // A missing block and an empty queue are different facts, and the console has to
    // tell them apart. Zeroes are the honest answer.
    const summary = await jobsSummary(env.DB, "foxing", NOW);
    expect(summary).toEqual({ queued: 0, claimed: 0, blocked: 0, done_today: 0, blocked_jobs: [] });
  });

  it("improve_status carries the block for every namespace it reports", async () => {
    await post({ title: "visible in status" });
    const status = await improveStatus(jobsEnv(), "capsid");
    expect(status.namespaces).toHaveLength(1);
    expect(status.namespaces[0].jobs.queued).toBe(1);
    // Every namespace in the report has one, so a consumer never has to check.
    const all = await improveStatus(jobsEnv());
    for (const ns of all.namespaces) {
      expect(ns.jobs, `${ns.namespace} has no jobs block`).toBeTruthy();
    }
  });
});

describe("the signature", () => {
  it("a body edited after post is refused at claim, and the job is failed rather than left queued", async () => {
    const posted = await post({ title: "tampered", body: "do the safe thing" });
    const id = posted.job!.id;

    // The row edited the way a raw D1 splice would, which is the whole threat model:
    // a job body is executable input for a session holding local shell and repo
    // credentials, and it arrives as a database row.
    await env.DB.prepare("UPDATE jobs SET body = ?2 WHERE id = ?1")
      .bind(id, posted.job!.body.replace("do the safe thing", "do the dangerous thing"))
      .run();

    const claimed = await claimJob(jobsEnv(), DRIVER, NOW, { id });
    expect(claimed.ok).toBe(false);
    expect(claimed.refusal).toMatch(/failed its signature check/);
    expect(claimed.refusal).toMatch(/does not match its body/);

    // FAILED, not left queued. Leaving it would hand the same broken row to the next
    // driver, and every driver in turn.
    const stored = await row(id);
    expect(stored?.status).toBe("failed");
    expect(String(stored?.result_summary)).toMatch(/does not match its body/);

    // And the refusal is audited, so a tampered row is visible after the fact.
    expect(await auditActions(id)).toContain("job-signature-refused");
  });

  it("the honest case still claims, so the guard is not refusing everything", async () => {
    // The innocent direction. A guard that also fires on a job nobody touched gets
    // deleted rather than fixed.
    const posted = await post({ title: "untampered" });
    const claimed = await claimJob(jobsEnv(), DRIVER, NOW, { id: posted.job!.id });
    expect(claimed.ok, claimed.refusal).toBe(true);
  });
});

describe("the retry cap, where the block is written", () => {
  // Replaces a test in test/retry-cap.test.ts that only checked jobs.ts mentioned
  // cappedSummary (job_3e1596235513).
  async function blockedAt(corrections: number, title: string) {
    const posted = await post({ title });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid", id });
    await env.DB.prepare("UPDATE jobs SET corrections_count = ?1 WHERE id = ?2").bind(corrections, id).run();
    const blocked = await blockJob(jobsEnv(), DRIVER, NOW, id, { reason: "needs a human", command: "git push -u origin feat/x" });
    expect(blocked.ok, blocked.refusal).toBe(true);
    return String((await row(id))?.result_summary);
  }

  it("a block at the cap says so in the summary, and keeps what the driver said", async () => {
    const summary = await blockedAt(CORRECTION_CAP, "at the cap");
    expect(summary).toContain(RETRY_CAP_REASON);
    expect(summary).toContain("needs a human");
  });

  it("a block under the cap does not", async () => {
    const summary = await blockedAt(CORRECTION_CAP - 1, "under the cap");
    expect(summary).not.toContain(RETRY_CAP_REASON);
  });
});

describe("the retry cap, where resume reads it", () => {
  // Moved from test/retry-cap.test.ts (audit 2026-09-25, item C2-15). Those tests drove
  // resumeJob against a fake that matched SQL by regex and applied the UPDATE's
  // correction increment from params[4]. Here SQLite applies the increment and sums
  // corrections_count over every row that shares (namespace, title).
  //
  // Named agents rather than the legacy key: a legacy write key resolves to the admin,
  // and the admin is the one caller the cap lets through.
  function agentNamed(name: string, admin = false): Agent {
    const scopes = defaultScopes(["capsid"]);
    scopes.grants = ["read", "write"];
    return { id: "agent_aaaabbbbcccc", name, kind: admin ? "seat" : "driver", actor: `agent:${name}`, scopes, admin, row: null };
  }
  const CLAIMANT = agentNamed("capsid-driver");
  const OTHER_DRIVER = agentNamed("other-driver");

  async function blockedAt(corrections: number, title: string): Promise<string> {
    const posted = await post({ title, gate_required: true });
    expect(posted.ok, posted.refusal).toBe(true);
    const id = posted.job!.id;
    const claimed = await claimJob(jobsEnv(), CLAIMANT, NOW, { id });
    expect(claimed.ok, claimed.refusal).toBe(true);
    await env.DB.prepare("UPDATE jobs SET corrections_count = ?1 WHERE id = ?2").bind(corrections, id).run();
    const blocked = await blockJob(jobsEnv(), CLAIMANT, NOW, id, { reason: "stopped at the push", command: "git push -u origin feat/x" });
    expect(blocked.ok, blocked.refusal).toBe(true);
    return id;
  }

  it("the first two corrections are allowed, and each one spends the budget", async () => {
    for (const corrections of [0, 1]) {
      const id = await blockedAt(corrections, `correction ${corrections + 1}`);
      const result = await resumeJob(jobsEnv(), OTHER_DRIVER, NOW, id, "fix the review findings", { correction: true });
      expect(result.ok, `correction ${corrections + 1} refused: ${JSON.stringify(result)}`).toBe(true);
      expect((await row(id))?.corrections_count, "a correction that does not spend the budget can never reach the cap").toBe(corrections + 1);
      await env.DB.prepare("DELETE FROM jobs").run();
    }
  });

  it("PLANT: a PLAIN resume spends nothing, so ordinary pushes never reach the cap", async () => {
    // job_466d6472511e, 2026-09-16: three ordinary pushes, each one blocked and resumed,
    // put the job at corrections_count 2 and the next resume was refused as a retry
    // loop. Nothing had been corrected.
    const id = await blockedAt(0, "three ordinary pushes");
    for (let i = 1; i <= 3; i++) {
      const result = await resumeJob(jobsEnv(), OTHER_DRIVER, NOW, id, `push ${i} ran`);
      expect(result.ok, `plain resume ${i} refused: ${JSON.stringify(result)}`).toBe(true);
      expect((await row(id))?.corrections_count, `plain resume ${i} spent a correction`).toBe(0);
      const blocked = await blockJob(jobsEnv(), CLAIMANT, NOW, id, { reason: `push ${i + 1}`, command: "git push -u origin feat/x" });
      expect(blocked.ok, blocked.refusal).toBe(true);
    }
  });

  it("THE THIRD RESUME IS REFUSED, and the refusal names the cap", async () => {
    const id = await blockedAt(CORRECTION_CAP, "at the cap already");
    const before = await row(id);
    const result = await resumeJob(jobsEnv(), OTHER_DRIVER, NOW, id, "one more go");
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(new RegExp(RETRY_CAP_REASON));
    expect(result.refusal, "a refusal that does not say who CAN act leaves the job stuck").toMatch(/admin caller may resume it/);
    expect(await row(id), "a refused resume must leave the job exactly as it was, budget included").toEqual(before);
  });

  it("PLANT: re-posting the same work does NOT reset the correction budget", async () => {
    // Audit 2026-09-13, finding 9. Failing a job frees (namespace, title) to be posted
    // again on a fresh row at corrections_count 0. The cap is counted per
    // (namespace, title), so the fresh row inherits what its predecessor spent.
    const first = await blockedAt(CORRECTION_CAP, "the same work");
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?1").bind(first).run();
    const id = await blockedAt(0, "the same work");
    expect(id).not.toBe(first);
    const before = await row(id);
    const result = await resumeJob(jobsEnv(), OTHER_DRIVER, NOW, id, "posting it again");
    expect(result.ok, "a fresh row for the same work reset the cap").toBe(false);
    expect(result.refusal).toMatch(new RegExp(RETRY_CAP_REASON));
    expect(result.refusal, "the refusal must say why re-posting did not help").toMatch(/per \(namespace, title\) rather than per row/);
    expect(await row(id)).toEqual(before);
  });

  it("THE INNOCENT DIRECTION: work whose siblings spent nothing still resumes", async () => {
    const first = await blockedAt(0, "unspent work");
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?1").bind(first).run();
    const id = await blockedAt(0, "unspent work");
    const result = await resumeJob(jobsEnv(), OTHER_DRIVER, NOW, id, "first go");
    expect(result.ok, `an unspent budget was refused: ${JSON.stringify(result)}`).toBe(true);
    expect((await row(id))?.status).toBe("claimed");
  });

  it("THE SEAT IS ALSO REFUSED at the cap, because the seat is not the human", async () => {
    const id = await blockedAt(CORRECTION_CAP, "the seat at the cap");
    const result = await resumeJob(jobsEnv(), agentNamed("seat"), NOW, id, "the seat says go");
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(new RegExp(RETRY_CAP_REASON));
    expect((await row(id))?.status).toBe("blocked");
  });

  it("AN ADMIN RESUME IS ALLOWED at the cap, and does not spend the budget", async () => {
    const id = await blockedAt(CORRECTION_CAP, "the admin at the cap");
    // Passed as a correction, so the exemption is what keeps the budget still rather
    // than the absence of a correction.
    const result = await resumeJob(jobsEnv(), agentNamed("admin", true), NOW, id, "I looked at it and it is fine", { correction: true });
    expect(result.ok, `an admin resume was refused: ${JSON.stringify(result)}`).toBe(true);
    const stored = await row(id);
    expect(stored?.status).toBe("claimed");
    expect(stored?.corrections_count, "an admin resume must not spend the budget it just cleared").toBe(CORRECTION_CAP);
  });
});

describe("supersede", () => {
  // A job the seat replaced before any work was done on it. Every property here is a
  // property of the keyed UPDATE and the batch, so it is driven against the real D1.
  //
  // THE LEGACY CALLERS ABOVE ARE ADMIN, so a holder check tested with them would pass
  // whether or not it existed. These two are the same identities with the admin bit
  // and can_merge taken away, which is what a minted driver looks like.
  const plain = (agent: Agent): Agent => ({
    ...agent,
    admin: false,
    scopes: { ...agent.scopes, flags: { ...agent.scopes.flags, can_merge: false } },
  });
  const PLAIN_DRIVER = plain(DRIVER);
  const PLAIN_OTHER = plain(OTHER);
  const SEAT_AGENT = legacyAgent("write", SEAT);

  async function outcomeCount(id: string): Promise<number> {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM job_outcomes WHERE job_id = ?1").bind(id).first<{ n: number }>();
    return r?.n ?? 0;
  }

  async function mirror(id: string, namespace = "capsid") {
    return env.DB.prepare("SELECT body, status FROM documents WHERE namespace = ?1 AND path = ?2")
      .bind(namespace, jobDocPath(id))
      .first<{ body: string; status: string }>();
  }

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM job_outcomes").run();
  });

  it("supersedes a queued job with no claim, names the replacement, closes the mirror, and writes no outcome", async () => {
    const old = await post({ title: "the first draft" });
    const replacement = await post({ title: "the corrected draft" });
    const out = await supersedeJob(jobsEnv(), PLAIN_OTHER, NOW, old.job!.id, {
      reason: "reposted with a corrected body",
      replaced_by: replacement.job!.id,
    });
    expect(out.ok, out.refusal).toBe(true);
    const stored = await row(old.job!.id);
    expect(stored?.status).toBe("superseded");
    expect(stored?.result_summary).toBe(`Superseded by ${replacement.job!.id}: reposted with a corrected body`);
    expect(stored?.claimed_by).toBeNull();
    expect(stored?.lease_expires).toBeNull();
    expect(await outcomeCount(old.job!.id)).toBe(0);

    const doc = await mirror(old.job!.id);
    expect(doc!.body).toContain("status: **superseded**");
    expect(doc!.status).toBe("closed");
    expect(await auditActions(old.job!.id)).toContain("job-superseded");

    // It holds no title, so the same title can be posted again.
    const again = await post({ title: "the first draft" });
    expect(again.ok, again.refusal).toBe(true);
  });

  it("without replaced_by the summary says so plainly", async () => {
    const old = await post({ title: "withdrawn" });
    const out = await supersedeJob(jobsEnv(), SEAT_AGENT, NOW, old.job!.id, { reason: "no longer wanted" });
    expect(out.ok, out.refusal).toBe(true);
    expect((await row(old.job!.id))?.result_summary).toBe("Superseded: no longer wanted");
  });

  it("the holder of a claimed job with no work recorded may supersede it, and the claimant is kept", async () => {
    const old = await post({ title: "claimed then replaced" });
    const claimed = await claimJob(jobsEnv(), PLAIN_DRIVER, NOW, { id: old.job!.id });
    expect(claimed.ok, claimed.refusal).toBe(true);
    const out = await supersedeJob(jobsEnv(), PLAIN_DRIVER, NOW, old.job!.id, { reason: "the seat reordered the queue" });
    expect(out.ok, out.refusal).toBe(true);
    const stored = await row(old.job!.id);
    expect(stored?.status).toBe("superseded");
    expect(stored?.claimed_by).toBe(DRIVER_ACTOR);
    expect(stored?.lease_expires).toBeNull();
    expect(await outcomeCount(old.job!.id)).toBe(0);
    expect((await mirror(old.job!.id))!.status).toBe("closed");
    // The holder is free to claim again: a superseded job is not a held claim.
    const next = await post({ title: "the next one" });
    const reclaimed = await claimJob(jobsEnv(), PLAIN_DRIVER, NOW, { id: next.job!.id });
    expect(reclaimed.ok, reclaimed.refusal).toBe(true);
  });

  it("the seat may supersede a claimed job it does not hold", async () => {
    const old = await post({ title: "seat steps in" });
    await claimJob(jobsEnv(), PLAIN_DRIVER, NOW, { id: old.job!.id });
    const out = await supersedeJob(jobsEnv(), SEAT_AGENT, NOW, old.job!.id, { reason: "reposted" });
    expect(out.ok, out.refusal).toBe(true);
  });

  it("PLANT: a non-holder that is not the seat is refused on a claimed job", async () => {
    const old = await post({ title: "not yours" });
    await claimJob(jobsEnv(), PLAIN_DRIVER, NOW, { id: old.job!.id });
    const out = await supersedeJob(jobsEnv(), PLAIN_OTHER, NOW, old.job!.id, { reason: "mine now" });
    expect(out.ok).toBe(false);
    expect(out.refusal).toMatch(/is held by opkey:aaaabbbbcccc/);
    expect((await row(old.job!.id))?.status).toBe("claimed");
  });

  it("PLANT: a claimed job with a gate hit, a correction or a result_ref is refused, even for the seat", async () => {
    const plants = [
      ["hit a gate", "UPDATE jobs SET blocked_count = 1 WHERE id = ?1"],
      ["has a result", "UPDATE jobs SET result_ref = 'https://github.com/example/repo/pull/1' WHERE id = ?1"],
      ["was corrected", "UPDATE jobs SET corrections_count = 1 WHERE id = ?1"],
    ] as const;
    for (const [title, plant] of plants) {
      const old = await post({ title });
      await claimJob(jobsEnv(), PLAIN_DRIVER, NOW, { id: old.job!.id });
      await env.DB.prepare(plant).bind(old.job!.id).run();
      const out = await supersedeJob(jobsEnv(), SEAT_AGENT, NOW, old.job!.id, { reason: "replaced" });
      expect(out.ok, `${title} was superseded`).toBe(false);
      expect(out.refusal).toMatch(/has work recorded on it/);
      expect((await row(old.job!.id))?.status).toBe("claimed");
      await failJob(jobsEnv(), PLAIN_DRIVER, NOW, old.job!.id, "clearing the claim for the next case");
    }
  });

  it("PLANT: the keyed UPDATE itself refuses work recorded after the read", async () => {
    // The pre-check reads the row; the UPDATE is the rule. A gate hit that lands
    // between the two must still stop the supersede, so the statement is run here
    // against a row the pre-check never saw. Copied from src/jobs.ts: if the two
    // diverge, the one in src/ is what the query-plan walk and this module's source
    // guard see, and this copy states what it must still refuse.
    const old = await post({ title: "raced" });
    await claimJob(jobsEnv(), PLAIN_DRIVER, NOW, { id: old.job!.id });
    await env.DB.prepare("UPDATE jobs SET blocked_count = 1 WHERE id = ?1").bind(old.job!.id).run();
    const won = await env.DB.prepare(
      `UPDATE jobs SET status = 'superseded', result_summary = ?2, lease_expires = NULL, updated_at = ?3
       WHERE id = ?1 AND (status = 'queued' OR (status = 'claimed' AND claimed_by = ?4 AND blocked_count = 0
         AND resumed_count = 0 AND corrections_count = 0 AND result_ref IS NULL)) RETURNING id`
    )
      .bind(old.job!.id, "Superseded: x", NOW.toISOString(), DRIVER_ACTOR)
      .first<{ id: string }>();
    expect(won).toBeNull();
    expect((await row(old.job!.id))?.status).toBe("claimed");
  });

  it("refuses a job that is done, failed, blocked or already superseded", async () => {
    const done = await post({ title: "done" });
    await claimJob(jobsEnv(), DRIVER, NOW, { id: done.job!.id });
    await completeJob(jobsEnv(), DRIVER, NOW, done.job!.id, { result_summary: "landed" });

    const failed = await post({ title: "failed" });
    await claimJob(jobsEnv(), DRIVER, NOW, { id: failed.job!.id });
    await failJob(jobsEnv(), DRIVER, NOW, failed.job!.id, "could not");

    const blocked = await post({ title: "blocked" });
    await claimJob(jobsEnv(), DRIVER, NOW, { id: blocked.job!.id });
    await blockJob(jobsEnv(), DRIVER, NOW, blocked.job!.id, { reason: "needs a push", command: "git push origin HEAD" });

    const twice = await post({ title: "twice" });
    expect((await supersedeJob(jobsEnv(), SEAT_AGENT, NOW, twice.job!.id, { reason: "first" })).ok).toBe(true);

    const cases = [
      [done.job!.id, "done"],
      [failed.job!.id, "failed"],
      [blocked.job!.id, "blocked"],
      [twice.job!.id, "superseded"],
    ] as const;
    for (const [id, status] of cases) {
      const out = await supersedeJob(jobsEnv(), SEAT_AGENT, NOW, id, { reason: "again" });
      expect(out.ok, `${status} was superseded`).toBe(false);
      expect(out.refusal).toContain(`is ${status}`);
      expect((await row(id))?.status).toBe(status);
    }
  });

  it("refuses replaced_by that is unknown, in another namespace, or the job itself", async () => {
    const old = await post({ title: "to replace" });
    const elsewhere = await post({ title: "elsewhere", namespace: "germomics" });
    const cases: Array<[string, RegExp]> = [
      ["job_000000000000", /no job job_000000000000/],
      [elsewhere.job!.id, /is in germomics and .* is in capsid/],
      [old.job!.id, /cannot be replaced by itself/],
    ];
    for (const [replaced_by, refusal] of cases) {
      const out = await supersedeJob(jobsEnv(), SEAT_AGENT, NOW, old.job!.id, { reason: "replaced", replaced_by });
      expect(out.ok).toBe(false);
      expect(out.refusal).toMatch(refusal);
    }
    expect((await row(old.job!.id))?.status).toBe("queued");
  });

  it("a superseded job's old outcome row stays, and is left out of the agent record", async () => {
    // The shape 0020 leaves behind: a job claimed and failed to close it, with an
    // outcome row, then relabelled. The row stays; the record does not count it.
    const old = await post({ title: "claimed and failed to repost" });
    await claimJob(jobsEnv(), DRIVER, NOW, { id: old.job!.id });
    await failJob(jobsEnv(), DRIVER, NOW, old.job!.id, "Seat repost before any work");
    expect(await outcomeCount(old.job!.id)).toBe(1);
    expect((await loadRecordRows(env.DB)).outcomes.length).toBe(1);

    await env.DB.prepare("UPDATE jobs SET status = 'superseded' WHERE id = ?1").bind(old.job!.id).run();
    const after = await loadRecordRows(env.DB);
    expect(await outcomeCount(old.job!.id)).toBe(1);
    expect(after.outcomes.length).toBe(0);
    expect(after.jobs.some((r) => r.status === "failed")).toBe(false);
  });
});

describe("migrations/0020, the relabel", () => {
  // The migration already ran on an empty table at setup, so its statements are run
  // again here, taken from the migration itself, over rows seeded on either side of
  // the predicate.
  const relabel = env.TEST_MIGRATIONS.find((m) => m.name === "0020_jobs_superseded.sql");

  async function seed(id: string, status: string, summary: string | null, namespace = "capsid") {
    await env.DB.prepare(
      `INSERT INTO jobs (id, namespace, title, body, status, posted_by, result_summary)
       VALUES (?1, ?2, ?1, 'lorem ipsum', ?3, 'github:example', ?4)`
    )
      .bind(id, namespace, status, summary)
      .run();
  }

  it("moves only failed rows whose summary begins with the seat's wording, case-sensitively", async () => {
    expect(relabel, "no migration named 0020_jobs_superseded.sql").toBeTruthy();
    await seed("job_repost00000", "failed", "Seat repost before any work: see job_aaaaaaaaaaaa");
    await seed("job_withdraw000", "failed", "Seat withdrawal");
    await seed("job_reorder0000", "failed", "Seat reorder", "germomics");
    await seed("job_hold0000000", "failed", "Seat hold until the migration lands");
    await seed("job_supersede00", "failed", "Superseded by job_bbbbbbbbbbbb");
    // A literal prefix match, so this moves too: it begins with "Superseded".
    await seed("job_ish00000000", "failed", "Superseded-ish, but really a failure");
    // Left as failed, or left in the status they have.
    await seed("job_lower000000", "failed", "seat repost before any work");
    await seed("job_lowersup000", "failed", "superseded by job_cccccccccccc, merged in its place");
    await seed("job_upper000000", "failed", "SUPERSEDED by job_dddddddddddd");
    await seed("job_withdrawn00", "failed", "Withdrawn by the seat");
    await seed("job_middle00000", "failed", "Failed. Seat repost later.");
    await seed("job_null0000000", "failed", null);
    await seed("job_done0000000", "done", "Superseded the old approach and landed");
    await seed("job_queued00000", "queued", "Seat repost");

    for (const query of relabel!.queries) await env.DB.prepare(query).run();

    const { results } = await env.DB.prepare("SELECT id, status FROM jobs ORDER BY id").all<{ id: string; status: string }>();
    const status = Object.fromEntries((results ?? []).map((r) => [r.id, r.status]));
    expect(status).toEqual({
      job_done0000000: "done",
      job_hold0000000: "superseded",
      job_ish00000000: "superseded",
      job_lower000000: "failed",
      job_lowersup000: "failed",
      job_middle00000: "failed",
      job_null0000000: "failed",
      job_queued00000: "queued",
      job_reorder0000: "superseded",
      job_repost00000: "superseded",
      job_supersede00: "superseded",
      job_upper000000: "failed",
      job_withdraw000: "superseded",
      job_withdrawn00: "failed",
    });
    // A summary that names the replacing job keeps naming it.
    expect((await row("job_repost00000"))?.result_summary).toContain("job_aaaaaaaaaaaa");
  });
});

// ---- audit 2026-09-25, F1-1: every transition is one guarded batch --------------------
//
// Each case puts a competing write between the transition's read and its batch, through
// racingEnv, and checks two things only SQLite can show: the competing write wins, and
// the losing transition left no audit row and no moved row behind.

async function actorAudits(actor: string, action: string): Promise<number> {
  const found = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE actor = ?1 AND action = ?2")
    .bind(actor, action)
    .first<{ n: number }>();
  return found?.n ?? 0;
}

describe("every transition is one guarded batch", () => {
  it("PLANT: a claim that loses the race between its read and its batch records nothing", async () => {
    const id = (await post({ title: "claim race" })).job!.id;
    const racing = racingEnv(async () => {
      const other = await claimJob(jobsEnv(), OTHER, NOW, { id });
      expect(other.ok, other.refusal).toBe(true);
    });
    const lost = await claimJob(racing, DRIVER, NOW, { id });
    expect(lost.ok).toBe(false);
    expect(lost.refusal).toMatch(/claimed by someone else/);
    expect((await row(id))?.claimed_by).toBe(OTHER_ACTOR);
    expect(await actorAudits(DRIVER_ACTOR, "job-claimed")).toBe(0);
  });

  it("PLANT: a claim whose records fail does not move the row, because they are one transaction", async () => {
    const id = (await post({ title: "claim atomic" })).job!.id;
    const failing = {
      ...jobsEnv(),
      DB: {
        prepare: (sql: string) => env.DB.prepare(sql),
        batch: (statements: D1PreparedStatement[]) => env.DB.batch([...statements, env.DB.prepare("INSERT INTO no_such_table VALUES (1)")]),
      },
    } as unknown as Parameters<typeof postJob>[0];
    await expect(claimJob(failing, DRIVER, NOW, { id })).rejects.toThrow(/no_such_table/);
    expect((await row(id))?.status).toBe("queued");
    expect(await actorAudits(DRIVER_ACTOR, "job-claimed")).toBe(0);
  });

  it("PLANT: an admin fail that loses the race to the driver's complete records nothing", async () => {
    const id = (await post({ title: "admin fail race" })).job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    const racing = racingEnv(async () => {
      const done = await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "finished first" });
      expect(done.ok, done.refusal).toBe(true);
    });
    const failed = await adminFailJob(racing, legacyAgent("write", SEAT), NOW, id, "driver went away");
    expect(failed.ok).toBe(false);
    expect(failed.refusal).toMatch(/changed between reading it and failing it: it is now done/);
    expect((await row(id))?.status).toBe("done");
    expect(await auditActions(id)).not.toContain("job-admin-fail");
  });

  it("PLANT: a supersede that loses the race to a claim records nothing", async () => {
    const id = (await post({ title: "supersede race" })).job!.id;
    const racing = racingEnv(async () => {
      await claimJob(jobsEnv(), OTHER, NOW, { id });
    });
    const superseded = await supersedeJob(racing, DRIVER, NOW, id, { reason: "reposted" });
    expect(superseded.ok).toBe(false);
    expect(superseded.refusal).toMatch(/changed between reading it and superseding it/);
    expect((await row(id))?.status).toBe("claimed");
    expect(await auditActions(id)).not.toContain("job-superseded");
  });

  it("PLANT: the lease sweep leaves a job whose driver heartbeat between the read and the batch", async () => {
    const id = (await post({ title: "sweep race" })).job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    const later = new Date(NOW.getTime() + JOB_LEASE_SECONDS * 1000 + 1000);
    const racing = racingEnv(async () => {
      const beat = await heartbeatJob(jobsEnv(), DRIVER, later, id);
      expect(beat.ok, beat.refusal).toBe(true);
    });
    const swept = await expireJobLeases(racing, later);
    expect(swept.requeued).toEqual([]);
    expect((await row(id))?.status).toBe("claimed");
    expect(await auditActions(id)).not.toContain("job-lease-expired");
  });

  it("the sweep still requeues an expired job no one touched, with its record", async () => {
    const id = (await post({ title: "sweep plain" })).job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    const later = new Date(NOW.getTime() + JOB_LEASE_SECONDS * 1000 + 1000);
    expect((await expireJobLeases(jobsEnv(), later)).requeued).toEqual([id]);
    expect((await row(id))?.status).toBe("queued");
    expect(await auditActions(id)).toContain("job-lease-expired");
  });
});
