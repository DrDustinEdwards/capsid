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

// The work queue against a real D1 (jobs.test.ts): supersede, the 0020 relabel, guarded batches and the 0045 key revocation.

beforeEach(resetJobs);

describe("supersede", () => {
  // A job the seat replaced before any work was done on it.
  //
  // The legacy callers above are admin, so a holder check tested with them would pass
  // whether or not it existed. These two have the admin bit and can_merge taken away,
  // as a minted driver does.
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

  it("without replaced_by the summary says so plainly", async () => {
    const old = await post({ title: "withdrawn" });
    const out = await supersedeJob(jobsEnv(), SEAT_AGENT, NOW, old.job!.id, {
      reason: "no longer wanted",
    });
    expect(out.ok, out.refusal).toBe(true);
    expect((await jobRow(old.job!.id))?.result_summary).toBe("Superseded: no longer wanted");
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
    const out = await supersedeJob(jobsEnv(), PLAIN_OTHER, NOW, old.job!.id, {
      reason: "mine now",
    });
    expect(out.ok).toBe(false);
    expect(out.refusal).toMatch(new RegExp(`is held by ${DRIVER_ACTOR}`));
    expect((await jobRow(old.job!.id))?.status).toBe("claimed");
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

  it("PLANT: the keyed UPDATE itself refuses work recorded after the read", async () => {
    // The pre-check reads the row; the UPDATE is the rule. A gate hit that lands
    // between the two must still stop the supersede, so the statement (copied from
    // src/jobs.ts) is run against a row the pre-check never saw.
    const old = await post({ title: "raced" });
    await claimJob(jobsEnv(), PLAIN_DRIVER, NOW, { id: old.job!.id });
    await env.DB.prepare("UPDATE jobs SET blocked_count = 1 WHERE id = ?1").bind(old.job!.id).run();
    const won = await env.DB.prepare(
      `UPDATE jobs SET status = 'superseded', result_summary = ?2, updated_at = ?3
       WHERE id = ?1 AND (status = 'queued' OR (status = 'claimed' AND claimed_by = ?4 AND blocked_count = 0
         AND resumed_count = 0 AND corrections_count = 0 AND result_ref IS NULL)) RETURNING id`,
    )
      .bind(old.job!.id, "Superseded: x", NOW.toISOString(), DRIVER_ACTOR)
      .first<{ id: string }>();
    expect(won).toBeNull();
    expect((await jobRow(old.job!.id))?.status).toBe("claimed");
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
    // The shape 0020 leaves behind: a job claimed and failed to close it, with an
    // outcome row, then relabelled. The row stays; the record does not count it.
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

describe("migrations/0020, the relabel", () => {
  // The migration already ran on an empty table at setup, so its statements are run
  // again here, taken from the migration itself, over rows seeded on either side of
  // the predicate.
  const relabel = env.TEST_MIGRATIONS.find((m) => m.name === "0020_jobs_superseded.sql");

  async function seed(id: string, status: string, summary: string | null, namespace = "capsid") {
    await env.DB.prepare(
      `INSERT INTO jobs (id, namespace, title, body, status, posted_by, result_summary)
       VALUES (?1, ?2, ?1, 'lorem ipsum', ?3, 'github:example', ?4)`,
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

    const { results } = await env.DB.prepare("SELECT id, status FROM jobs ORDER BY id").all<{
      id: string;
      status: string;
    }>();
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
    expect((await jobRow("job_repost00000"))?.result_summary).toContain("job_aaaaaaaaaaaa");
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
