import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../src/auth.ts";
import { defaultScopes, serializeScopes } from "../src/agents-schema.ts";
import { legacyAgent, resolveAgent, type Agent } from "../src/agents.ts";
import { mintAgent } from "../src/agents-admin.ts";
import { anomalyFindings } from "../src/anomaly.ts";
import { claimJob, postJob } from "../src/jobs.ts";
import { checkScope } from "../src/scope.ts";
import { fakeD1, fakeEnv } from "./fakes.ts";

// Per-job keys for unattended drivers (OWASP item 5; Dustin's D1 of 2026-10-03). The
// scheduler claims with the driver's long-lived key and session_key: true, and the job is
// handed to a key minted for it. src/job-session-key.ts says why.

const DRIVER_KEY = "capsid_agent_" + "d".repeat(64);
const DRIVER = "sample-driver";
const NOW = new Date("2026-10-10T09:00:00Z");
const ADMIN = legacyAgent("write", "access:dustin@example.com");

async function setup(kind = "driver") {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  scopes.repos = ["DrDustinEdwards/capsid"];
  const d1 = fakeD1({
    agents: [
      { id: "agent_dddddddddddd", name: DRIVER, kind, key_hash: await sha256Hex(DRIVER_KEY), scopes: serializeScopes(scopes), created_by: "access:dustin@example.com", created_at: "2026-10-01 00:00:00", revoked_at: null, last_seen: null, job_id: null },
    ],
  });
  const env = fakeEnv({ DB: d1.db, IMPROVE_SCORE_SECRET: "test-secret" });
  const resolved = await resolveAgent(new Request("https://capsid.example/ops/mcp", { headers: { Authorization: `Bearer ${DRIVER_KEY}` } }), env, NOW);
  assert.ok(resolved, "the driver key did not resolve");
  const post = async (title: string) => {
    const posted = await postJob(env, ADMIN, NOW, { namespace: "capsid", title, body: "do it", kind: "build" });
    assert.equal(posted.ok, true, JSON.stringify(posted));
    return posted.job!.id;
  };
  return { d1, env, driver: resolved.agent, post };
}

const bearer = (key: string) => new Request("https://capsid.example/ops/mcp", { headers: { Authorization: `Bearer ${key}` } });

test("claim with session_key hands the job to a key minted for it, which resolves bound to that job alone", async () => {
  const { d1, env, driver, post } = await setup();
  const id = await post("Build: one");
  const other = await post("Build: two");
  const claimed = await claimJob(env, driver, NOW, { id, sessionKey: true });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  const minted = claimed.session_key;
  assert.ok(minted, "no session key came back");
  assert.match(minted.name, new RegExp(`^${DRIVER}@${id}\\.[0-9a-f]{6}$`));
  assert.equal(claimed.job?.claimed_by, `agent:${minted.name}`);
  const row = d1.rows.agents.find((a) => a.name === minted.name);
  assert.deepEqual([row?.kind, row?.job_id, row?.created_by], ["session", id, `agent:${DRIVER}`]);
  assert.notEqual(row?.key_hash, minted.key, "the key itself was stored");

  const session = await resolveAgent(bearer(minted.key), env, NOW);
  assert.ok(session, "the session key did not resolve under its lease");
  assert.equal(session.agent.job, id);
  assert.deepEqual(session.agent.scopes.namespaces, driver.scopes.namespaces);
  assert.equal(checkScope(session.agent, { tool: "capsid_work_jobs", action: "heartbeat", namespace: "capsid", grant: "write", jobId: id }), null);
  assert.match(String(checkScope(session.agent, { tool: "capsid_work_jobs", action: "claim", namespace: "capsid", grant: "write", jobId: other })), /bound to job/);
});

test("PLANT: the driver's claim limit counts the job its session key holds", async () => {
  const { env, driver, post } = await setup();
  const first = await post("Build: one");
  const second = await post("Build: two");
  assert.equal((await claimJob(env, driver, NOW, { id: first, sessionKey: true })).ok, true);
  const again = await claimJob(env, driver, NOW, { id: second });
  assert.equal(again.ok, false, "a driver at its limit claimed a second job beside its session key's");
  assert.match(again.refusal ?? "", /already holds|limit|holds/);
});

test("PLANT: session_key is refused for anyone but a minted driver, and for a session key itself", async () => {
  const { env, post, driver } = await setup();
  const id = await post("Build: one");
  for (const caller of [ADMIN, legacyAgent("write", "opkey:abcdef012345")]) {
    const out = await claimJob(env, caller, NOW, { id, sessionKey: true });
    assert.equal(out.ok, false, caller.actor);
    assert.match(out.refusal ?? "", /minted driver/);
  }
  const seat = await setup("seat");
  const seatJob = await seat.post("Build: seat");
  assert.match((await claimJob(seat.env, seat.driver, NOW, { id: seatJob, sessionKey: true })).refusal ?? "", /minted driver/);
  const minted = (await claimJob(env, driver, NOW, { id, sessionKey: true })).session_key!;
  const session = (await resolveAgent(bearer(minted.key), env, NOW))!.agent as Agent;
  const out = await claimJob(env, session, NOW, { id, sessionKey: true });
  assert.equal(out.ok, false);
  assert.match(out.refusal ?? "", /minted driver/);
});

test("PLANT: no person can mint a name carrying the session-key mark", async () => {
  const { env } = await setup();
  const out = await mintAgent((env as { DB: D1Database }).DB, ADMIN.actor, { name: `${DRIVER}@job_aaaaaaaaaaaa.abcdef`, kind: "session", namespaces: ["sample"], repos: ["*"] });
  assert.equal(out.ok, false);
  assert.match(out.refusal ?? "", /may not contain '@'/);
});

test("a session key's audit rows are judged against its driver's baseline, so a new key each night is no first-use finding", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  const session = `agent:${DRIVER}@job_aaaaaaaaaaaa.abcdef`;
  const rows = [
    { actor: `agent:${DRIVER}`, action: "jobs.heartbeat", hour: "2026-10-01T15", n: 3 },
    // 04:00 Chicago, the scheduler's hour.
    { actor: session, action: "jobs.heartbeat", hour: "2026-10-10T09", n: 2 },
  ];
  assert.deepEqual(anomalyFindings(rows, now), []);
  // The same rows under a key with no driver mark are a first use at 04:00.
  const plain = rows.map((r) => (r.actor === session ? { ...r, actor: "agent:stranger" } : r));
  assert.deepEqual(anomalyFindings(plain, now).map((f) => f.fingerprint), ["anomaly-first-use-stranger"]);
});
