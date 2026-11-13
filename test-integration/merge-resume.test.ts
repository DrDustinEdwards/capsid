import { env } from "cloudflare:test";
import { resetCapsidDb } from "./reset-db";
import { beforeEach, describe, expect, it } from "vitest";
import { blockJob, claimJob } from "../src/jobs";
import { autoResumeJob, MERGE_RESUME_ACTOR } from "../src/jobs-seat";
import { mergeResumeTick } from "../src/merge-resume";
import { readJob } from "../src/jobs-transition";
import { grantAgent } from "../src/agents";
import {
  blockedJob,
  driverAgent,
  jobRow,
  jobsEnv,
  postGatedJob,
  seedCapsidNamespace,
} from "./jobs-fixture";

// The stale-jobs step (capsid/decisions.md, 2026-10-03, D1 to D3): a blocked job whose
// pull requests merged goes back to its holder, or to the queue when the holder cannot
// act, and is never completed. GitHub is not reachable from the test runtime, so the
// merge read is exercised by what happens when it fails; autoResumeJob takes the fact
// the read produces.

const ADMIN = grantAgent("write", "github:DrDustinEdwards");
const NOW = new Date("2026-10-08T06:00:00.000Z");
const LATER = new Date("2026-10-08T07:00:00.000Z");
// How a job blocks on its merge.
const MERGE_BLOCK = { reason: "waiting on the merge", command: "Merge PR 9" };
const NOTE = "PR #9 merged at abc1234; confirm the deploy and complete with your claim";

async function touches(id: string) {
  const { results } = await env.DB.prepare(
    "SELECT kind, actor, actor_kind FROM job_touches WHERE job_id = ?1 AND actor = ?2 ORDER BY id",
  )
    .bind(id, MERGE_RESUME_ACTOR)
    .all<{ kind: string; actor: string; actor_kind: string }>();
  return results ?? [];
}

beforeEach(async () => {
  await resetCapsidDb();
  await seedCapsidNamespace();
});

describe("autoResumeJob", () => {
  it("returns a blocked job to its holder with a system touch and the note, and does not complete it", async () => {
    const driver = driverAgent();
    const id = await blockedJob(ADMIN, driver, NOW, "merged and waiting", MERGE_BLOCK);
    const job = (await readJob(env.DB, id))!;

    const out = await autoResumeJob(jobsEnv(), LATER, job, NOTE);
    expect(out).toEqual({ resumed: true, to: "holder" });
    const r = await jobRow(id);
    expect(r?.status).toBe("claimed");
    expect(r?.claimed_by).toBe("agent:capsid-driver");
    expect(r?.resumed_count).toBe(1);
    expect(await touches(id)).toEqual([
      { kind: "resume", actor: MERGE_RESUME_ACTOR, actor_kind: "system" },
      { kind: "note", actor: MERGE_RESUME_ACTOR, actor_kind: "system" },
    ]);
    const outcomes = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM job_outcomes WHERE job_id = ?1",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(outcomes?.n).toBe(0);
  });

  it("queues the job when its holder is revoked", async () => {
    const driver = driverAgent();
    const id = await blockedJob(ADMIN, driver, NOW, "holder revoked", MERGE_BLOCK);
    await env.DB.prepare(
      "INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, revoked_at) VALUES (?1, ?2, 'driver', ?3, ?4, 'github:sample', ?5)",
    )
      .bind(
        "agent_revoked1",
        "capsid-driver",
        "hash",
        JSON.stringify(driver.scopes),
        LATER.toISOString(),
      )
      .run();
    const out = await autoResumeJob(jobsEnv(), LATER, (await readJob(env.DB, id))!, NOTE);
    expect(out).toEqual({ resumed: true, to: "queue" });
    const r = await jobRow(id);
    expect(r?.status).toBe("queued");
    expect(r?.claimed_by).toBeNull();
  });

  it("queues the job when its holder is a shared identity", async () => {
    const id = await blockedJob(ADMIN, ADMIN, NOW, "holder shared", MERGE_BLOCK);
    const out = await autoResumeJob(jobsEnv(), LATER, (await readJob(env.DB, id))!, NOTE);
    expect(out.to).toBe("queue");
    expect((await jobRow(id))?.status).toBe("queued");
  });

  it("returns the job to its holder even when the holder holds another claim: there is no claim limit", async () => {
    const driver = driverAgent();
    const id = await blockedJob(ADMIN, driver, NOW, "holder busy", MERGE_BLOCK);
    expect(
      (
        await claimJob(jobsEnv(), driver, NOW, {
          id: await postGatedJob(ADMIN, NOW, "the driver moved on"),
        })
      ).ok,
    ).toBe(true);
    const out = await autoResumeJob(jobsEnv(), LATER, (await readJob(env.DB, id))!, NOTE);
    expect(out.to).toBe("holder");
    expect((await jobRow(id))?.status).toBe("claimed");
  });

  it("writes nothing when the job moved after it was read", async () => {
    const driver = driverAgent();
    const id = await blockedJob(ADMIN, driver, NOW, "moved first", MERGE_BLOCK);
    const stale = (await readJob(env.DB, id))!;
    await env.DB.prepare("UPDATE jobs SET updated_at = '2026-10-08T06:30:00.000Z' WHERE id = ?1")
      .bind(id)
      .run();
    expect(await autoResumeJob(jobsEnv(), LATER, stale, NOTE)).toEqual({
      resumed: false,
      to: "holder",
    });
    expect((await jobRow(id))?.status).toBe("blocked");
    expect(await touches(id)).toEqual([]);
  });
});

describe("mergeResumeTick", () => {
  it("leaves a blocked job alone when its pull request cannot be read as merged", async () => {
    const driver = driverAgent();
    const id = await postGatedJob(ADMIN, NOW, "names an unreadable pull request");
    expect((await claimJob(jobsEnv(), driver, NOW, { id })).ok).toBe(true);
    expect(
      (
        await blockJob(jobsEnv(), driver, NOW, id, {
          reason: "PR https://github.com/example/capsid/pull/9 is open",
          command: "Merge PR 9",
        })
      ).ok,
    ).toBe(true);
    const report = await mergeResumeTick(jobsEnv(), LATER);
    expect(report.looked).toBe(1);
    expect(report.resumed).toEqual([]);
    expect((await jobRow(id))?.status).toBe("blocked");
  });

  it("does not look at a blocked job that names no pull request", async () => {
    await blockedJob(ADMIN, driverAgent(), NOW, "no pull request named", MERGE_BLOCK);
    expect((await mergeResumeTick(jobsEnv(), LATER)).looked).toBe(0);
  });

  it("skips a job it already resumed once", async () => {
    const driver = driverAgent();
    const id = await postGatedJob(ADMIN, NOW, "blocks again after the merge");
    expect((await claimJob(jobsEnv(), driver, NOW, { id })).ok).toBe(true);
    expect(
      (
        await blockJob(jobsEnv(), driver, NOW, id, {
          reason: "PR https://github.com/example/capsid/pull/9",
          command: "Merge PR 9",
        })
      ).ok,
    ).toBe(true);
    await autoResumeJob(jobsEnv(), LATER, (await readJob(env.DB, id))!, NOTE);
    expect(
      (
        await blockJob(jobsEnv(), driver, LATER, id, {
          reason: "PR https://github.com/example/capsid/pull/9 deployed? no",
          command: "wrangler deploy",
        })
      ).ok,
    ).toBe(true);
    expect((await mergeResumeTick(jobsEnv(), LATER)).looked).toBe(0);
  });
});
