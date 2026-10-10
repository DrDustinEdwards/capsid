import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { defaultScopes, type ScopeFlag } from "../src/agents-schema.ts";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import { recordAsCaller } from "../src/jobs.ts";
import { buildServer } from "../src/server.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// The jobs "record" action (src/jobs-seat.ts recordAsCaller, src/jobs-holder.ts records
// mode and recordRefusal), served as capsid_work_jobs action record: the seat writing
// the outcome of work done on a QUEUED job nobody claimed. The seat only, a queued
// unheld job only, and the transition writes its audit row in the same batch.

const NOW = new Date("2026-10-10T12:00:00.000Z");
const ID = "job_0123456789ab";
const ADMIN = adminAgentForEmail("admin@example.com");

function job(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    namespace: "sample",
    title: "Sample job",
    body: "Do the sample work.",
    posted_by: "agent:sample-poster",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

// The row-backed fake D1, with one rewrite: the transition's summary_sig CASE, which
// test/fake-sql.ts does not model, becomes the branch SQLite takes for a non-null
// result_summary (every call below sends one, and the record path refuses a blank one
// before it writes). Nothing else in the batch is touched.
function store(jobs: Array<Record<string, unknown>>) {
  const d1 = fakeD1({ namespaces: [{ namespace: "sample", repos: JSON.stringify([{ repo: "o/r", label: "primary" }]) }], jobs });
  const inner = d1.db;
  const db = {
    prepare: (sql: string) => inner.prepare(sql),
    batch: (statements: Array<{ sql: string; params: unknown[] }>) =>
      inner.batch(
        statements.map((s) => ({ ...s, sql: s.sql.replace(/summary_sig = CASE WHEN \?3 IS NULL THEN summary_sig ELSE \?9 END/, "summary_sig = ?9") })) as unknown as D1PreparedStatement[]
      ),
  } as unknown as D1Database;
  return { d1, env: fakeEnv({ DB: db, APP_KV: fakeKv({}).kv }) };
}

function driver(grant: ScopeFlag[] = [], namespaces = ["sample"]): Agent {
  const scopes = defaultScopes(namespaces);
  scopes.grants = ["read", "write"];
  for (const flag of grant) scopes.flags[flag] = true;
  return { id: "agent_0123456789ab", name: "sample-driver", kind: "driver", actor: "agent:sample-driver", scopes, admin: false, row: null };
}

const ARGS = { result_summary: "Done by hand in the sample repo.", raw: { result_summary: "Done by hand in the sample repo." } };

// The seat records

test("THE INNOCENT DIRECTION: the seat records an outcome on a queued job without a claim", async () => {
  const { d1, env } = store([job()]);
  const r = await recordAsCaller(env, ADMIN, NOW, ID, ARGS);
  assert.equal(r.ok, true, r.refusal);
  const row = d1.rows.jobs.find((j) => j.id === ID);
  assert.equal(row?.status, "done");
  assert.equal(row?.claimed_by, ADMIN.actor, "the recorder is not credited as the job's holder");
  assert.equal(row?.result_summary, ARGS.result_summary);
  assert.equal(row?.updated_at, NOW.toISOString());
  assert.equal(d1.rows.job_outcomes.length, 1, "no outcome row was written");
  assert.equal(d1.rows.job_outcomes[0].job_id, ID);
  assert.equal(d1.rows.job_outcomes[0].agent, ADMIN.actor);
  assert.equal(r.outcome?.row.job_id, ID);
});

test("an audit row naming the record is written with the transition", async () => {
  const { d1, env } = store([job()]);
  const r = await recordAsCaller(env, ADMIN, NOW, ID, ARGS);
  assert.equal(r.ok, true, r.refusal);
  const audit = d1.rows.audit_log as Array<Record<string, unknown>>;
  const records = audit.filter((a) => a.action === "job-record");
  assert.ok(records.length >= 1, `no job-record audit row: ${JSON.stringify(audit.map((a) => a.action))}`);
  const transition = records.find((a) => /"status":"done"/.test(String(a.params)));
  assert.ok(transition, "no audit row records the status the job moved to");
  assert.equal(transition.actor, ADMIN.actor);
  assert.equal(transition.namespace, "sample");
  assert.match(String(transition.params), /"result_summary":"Done by hand in the sample repo\."/);
});

test("THE INNOCENT DIRECTION: a can_merge caller is the seat too, and may record", async () => {
  const { d1, env } = store([job()]);
  const seat = driver(["can_merge"]);
  const r = await recordAsCaller(env, seat, NOW, ID, ARGS);
  assert.equal(r.ok, true, r.refusal);
  assert.equal(d1.rows.jobs[0].claimed_by, seat.actor);
});

// A non-seat caller

test("PLANT: a driver that is not the seat is refused, and nothing is written", async () => {
  const { d1, env } = store([job()]);
  const r = await recordAsCaller(env, driver(), NOW, ID, ARGS);
  assert.equal(r.ok, false);
  assert.match(r.refusal ?? "", /agent:sample-driver may not record an outcome without a claim/);
  assert.equal(d1.rows.jobs[0].status, "queued");
  assert.equal(d1.rows.jobs[0].claimed_by, null);
  assert.deepEqual(d1.recorded, [], "a refused record committed a write");
  assert.equal(d1.rows.audit_log.length, 0);
  assert.equal(d1.rows.job_outcomes.length, 0);
});

test("PLANT: a seat key scoped to another namespace is refused the job", async () => {
  const { d1, env } = store([job()]);
  const r = await recordAsCaller(env, driver(["can_merge"], ["sample-other"]), NOW, ID, ARGS);
  assert.equal(r.ok, false);
  assert.match(r.refusal ?? "", /cannot record job_0123456789ab \('Sample job'\)/);
  assert.deepEqual(d1.recorded, []);
});

// A job that is not queued

const NOT_QUEUED: Array<[string, Record<string, unknown>, RegExp]> = [
  ["claimed", { status: "claimed", claimed_by: "agent:sample-driver", lease_expires: "2026-10-10T14:00:00.000Z" }, /is claimed by agent:sample-driver: its holder completes it/],
  ["blocked", { status: "blocked", claimed_by: "agent:sample-driver" }, /is blocked: the seat completes a blocked job with action complete/],
  ["done", { status: "done", claimed_by: "agent:sample-driver" }, /is done; record is for a queued job/],
  ["failed", { status: "failed", claimed_by: "agent:sample-driver" }, /is failed; record is for a queued job/],
  ["superseded", { status: "superseded" }, /is superseded; record is for a queued job/],
  ["parked", { status: "parked" }, /is parked; record is for a queued job/],
];

for (const [status, over, refusal] of NOT_QUEUED) {
  test(`PLANT: the seat is refused a ${status} job, and nothing is written`, async () => {
    const { d1, env } = store([job(over)]);
    const before = structuredClone(d1.rows.jobs);
    const r = await recordAsCaller(env, ADMIN, NOW, ID, ARGS);
    assert.equal(r.ok, false, `a ${status} job was recorded`);
    assert.match(r.refusal ?? "", refusal);
    assert.deepEqual(d1.rows.jobs, before, `the ${status} job changed`);
    assert.deepEqual(d1.recorded, []);
    assert.equal(d1.rows.audit_log.length, 0);
    assert.equal(d1.rows.job_outcomes.length, 0);
  });
}

test("PLANT: a missing job is refused", async () => {
  const { d1, env } = store([]);
  const r = await recordAsCaller(env, ADMIN, NOW, ID, ARGS);
  assert.equal(r.ok, false);
  assert.match(r.refusal ?? "", /no job job_0123456789ab/);
  assert.deepEqual(d1.recorded, []);
});

test("PLANT: a blank result_summary is refused before anything is written", async () => {
  const { d1, env } = store([job()]);
  const r = await recordAsCaller(env, ADMIN, NOW, ID, { result_summary: "   " });
  assert.equal(r.ok, false);
  assert.match(r.refusal ?? "", /needs a result_summary/);
  assert.deepEqual(d1.recorded, []);
});

// Served: capsid_work_jobs action record

async function callAs(env: never, caller: Agent, args: Record<string, unknown>) {
  const server = buildServer(env, caller);
  const client = new Client({ name: "jobs-record", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name: "capsid_work_jobs", arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: result.isError === true, text: result.content.map((c) => c.text).join("\n") };
  } finally {
    await client.close();
    await server.close();
  }
}

test("PLANT: capsid_work_jobs action record refuses a driver, and the job stays queued", async () => {
  const { d1, env } = store([job()]);
  const r = await callAs(env, driver(), { action: "record", namespace: "sample", id: ID, result_summary: ARGS.result_summary });
  assert.match(r.text, /may not record an outcome without a claim/);
  assert.equal(d1.rows.jobs[0].status, "queued");
  assert.equal(d1.rows.audit_log.length, 0);
});

test("THE INNOCENT DIRECTION: capsid_work_jobs action record records for the admin", async () => {
  const { d1, env } = store([job()]);
  const r = await callAs(env, ADMIN, { action: "record", namespace: "sample", id: ID, result_summary: ARGS.result_summary });
  assert.doesNotMatch(r.text, /may not record|unauthorized:/, r.text);
  assert.equal(d1.rows.jobs[0].status, "done", r.text);
  assert.ok((d1.rows.audit_log as Array<Record<string, unknown>>).some((a) => a.action === "job-record"));
});

test("capsid_work_jobs action record without an id is refused before anything is read", async () => {
  const { d1, env } = store([job()]);
  const r = await callAs(env, ADMIN, { action: "record", namespace: "sample", result_summary: ARGS.result_summary });
  assert.match(r.text, /record needs the job id/);
  assert.deepEqual(d1.recorded, []);
});
