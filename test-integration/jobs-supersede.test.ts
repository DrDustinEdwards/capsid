import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  adminFailJob,
  blockJob,
  claimJob,
  completeJob,
  failJob,
  postJob,
  releaseJob,
  supersedeJob,
} from "../src/jobs";
import { grantAgent } from "../src/agents";
import { loadRecordRows } from "../src/agent-record";
import { jobDocPath } from "../src/jobs-schema";
import {
  auditActions,
  racingEnv,
  racingComplete,
  plain,
  SEAT_AGENT,
  post,
  resetJobs,
  SEAT,
  DRIVER_ACTOR,
  OTHER_ACTOR,
  DRIVER,
  OTHER,
  NOW,
  jobRow,
  jobsEnv,
} from "./jobs-fixture";

beforeEach(resetJobs);

describe("supersede", () => {
  // A job the seat replaced before any work was done on it. Legacy callers are admin, so a holder check tested with them
  // passes either way; these two have the admin bit and can_merge removed, as a minted driver does.
  const PLAIN_DRIVER = plain(DRIVER);
  const PLAIN_OTHER = plain(OTHER);

  async function outcomeCount(id: string): Promise<number> {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM job_outcomes WHERE job_id = ?1")
      .bind(id)
      .first<{ n: number }>();
    return r?.n ?? 0;
  }

  async function mirror(id: string, namespace = "capsid") {
    return env.DB.prepare("SELECT body, status FROM documents WHERE namespace = ?1 AND path = ?2")
      .bind(namespace, jobDocPath(id))
      .first<{ body: string; status: string }>();
  }

  async function superseded(out: { ok: boolean; refusal?: string }, id: string) {
    expect(out.ok, out.refusal).toBe(true);
    const stored = await jobRow(id);
    expect(stored?.status).toBe("superseded");
    return stored;
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
    const stored = await superseded(out, old.job!.id);
    expect(stored?.result_summary).toBe(
      `Superseded by ${replacement.job!.id}: reposted with a corrected body`,
    );
    expect(stored?.claimed_by).toBeNull();
    expect(await outcomeCount(old.job!.id)).toBe(0);

    const doc = await mirror(old.job!.id);
    expect(doc!.body).toContain("status: **superseded**");
    expect(doc!.status).toBe("closed");
    expect(await auditActions(old.job!.id)).toContain("job-superseded");

    // It holds no title, so the same title can be posted again.
    const again = await post({ title: "the first draft" });
    expect(again.ok, again.refusal).toBe(true);
  });

  it("the holder of a claimed job with no work recorded may supersede it, and the claimant is kept", async () => {
    const old = await post({ title: "claimed then replaced" });
    const claimed = await claimJob(jobsEnv(), PLAIN_DRIVER, NOW, { id: old.job!.id });
    expect(claimed.ok, claimed.refusal).toBe(true);
    const out = await supersedeJob(jobsEnv(), PLAIN_DRIVER, NOW, old.job!.id, {
      reason: "the seat reordered the queue",
    });
    const stored = await superseded(out, old.job!.id);
    expect(stored?.claimed_by).toBe(DRIVER_ACTOR);
    expect(await outcomeCount(old.job!.id)).toBe(0);
    expect((await mirror(old.job!.id))!.status).toBe("closed");
    const next = await post({ title: "the next one" });
    const reclaimed = await claimJob(jobsEnv(), PLAIN_DRIVER, NOW, { id: next.job!.id });
    expect(reclaimed.ok, reclaimed.refusal).toBe(true);
  });

  it("PLANT: a non-holder that is not the seat is refused on a claimed job", async () => {
    const old = await post({ title: "not yours" });
    await claimJob(jobsEnv(), PLAIN_DRIVER, NOW, { id: old.job!.id });
    const out = await supersedeJob(jobsEnv(), PLAIN_OTHER, NOW, old.job!.id, {
      reason: "mine now",
    });
    expect(out.ok).toBe(false);
    expect(out.refusal).toMatch(new RegExp(`is held by ${DRIVER_ACTOR}`));
    expect((await jobRow(old.job!.id))?.status).toBe("claimed");
    const bySeat = await supersedeJob(jobsEnv(), SEAT_AGENT, NOW, old.job!.id, {
      reason: "reposted",
    });
    expect(bySeat.ok, bySeat.refusal).toBe(true);
  });

  it("PLANT: a claimed job with a gate hit, a correction or a result_ref is refused, even for the seat", async () => {
    const plants = [
      ["hit a gate", "UPDATE jobs SET blocked_count = 1 WHERE id = ?1"],
      [
        "has a result",
        "UPDATE jobs SET result_ref = 'https://github.com/example/repo/pull/1' WHERE id = ?1",
      ],
      ["was corrected", "UPDATE jobs SET corrections_count = 1 WHERE id = ?1"],
    ] as const;
    for (const [title, plant] of plants) {
      const old = await post({ title });
      await claimJob(jobsEnv(), PLAIN_DRIVER, NOW, { id: old.job!.id });
      await env.DB.prepare(plant).bind(old.job!.id).run();
      const out = await supersedeJob(jobsEnv(), SEAT_AGENT, NOW, old.job!.id, {
        reason: "replaced",
      });
      expect(out.ok, `${title} was superseded`).toBe(false);
      expect(out.refusal).toMatch(/has work recorded on it/);
      expect((await jobRow(old.job!.id))?.status).toBe("claimed");
      await failJob(
        jobsEnv(),
        PLAIN_DRIVER,
        NOW,
        old.job!.id,
        "clearing the claim for the next case",
      );
    }
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
    await blockJob(jobsEnv(), DRIVER, NOW, blocked.job!.id, {
      reason: "needs a push",
      command: "git push origin HEAD",
    });

    const twice = await post({ title: "twice" });
    expect(
      (await supersedeJob(jobsEnv(), SEAT_AGENT, NOW, twice.job!.id, { reason: "first" })).ok,
    ).toBe(true);

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
      expect((await jobRow(id))?.status).toBe(status);
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
      const out = await supersedeJob(jobsEnv(), SEAT_AGENT, NOW, old.job!.id, {
        reason: "replaced",
        replaced_by,
      });
      expect(out.ok).toBe(false);
      expect(out.refusal).toMatch(refusal);
    }
    expect((await jobRow(old.job!.id))?.status).toBe("queued");
  });

  it("a superseded job's old outcome row stays, and is left out of the agent record", async () => {
    // A job claimed and failed to close it, with an outcome row, then relabelled. The
    // row stays; the record does not count it.
    const old = await post({ title: "claimed and failed to repost" });
    await claimJob(jobsEnv(), DRIVER, NOW, { id: old.job!.id });
    await failJob(jobsEnv(), DRIVER, NOW, old.job!.id, "Seat repost before any work");
    expect(await outcomeCount(old.job!.id)).toBe(1);
    expect((await loadRecordRows(env.DB)).outcomes.length).toBe(1);

    await env.DB.prepare("UPDATE jobs SET status = 'superseded' WHERE id = ?1")
      .bind(old.job!.id)
      .run();
    const after = await loadRecordRows(env.DB);
    expect(await outcomeCount(old.job!.id)).toBe(1);
    expect(after.outcomes.length).toBe(0);
    expect(after.jobs.some((r) => r.status === "failed")).toBe(false);
  });
});

// Every transition is one guarded batch. Each case puts a competing write between the transition's read and its batch, through
// racingEnv, and checks two things only SQLite can show: the competing write wins, and
// the losing transition left no audit row and no moved row behind.

async function actorAudits(actor: string, action: string): Promise<number> {
  const found = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM audit_log WHERE actor = ?1 AND action = ?2",
  )
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
    expect((await jobRow(id))?.claimed_by).toBe(OTHER_ACTOR);
    expect(await actorAudits(DRIVER_ACTOR, "job-claimed")).toBe(0);
  });

  it("PLANT: a claim whose records fail does not move the row, because they are one transaction", async () => {
    const id = (await post({ title: "claim atomic" })).job!.id;
    const failing = {
      ...jobsEnv(),
      DB: {
        prepare: (sql: string) => env.DB.prepare(sql),
        batch: (statements: D1PreparedStatement[]) =>
          env.DB.batch([...statements, env.DB.prepare("INSERT INTO no_such_table VALUES (1)")]),
      },
    } as unknown as Parameters<typeof postJob>[0];
    await expect(claimJob(failing, DRIVER, NOW, { id })).rejects.toThrow(/no_such_table/);
    expect((await jobRow(id))?.status).toBe("queued");
    expect(await actorAudits(DRIVER_ACTOR, "job-claimed")).toBe(0);
  });

  it("PLANT: an admin fail that loses the race to the driver's complete records nothing", async () => {
    const id = (await post({ title: "admin fail race" })).job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    const racing = racingComplete(id);
    const failed = await adminFailJob(
      racing,
      grantAgent("write", SEAT),
      NOW,
      id,
      "driver went away",
    );
    expect(failed.ok).toBe(false);
    expect(failed.refusal).toMatch(/changed between reading it and failing it: it is now done/);
    expect((await jobRow(id))?.status).toBe("done");
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
    expect((await jobRow(id))?.status).toBe("claimed");
    expect(await auditActions(id)).not.toContain("job-superseded");
  });

  it("PLANT: a release that loses the race to the holder's complete records nothing", async () => {
    const id = (await post({ title: "release race" })).job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    const racing = racingComplete(id);
    const released = await releaseJob(
      racing,
      grantAgent("write", SEAT),
      NOW,
      id,
      "the holder is gone",
    );
    expect(released.ok).toBe(false);
    expect((await jobRow(id))?.status).toBe("done");
    expect(await auditActions(id)).not.toContain("job-released");
  });
});
