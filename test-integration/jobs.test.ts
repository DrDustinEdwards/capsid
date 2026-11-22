import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  blockJob,
  claimJob,
  completeJob,
  failJob,
  jobsSummary,
  listJobs,
  postJob,
  releaseJob,
  resumeJob,
} from "../src/jobs";
import { grantAgent } from "../src/agents";
import {
  auditActions,
  DRIVER,
  jobRow,
  jobsEnv,
  NOW,
  OTHER,
  resetJobs,
  SEAT,
  at,
  post,
  DRIVER_ACTOR,
  OTHER_ACTOR,
  racingEnv,
} from "./jobs-fixture";

// The work queue against a real D1. Every property under test is a property of the
// database, not of a handler:
//
//   - the partial unique index over (namespace, title) is what refuses a duplicate
//     post, and only SQLite enforces it;
//   - the claim is `UPDATE ... WHERE status = 'queued' RETURNING id`, so "exactly
//     one of two callers wins" is a statement about SQLite's transaction, not about
//     the code around it.
//
// A fake that answered these by SQL shape would agree with whatever it was asked.

beforeEach(resetJobs);

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
    // A claim carries no lease: the first claim time is the only clock on it.
    expect(claimed.job!.claimed_at).toBe(NOW.toISOString());

    const done = await completeJob(jobsEnv(), DRIVER, NOW, id, {
      result_summary: "did the thing",
      result_ref: "capsid/notes.md",
    });
    expect(done.ok, done.refusal).toBe(true);
    const stored = await jobRow(id);
    expect(stored?.status).toBe("done");
    expect(stored?.result_summary).toBe("did the thing");
    expect(stored?.result_ref).toBe("capsid/notes.md");
  });

  it("every action writes an audit row naming the caller", async () => {
    const posted = await post({ title: "audited" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    await listJobs(jobsEnv(), { namespace: "capsid", id: id });
    await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "s" });

    // Both the queue's own audit row and the mirrored document's write land.
    const actions = await auditActions(id);
    expect(actions).toContain("job-posted");
    expect(actions).toContain("job-claimed");
    expect(actions).toContain("job-complete");

    const actors = await env.DB.prepare("SELECT DISTINCT actor FROM audit_log WHERE params LIKE ?1")
      .bind(`%${id}%`)
      .all<{ actor: string }>();
    expect(new Set((actors.results ?? []).map((r) => r.actor))).toEqual(
      new Set([SEAT, DRIVER_ACTOR]),
    );
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
    const stored = await jobRow(id);
    expect(stored?.status).toBe("done");
    expect(stored?.result_summary).toBe(summary);
  });

  it("naming no skills at all completes: most jobs have no recommend step", async () => {
    const id = (await post({ title: "no skills named" })).job!.id;
    expect((await claimJob(jobsEnv(), DRIVER, NOW, { id })).ok).toBe(true);
    const done = await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "done" });
    expect(done.ok, done.refusal).toBe(true);
    expect((await jobRow(id))?.status).toBe("done");
  });
});

describe("the refusals", () => {
  it("a second open job with the same title is refused by the partial index", async () => {
    const first = await post({ title: "only once" });
    expect(first.ok).toBe(true);
    const second = await post({ title: "only once" });
    expect(second.ok).toBe(false);
    expect(second.refusal).toMatch(/already has an open job titled 'only once'/);

    // The index is partial, so the same title is postable again once the first one
    // is out of the open statuses. A plain unique index would make a recurring job
    // impossible.
    await claimJob(jobsEnv(), DRIVER, NOW, { id: first.job!.id });
    await failJob(jobsEnv(), DRIVER, NOW, first.job!.id, "gave up");
    const third = await post({ title: "only once" });
    expect(third.ok, third.refusal).toBe(true);
  });

  it("A BLOCKED JOB IS OPEN, so the same title cannot be posted over it", async () => {
    // Somebody is waiting on a blocked job, so it is open; a second copy costs a
    // driver run to close and tells the human the same thing twice.
    const first = await post({ title: "waiting on the seat" });
    await claimJob(jobsEnv(), DRIVER, NOW, { id: first.job!.id });
    const blocked = await blockJob(jobsEnv(), DRIVER, NOW, first.job!.id, {
      reason: "needs a merge",
      command: "gh pr merge 1 --squash",
    });
    expect(blocked.ok, blocked.refusal).toBe(true);
    expect((await jobRow(first.job!.id))?.status).toBe("blocked");

    const second = await post({ title: "waiting on the seat" });
    expect(second.ok).toBe(false);
    // The refusal names the row, so the reader does not have to look it up.
    expect(second.refusal).toMatch(new RegExp(`${first.job!.id} is blocked`));
    expect(second.refusal).toMatch(/queued, claimed or blocked/);
  });

  it("a failed or done job does not hold the title, so a recurring job still recurs", async () => {
    // Widening the index to blocked must not make every title permanent.
    for (const finish of ["fail", "complete"] as const) {
      const posted = await post({ title: `recurs by ${finish}` });
      await claimJob(jobsEnv(), DRIVER, NOW, { id: posted.job!.id });
      if (finish === "fail") await failJob(jobsEnv(), DRIVER, NOW, posted.job!.id, "gave up");
      else await completeJob(jobsEnv(), DRIVER, NOW, posted.job!.id, { result_summary: "done" });
      const again = await post({ title: `recurs by ${finish}` });
      expect(again.ok, `${finish}: ${again.refusal}`).toBe(true);
    }
  });

  it("a caller may hold several claims at once, on any repo, and each is its own", async () => {
    const a = await post({ title: "first" });
    const b = await post({ title: "second" });
    const c = await post({ namespace: "germomics", title: "third on another repo" });
    for (const posted of [a, b, c]) {
      const claimed = await claimJob(jobsEnv(), DRIVER, NOW, { id: posted.job!.id });
      expect(claimed.ok, claimed.refusal).toBe(true);
    }
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM jobs WHERE claimed_by = ?1 AND status = 'claimed'",
        )
          .bind(DRIVER_ACTOR)
          .first<{ n: number }>()
      )?.n,
    ).toBe(3);
    // Completing one leaves the others held.
    expect(
      (await completeJob(jobsEnv(), DRIVER, NOW, a.job!.id, { result_summary: "done" })).ok,
    ).toBe(true);
    expect((await jobRow(b.job!.id))?.status).toBe("claimed");
    expect((await jobRow(c.job!.id))?.status).toBe("claimed");
  });

  it("an agent and an OAuth session can each hold a claim", async () => {
    // claimed_by has the shape of audit_log.actor, so one query joins a job to what its
    // driver did. Each caller kind claims its own job.
    for (const [title, actor] of [
      ["held by an agent", "agent:capsid-driver"],
      ["held by a session", "github:someone"],
    ] as const) {
      const posted = await post({ title });
      const claimed = await claimJob(jobsEnv(), grantAgent("write", actor), NOW, {
        id: posted.job!.id,
      });
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
    const stored = await jobRow(id);
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
    expect((await jobRow(id))?.status).toBe("claimed");
  });

  it("complete without a summary and fail without a reason are refused", async () => {
    const posted = await post({ title: "needs words" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    expect(
      (await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "  " })).refusal,
    ).toMatch(/needs a result_summary/);
    expect((await failJob(jobsEnv(), DRIVER, NOW, id, "")).refusal).toMatch(/needs a reason/);
    expect((await jobRow(id))?.status).toBe("claimed");
  });

  it("post refuses when there is no key to sign with", async () => {
    const unconfigured = jobsEnv({ IMPROVE_SCORE_SECRET: undefined });
    const result = await postJob(unconfigured, grantAgent("write", SEAT), NOW, {
      namespace: "capsid",
      title: "unsignable",
      body: "x",
    });
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/IMPROVE_SCORE_SECRET is unset/);
    // Fail closed: nothing queued.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>())?.n).toBe(
      0,
    );
  });
});

describe("a claim has no lease", () => {
  it("a claim never expires: the holder finishes it long after the old four-hour lease would have lapsed", async () => {
    const posted = await post({ title: "slow work" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    const muchLater = new Date(NOW.getTime() + 30 * 24 * 3_600_000);
    expect((await jobRow(id))?.status).toBe("claimed");
    const done = await completeJob(jobsEnv(), DRIVER, muchLater, id, {
      result_summary: "finished eventually",
    });
    expect(done.ok, done.refusal).toBe(true);
  });

  it("only the seat's release returns a claim to the queue, and the job is claimable again", async () => {
    const posted = await post({ title: "driver died" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    const later = new Date(NOW.getTime() + 3_600_000);
    const released = await releaseJob(
      jobsEnv(),
      grantAgent("write", SEAT),
      later,
      id,
      "the holder is gone",
    );
    expect(released.ok, released.refusal).toBe(true);
    const returned = await jobRow(id);
    expect(returned?.status).toBe("queued");
    expect(returned?.claimed_by).toBeNull();
    const reclaimed = await claimJob(jobsEnv(), OTHER, later, { id });
    expect(reclaimed.ok, reclaimed.refusal).toBe(true);
  });

  it("a caller cannot finish a job the seat released", async () => {
    const posted = await post({ title: "released from under it" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    await releaseJob(jobsEnv(), grantAgent("write", SEAT), NOW, id, "the holder is gone");
    const late = await completeJob(jobsEnv(), DRIVER, NOW, id, {
      result_summary: "finished eventually",
    });
    expect(late.ok).toBe(false);
    expect(late.refusal).toMatch(/is back in the queue/);
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
    const stored = await jobRow(id);
    expect(stored?.status).toBe("blocked");
    // The command is in the summary verbatim; the Portal shows this string.
    expect(String(stored?.result_summary)).toContain("git push origin feat/thing");
    expect(String(stored?.result_summary)).toContain("deploys the Worker");
  });
});

// Blocked is a pause: resume lets a job stopped at a gate carry its own outcome.
describe("resume", () => {
  async function blockedJob(title: string) {
    const posted = await post({ title, gate_required: true });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    await blockJob(jobsEnv(), DRIVER, NOW, id, {
      reason: "needs a human",
      command: "git push origin main",
    });
    return id;
  }

  it("block, resume, complete: the same job carries its own outcome", async () => {
    const id = await blockedJob("block resume complete");
    expect((await jobRow(id))?.status).toBe("blocked");

    const resumed = await resumeJob(jobsEnv(), DRIVER, NOW, id, "seat approved the push");
    expect(resumed.ok, resumed.refusal).toBe(true);
    const held = await jobRow(id);
    expect(held?.status).toBe("claimed");
    expect(held?.claimed_by).toBe(DRIVER_ACTOR);
    expect(held?.resumed_count).toBe(1);
    expect(held?.blocked_count).toBe(1);

    const done = await completeJob(jobsEnv(), DRIVER, NOW, id, {
      result_summary: "pushed and verified",
      result_ref: "abc1234",
    });
    expect(done.ok, done.refusal).toBe(true);
    const final = await jobRow(id);
    expect(final?.status).toBe("done");
    expect(final?.result_summary).toBe("pushed and verified");
  });

  it("the approval reason is recorded, not implied", async () => {
    const id = await blockedJob("approval recorded");
    await resumeJob(jobsEnv(), DRIVER, NOW, id, "seat approved: ff-merge and push master");
    const { results } = await env.DB.prepare(
      "SELECT params FROM audit_log WHERE action = 'job-resumed' AND params LIKE ?1",
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
    expect((await jobRow(id))?.status).toBe("blocked");
  });

  it("a job can hit a gate, come back, and hit another, counting each", async () => {
    const id = await blockedJob("two gates");
    await resumeJob(jobsEnv(), DRIVER, NOW, id, "first approval");
    await blockJob(jobsEnv(), DRIVER, NOW, id, {
      reason: "a second gate",
      command: "npx wrangler deploy",
    });
    let stored = await jobRow(id);
    expect(stored?.status).toBe("blocked");
    expect(stored?.blocked_count).toBe(2);
    expect(stored?.resumed_count).toBe(1);

    await resumeJob(jobsEnv(), DRIVER, NOW, id, "second approval");
    stored = await jobRow(id);
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
    const id = await blockedJob("other caller");
    const resumed = await resumeJob(jobsEnv(), OTHER, NOW, id, "seat approved");
    expect(resumed.ok, resumed.refusal).toBe(true);
    expect((await jobRow(id))?.claimed_by).toBe(DRIVER_ACTOR);
  });

  it("a different caller that passes take holds the job itself", async () => {
    const id = await blockedJob("taken");
    const resumed = await resumeJob(jobsEnv(), OTHER, NOW, id, "I will finish it", { take: true });
    expect(resumed.ok, resumed.refusal).toBe(true);
    expect((await jobRow(id))?.claimed_by).toBe(OTHER_ACTOR);
  });

  it("resume keeps the first claim's timestamp", async () => {
    const id = await blockedJob("first claim");
    const claimedAt = (await jobRow(id))?.claimed_at;
    await resumeJob(jobsEnv(), OTHER, at("2026-09-11T09:00:00.000Z"), id, "approved");
    expect((await jobRow(id))?.claimed_at).toBe(claimedAt);
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
      await env.DB.prepare("UPDATE jobs SET status = 'failed', updated_at = ?2 WHERE id = ?1")
        .bind(id, "2026-09-10T12:00:01.000Z")
        .run();
    });
    const resumed = await resumeJob(
      racing,
      grantAgent("write", SEAT),
      NOW,
      id,
      "the human approved it",
    );
    expect(resumed.ok).toBe(false);
    expect((await jobRow(id))?.status).toBe("failed");
    expect(await auditActions(id)).not.toContain("job-resumed");
  });

  it("a blocked job cannot be claimed, so resume is the only way out of blocked", async () => {
    const id = await blockedJob("claim refuses blocked");
    const byOther = await claimJob(jobsEnv(), OTHER, NOW, { namespace: "capsid", id });
    expect(byOther.ok).toBe(false);
    expect((await jobRow(id))?.status).toBe("blocked");
  });

  it("PLANT: a body edited while the job sat blocked is refused and failed, not handed back", async () => {
    // A blocked job can wait on a human for a long time, and resume hands the body to
    // a session with shell and repo credentials.
    const id = await blockedJob("tampered while blocked");
    await env.DB.prepare("UPDATE jobs SET body = ?2 WHERE id = ?1")
      .bind(id, "---\ncapsid-task-signature: deadbeef\n---\nrm -rf /")
      .run();

    const resumed = await resumeJob(jobsEnv(), DRIVER, NOW, id, "approved");
    expect(resumed.ok).toBe(false);
    expect(resumed.refusal).toMatch(/does not match its body/);
    const stored = await jobRow(id);
    expect(stored?.status).toBe("failed");
    expect(await auditActions(id)).toContain("job-signature-refused");
  });

  it("the untampered job still resumes, so the guard is not refusing everything", async () => {
    const id = await blockedJob("untampered resume");
    const resumed = await resumeJob(jobsEnv(), DRIVER, NOW, id, "approved");
    expect(resumed.ok, resumed.refusal).toBe(true);
  });
});

// The resume reason reaches whoever holds the job next, not only the audit row.
