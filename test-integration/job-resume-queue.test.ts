import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { blockJob, claimJob, postJob, resumeJob } from "../src/jobs";
import { legacyAgent, type Agent } from "../src/agents";
import { defaultScopes } from "../src/agents-schema";

// Resume when the job cannot go back to the credential that blocked it: the credential
// is shared (the admin identity every chat tab connects as, or a legacy operator key)
// and so names no particular session. The job goes back to the queue with its approval,
// and the next free session claims it. A driver that holds other claims is no reason.

const SECRET = "test-root-secret";
const ADMIN = legacyAgent("write", "github:DrDustinEdwards");
const NOW = new Date("2026-09-26T06:00:00.000Z");
const LATER = new Date("2026-09-26T07:00:00.000Z");

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

function seatAgent(): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  scopes.flags.can_merge = true;
  return { id: "agent_aaaabbbbcccc", name: "seat", kind: "seat", actor: "agent:seat", scopes, admin: false, row: null };
}

function driverAgent(actor = "agent:capsid-driver"): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  return { id: `agent_${actor.length}`, name: actor.slice("agent:".length), kind: "driver", actor, scopes, admin: false, row: null };
}

async function post(title: string): Promise<string> {
  const posted = await postJob(jobsEnv(), ADMIN, NOW, { namespace: "capsid", title, body: "do the thing", gate_required: true });
  expect(posted.ok, posted.refusal).toBe(true);
  return posted.job!.id;
}

async function blockedBy(holder: Agent, title: string): Promise<string> {
  const id = await post(title);
  expect((await claimJob(jobsEnv(), holder, NOW, { id })).ok).toBe(true);
  expect((await blockJob(jobsEnv(), holder, NOW, id, { reason: "waiting on the push", command: "git push -u origin feat/x" })).ok).toBe(true);
  return id;
}

async function row(id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<Record<string, unknown>>();
}

async function resumedAudit(id: string) {
  const r = await env.DB.prepare("SELECT params FROM audit_log WHERE action = 'job-resumed' AND params LIKE ?1 ORDER BY id DESC LIMIT 1")
    .bind(`%${id}%`)
    .first<{ params: string }>();
  return r ? (JSON.parse(r.params) as Record<string, unknown>) : null;
}

beforeEach(async () => {
  for (const table of ["jobs", "audit_log", "job_outcomes"]) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
    .bind("capsid", JSON.stringify([{ repo: "example/capsid", label: "primary" }]))
    .run();
});

describe("resume to the queue", () => {
  it("a driver that holds another claim still gets its blocked job back: there is no claim limit", async () => {
    const driver = driverAgent();
    const blocked = await blockedBy(driver, "waiting on its driver");
    expect((await claimJob(jobsEnv(), driver, NOW, { id: await post("the driver moved on") })).ok).toBe(true);

    const resumed = await resumeJob(jobsEnv(), seatAgent(), LATER, blocked, "push approved", { note: "run it from the feature branch" });
    expect(resumed.ok, resumed.refusal).toBe(true);
    expect(resumed.note).toBeUndefined();
    const r = await row(blocked);
    expect(r?.status).toBe("claimed");
    expect(r?.claimed_by).toBe("agent:capsid-driver");
    expect(r?.resumed_count).toBe(1);
    expect(await resumedAudit(blocked)).toMatchObject({ approved: "push approved", held_by: "agent:capsid-driver" });
  });

  it("a job blocked by the shared admin identity goes back to the queue, not to that identity", async () => {
    const blocked = await blockedBy(ADMIN, "blocked from a chat tab");
    const resumed = await resumeJob(jobsEnv(), ADMIN, LATER, blocked, "approved");
    expect(resumed.ok, resumed.refusal).toBe(true);
    expect((await row(blocked))?.status).toBe("queued");
    expect(resumed.note).toMatch(/shared/);
    expect(await resumedAudit(blocked)).toMatchObject({ approved: "approved", returned_to: "queued", previous_holder: ADMIN.actor });

    const next = await claimJob(jobsEnv(), driverAgent("agent:capsid-driver-2"), LATER, { id: blocked });
    expect(next.ok, next.refusal).toBe(true);
    expect(next.resume_note).toMatchObject({ reason: "approved", by: ADMIN.actor });
    // Measured from the first claim, not from this one.
    expect((await row(blocked))?.claimed_at).toBe(NOW.toISOString());
  });

  it("a free minted driver gets its job back, as before", async () => {
    const driver = driverAgent();
    const blocked = await blockedBy(driver, "its driver is free");
    const resumed = await resumeJob(jobsEnv(), seatAgent(), LATER, blocked, "approved");
    expect(resumed.ok, resumed.refusal).toBe(true);
    expect((await row(blocked))?.status).toBe("claimed");
    expect((await row(blocked))?.claimed_by).toBe("agent:capsid-driver");
  });

  it("take by a caller that already holds a claim is allowed: there is no claim limit", async () => {
    const blocked = await blockedBy(driverAgent(), "someone wants to take it");
    // A plain resume, take or not, is the seat's act, so the taker is the seat.
    const taker = seatAgent();
    expect((await claimJob(jobsEnv(), taker, NOW, { id: await post("the taker is busy") })).ok).toBe(true);
    const taken = await resumeJob(jobsEnv(), taker, LATER, blocked, "approved", { take: true });
    expect(taken.ok, taken.refusal).toBe(true);
    expect((await row(blocked))?.status).toBe("claimed");
    expect((await row(blocked))?.claimed_by).toBe("agent:seat");
  });

  it("the driver's own gate still cannot be cleared by that driver with a plain resume", async () => {
    const driver = driverAgent();
    const blocked = await blockedBy(driver, "self-approval");
    expect((await claimJob(jobsEnv(), driver, NOW, { id: await post("busy elsewhere") })).ok).toBe(true);
    const refused = await resumeJob(jobsEnv(), driver, LATER, blocked, "I approve myself");
    expect(refused.ok).toBe(false);
    expect((await row(blocked))?.status).toBe("blocked");
  });
});
