import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { adminFailJob, claimJob, failAsCaller, postJob, releaseJob } from "../src/jobs";
import { legacyAgent, type Agent } from "../src/agents";
import { defaultScopes } from "../src/agents-schema";

// The seat stepping in on a claimed job whose holder is gone: release it to the queue,
// or fail it. Against a real D1, because both are one guarded batch keyed on the holder
// the seat read, and every assertion reads the rows back.

const SECRET = "test-root-secret";
const POSTER = legacyAgent("write", "github:DrDustinEdwards");
const NOW = new Date("2026-09-26T06:00:00.000Z");
const LATER = new Date("2026-09-26T07:00:00.000Z");

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

// The seat as it is minted: write and can_merge, and not the admin.
function seatAgent(): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  scopes.flags.can_merge = true;
  return { id: "agent_aaaabbbbcccc", name: "seat", kind: "seat", actor: "agent:seat", scopes, admin: false, row: null };
}

// A roster driver: one namespace, write, and no flags.
function driverAgent(actor = "agent:capsid-driver"): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  return { id: `agent_${actor.length}`, name: actor.slice("agent:".length), kind: "driver", actor, scopes, admin: false, row: null };
}

async function claimedJob(holder: Agent, title = "a job whose holder went away"): Promise<string> {
  const posted = await postJob(jobsEnv(), POSTER, NOW, { namespace: "capsid", title, body: "do the thing" });
  expect(posted.ok, posted.refusal).toBe(true);
  const claimed = await claimJob(jobsEnv(), holder, NOW, { id: posted.job!.id });
  expect(claimed.ok, claimed.refusal).toBe(true);
  return posted.job!.id;
}

async function row(id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<Record<string, unknown>>();
}

async function audit(id: string, action: string) {
  return env.DB.prepare("SELECT actor, params FROM audit_log WHERE action = ?1 AND params LIKE ?2 ORDER BY id DESC LIMIT 1")
    .bind(action, `%${id}%`)
    .first<{ actor: string; params: string }>();
}

async function outcome(id: string) {
  return env.DB.prepare("SELECT agent, result_kind FROM job_outcomes WHERE job_id = ?1").bind(id).first<{ agent: string; result_kind: string }>();
}

beforeEach(async () => {
  for (const table of ["jobs", "audit_log", "job_outcomes"]) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
    .bind("capsid", JSON.stringify([{ repo: "example/capsid", label: "primary" }]))
    .run();
});

describe("release", () => {
  it("the seat returns a job another credential holds to the queue, with an audit row and no outcome row", async () => {
    const id = await claimedJob(driverAgent());
    const released = await releaseJob(jobsEnv(), seatAgent(), LATER, id, "no driver session is running");
    expect(released.ok, released.refusal).toBe(true);

    const r = await row(id);
    expect(r?.status).toBe("queued");
    expect(r?.claimed_by).toBeNull();
    expect(r?.lease_expires).toBeNull();
    const a = await audit(id, "job-released");
    expect(a?.actor).toBe("agent:seat");
    expect(JSON.parse(a!.params)).toMatchObject({ reason: "no driver session is running", held_by: "agent:capsid-driver" });
    // Not an ending, so nothing is attributed to the credential that held it.
    expect(await outcome(id)).toBeNull();
  });

  it("a released job is claimable, and keeps the time of its first claim", async () => {
    const id = await claimedJob(driverAgent());
    expect((await releaseJob(jobsEnv(), seatAgent(), LATER, id, "holder gone")).ok).toBe(true);
    const next = await claimJob(jobsEnv(), driverAgent("agent:capsid-driver-2"), LATER, { id });
    expect(next.ok, next.refusal).toBe(true);
    expect((await row(id))?.claimed_by).toBe("agent:capsid-driver-2");
    expect((await row(id))?.claimed_at).toBe(NOW.toISOString());
  });

  it("a driver cannot release another driver's job", async () => {
    const id = await claimedJob(driverAgent());
    const refused = await releaseJob(jobsEnv(), driverAgent("agent:capsid-driver-2"), LATER, id, "mine now");
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/seat/);
    expect((await row(id))?.claimed_by).toBe("agent:capsid-driver");
  });

  it("the holder cannot release its own job, and only a claimed job is released", async () => {
    const seat = seatAgent();
    const own = await claimedJob(seat, "held by the seat");
    expect((await releaseJob(jobsEnv(), seat, LATER, own, "x")).refusal).toMatch(/held by agent:seat itself/);

    const posted = await postJob(jobsEnv(), POSTER, NOW, { namespace: "capsid", title: "still queued", body: "b" });
    const queued = await releaseJob(jobsEnv(), seat, LATER, posted.job!.id, "x");
    expect(queued.ok).toBe(false);
    expect(queued.refusal).toMatch(/is queued, not claimed/);
  });

  it("release needs a reason", async () => {
    const id = await claimedJob(driverAgent());
    expect((await releaseJob(jobsEnv(), seatAgent(), LATER, id, "  ")).refusal).toMatch(/needs a reason/);
    expect((await row(id))?.status).toBe("claimed");
  });
});

describe("the seat fails a job it does not hold", () => {
  it("fail through the tool path, by a can_merge seat, fails the holder's job and records the holder's outcome", async () => {
    const id = await claimedJob(driverAgent());
    const failed = await failAsCaller(jobsEnv(), seatAgent(), LATER, id, "the work was abandoned");
    expect(failed.ok, failed.refusal).toBe(true);
    expect((await row(id))?.status).toBe("failed");
    expect((await audit(id, "job-admin-fail"))?.actor).toBe("agent:seat");
    expect(await outcome(id)).toMatchObject({ agent: "agent:capsid-driver" });
  });

  it("a driver still cannot fail another driver's job", async () => {
    const id = await claimedJob(driverAgent());
    const refused = await failAsCaller(jobsEnv(), driverAgent("agent:capsid-driver-2"), LATER, id, "x");
    expect(refused.ok).toBe(false);
    expect((await row(id))?.status).toBe("claimed");
    expect((await adminFailJob(jobsEnv(), driverAgent("agent:capsid-driver-2"), LATER, id, "x")).ok).toBe(false);
  });

  it("the holder failing its own job through the same path is an ordinary fail", async () => {
    const driver = driverAgent();
    const id = await claimedJob(driver);
    const failed = await failAsCaller(jobsEnv(), driver, LATER, id, "could not do it");
    expect(failed.ok, failed.refusal).toBe(true);
    expect(failed.action).toBe("fail");
    expect(await audit(id, "job-admin-fail")).toBeNull();
  });
});
