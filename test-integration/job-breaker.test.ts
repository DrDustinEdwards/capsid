import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { claimJob, failAsCaller, postJob } from "../src/jobs";
import { legacyAgent, type Agent } from "../src/agents";
import { defaultScopes } from "../src/agents-schema";
import { BREAKER_THRESHOLD_KEY, breakerResetKey, breakerState, resetBreaker } from "../src/job-breaker";

// The queue's circuit breaker (job_9e602b31888f, OWASP ASI08), against a real D1: the
// breaker is a count over audit_log, so what it counts is only true of the real rows.
// audit_log.at is the database's own clock, so these run on the real time.

const SECRET = "test-root-secret";
const POSTER = legacyAgent("write", "github:DrDustinEdwards");

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

function driverAgent(actor = "agent:capsid-driver", namespace = "capsid"): Agent {
  const scopes = defaultScopes([namespace]);
  scopes.grants = ["read", "write"];
  return { id: `agent_${actor.length}`, name: actor.slice("agent:".length), kind: "driver", actor, scopes, admin: false, row: null };
}

function seatAgent(): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  scopes.flags.can_merge = true;
  return { id: "agent_aaaabbbbcccc", name: "seat", kind: "seat", actor: "agent:seat", scopes, admin: false, row: null };
}

let n = 0;
async function post(namespace = "capsid"): Promise<string> {
  const posted = await postJob(jobsEnv(), POSTER, new Date(), { namespace, title: `job ${++n}`, body: "do the thing" });
  expect(posted.ok, posted.refusal).toBe(true);
  return posted.job!.id;
}

// A job its holder claimed and then failed: one `job-fail` audit row.
async function holderFails(driver: Agent, namespace = "capsid"): Promise<void> {
  const id = await post(namespace);
  const claimed = await claimJob(jobsEnv(), driver, new Date(), { id });
  expect(claimed.ok, claimed.refusal).toBe(true);
  const failed = await failAsCaller(jobsEnv(), driver, new Date(), id, "could not do it");
  expect(failed.ok, failed.refusal).toBe(true);
}

async function status(id: string) {
  return (await env.DB.prepare("SELECT status, claimed_by FROM jobs WHERE id = ?1").bind(id).first<{ status: string; claimed_by: string | null }>())!;
}

beforeEach(async () => {
  for (const table of ["jobs", "audit_log", "job_outcomes"]) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
  for (const ns of ["capsid", "sample"]) {
    await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
      .bind(ns, JSON.stringify([{ repo: `example/${ns}`, label: "primary" }]))
      .run();
    await env.APP_KV.delete(breakerResetKey(ns));
  }
  await env.APP_KV.delete(BREAKER_THRESHOLD_KEY);
});

describe("the queue's circuit breaker", () => {
  it("three holder fails in 24 hours stop the namespace's claims, and the job stays queued", async () => {
    const driver = driverAgent();
    for (let i = 0; i < 3; i++) await holderFails(driver);
    const waiting = await post();
    const refused = await claimJob(jobsEnv(), driver, new Date(), { namespace: "capsid" });
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/circuit breaker for capsid is open: 3 jobs failed/);
    expect(await status(waiting)).toEqual({ status: "queued", claimed_by: null });
    // A claim by id is refused the same way.
    expect((await claimJob(jobsEnv(), driverAgent("agent:capsid-driver-2"), new Date(), { id: waiting })).ok).toBe(false);
  });

  it("two fails do not open it", async () => {
    const driver = driverAgent();
    for (let i = 0; i < 2; i++) await holderFails(driver);
    await post();
    expect((await claimJob(jobsEnv(), driver, new Date(), { namespace: "capsid" })).ok).toBe(true);
  });

  it("a seat's admin fail is a person cleaning up, and does not count", async () => {
    for (let i = 0; i < 3; i++) {
      const id = await post();
      expect((await failAsCaller(jobsEnv(), seatAgent(), new Date(), id, "stale")).ok).toBe(true);
    }
    const state = await breakerState(jobsEnv(), "capsid", new Date());
    expect(state.failed).toBe(0);
    expect(state.open).toBe(false);
  });

  it("is per namespace: another namespace's fails do not stop this one", async () => {
    const other = driverAgent("agent:sample-driver", "sample");
    for (let i = 0; i < 3; i++) await holderFails(other, "sample");
    await post("capsid");
    expect((await claimJob(jobsEnv(), driverAgent(), new Date(), { namespace: "capsid" })).ok).toBe(true);
    expect((await breakerState(jobsEnv(), "sample", new Date())).open).toBe(true);
  });

  it("a reset closes it, is audited under the caller, and the next fails count afresh", async () => {
    const driver = driverAgent();
    for (let i = 0; i < 3; i++) await holderFails(driver);
    await post();
    // A reset stamped at least a second after the fails, since audit_log.at has whole seconds.
    const later = new Date(Date.now() + 2000);
    const reset = await resetBreaker(jobsEnv(), "access:admin@example.com", later, { namespace: "capsid" });
    expect(reset.ok).toBe(true);
    const audit = await env.DB.prepare("SELECT actor, params FROM audit_log WHERE action = 'job-breaker-reset'").first<{ actor: string; params: string }>();
    expect(audit?.actor).toBe("access:admin@example.com");
    expect(JSON.parse(audit!.params)).toMatchObject({ was_open: true, failed: 3, threshold: 3 });
    const state = await breakerState(jobsEnv(), "capsid", later);
    expect(state).toMatchObject({ open: false, failed: 0 });
    expect((await claimJob(jobsEnv(), driver, later, { namespace: "capsid" })).ok).toBe(true);
  });

  it("the threshold is settable, and a bad value keeps the default and says so", async () => {
    const driver = driverAgent();
    await holderFails(driver);
    const set = await resetBreaker(jobsEnv(), "access:admin@example.com", new Date(Date.now() - 60_000), { namespace: "capsid", threshold: 1 });
    expect(set.ok).toBe(true);
    expect((await breakerState(jobsEnv(), "capsid", new Date())).open).toBe(true);
    expect((await resetBreaker(jobsEnv(), "access:admin@example.com", new Date(), { namespace: "capsid", threshold: 0 })).ok).toBe(false);
    await env.APP_KV.put(BREAKER_THRESHOLD_KEY, "lots");
    const state = await breakerState(jobsEnv(), "capsid", new Date());
    expect(state.threshold).toBe(3);
    expect(state.note).toMatch(/not a whole number/);
  });
});
