import { env } from "cloudflare:test";
import { resetCapsidDb } from "./reset-db";
import { beforeEach, describe, expect, it } from "vitest";
import { claimJob, resumeJob } from "../src/jobs";
import { grantAgent } from "../src/agents";
import {
  blockedJob,
  driverAgent,
  jobRow,
  jobsEnv,
  postGatedJob,
  seatAgent,
  seedCapsidNamespace,
} from "./jobs-fixture";

// Resume when the job cannot go back to the credential that blocked it: the credential
// is shared (the admin identity every chat tab connects as, or a legacy operator key)
// and so names no particular session. The job goes back to the queue with its approval,
// and the next free session claims it. A driver that holds other claims is no reason.

const ADMIN = grantAgent("write", "github:DrDustinEdwards");
const NOW = new Date("2026-09-26T06:00:00.000Z");
// How a job blocks on its push.
const PUSH_BLOCK = { reason: "waiting on the push", command: "git push -u origin feat/x" };
const LATER = new Date("2026-09-26T07:00:00.000Z");

async function resumedAudit(id: string) {
  const r = await env.DB.prepare(
    "SELECT params FROM audit_log WHERE action = 'job-resumed' AND params LIKE ?1 ORDER BY id DESC LIMIT 1",
  )
    .bind(`%${id}%`)
    .first<{ params: string }>();
  return r ? (JSON.parse(r.params) as Record<string, unknown>) : null;
}

beforeEach(async () => {
  await resetCapsidDb();
  await seedCapsidNamespace();
});

describe("resume to the queue", () => {
  it("a driver that holds another claim still gets its blocked job back: there is no claim limit", async () => {
    const driver = driverAgent();
    const blocked = await blockedJob(ADMIN, driver, NOW, "waiting on its driver", PUSH_BLOCK);
    expect(
      (
        await claimJob(jobsEnv(), driver, NOW, {
          id: await postGatedJob(ADMIN, NOW, "the driver moved on"),
        })
      ).ok,
    ).toBe(true);

    const resumed = await resumeJob(jobsEnv(), seatAgent(), LATER, blocked, "push approved", {
      note: "run it from the feature branch",
    });
    expect(resumed.ok, resumed.refusal).toBe(true);
    expect(resumed.note).toBeUndefined();
    const r = await jobRow(blocked);
    expect(r?.status).toBe("claimed");
    expect(r?.claimed_by).toBe("agent:capsid-driver");
    expect(r?.resumed_count).toBe(1);
    expect(await resumedAudit(blocked)).toMatchObject({
      approved: "push approved",
      held_by: "agent:capsid-driver",
    });
  });

  it("a job blocked by the shared admin identity goes back to the queue, not to that identity", async () => {
    const blocked = await blockedJob(ADMIN, ADMIN, NOW, "blocked from a chat tab", PUSH_BLOCK);
    const resumed = await resumeJob(jobsEnv(), ADMIN, LATER, blocked, "approved");
    expect(resumed.ok, resumed.refusal).toBe(true);
    expect((await jobRow(blocked))?.status).toBe("queued");
    expect(resumed.note).toMatch(/shared/);
    expect(await resumedAudit(blocked)).toMatchObject({
      approved: "approved",
      returned_to: "queued",
      previous_holder: ADMIN.actor,
    });

    const next = await claimJob(jobsEnv(), driverAgent("agent:capsid-driver-2"), LATER, {
      id: blocked,
    });
    expect(next.ok, next.refusal).toBe(true);
    expect(next.resume_note).toMatchObject({ reason: "approved", by: ADMIN.actor });
    // Measured from the first claim, not from this one.
    expect((await jobRow(blocked))?.claimed_at).toBe(NOW.toISOString());
  });

  it("take by a caller that already holds a claim is allowed: there is no claim limit", async () => {
    const blocked = await blockedJob(
      ADMIN,
      driverAgent(),
      NOW,
      "someone wants to take it",
      PUSH_BLOCK,
    );
    // A plain resume, take or not, is the seat's act, so the taker is the seat.
    const taker = seatAgent();
    expect(
      (
        await claimJob(jobsEnv(), taker, NOW, {
          id: await postGatedJob(ADMIN, NOW, "the taker is busy"),
        })
      ).ok,
    ).toBe(true);
    const taken = await resumeJob(jobsEnv(), taker, LATER, blocked, "approved", { take: true });
    expect(taken.ok, taken.refusal).toBe(true);
    expect((await jobRow(blocked))?.status).toBe("claimed");
    expect((await jobRow(blocked))?.claimed_by).toBe("agent:seat");
  });

  it("the driver's own gate still cannot be cleared by that driver with a plain resume", async () => {
    const driver = driverAgent();
    const blocked = await blockedJob(ADMIN, driver, NOW, "self-approval", PUSH_BLOCK);
    expect(
      (
        await claimJob(jobsEnv(), driver, NOW, {
          id: await postGatedJob(ADMIN, NOW, "busy elsewhere"),
        })
      ).ok,
    ).toBe(true);
    const refused = await resumeJob(jobsEnv(), driver, LATER, blocked, "I approve myself");
    expect(refused.ok).toBe(false);
    expect((await jobRow(blocked))?.status).toBe("blocked");
  });
});
