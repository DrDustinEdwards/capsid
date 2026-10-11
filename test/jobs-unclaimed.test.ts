import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultScopes } from "../src/agents-schema.ts";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import { beginJob, completeAsCaller, listJobs } from "../src/jobs.ts";
import { opsJobFrom, type JobFeedRow } from "../src/ops-feed.ts";
import { signTaskBody } from "../src/improve-task.ts";
import { fakeD1, fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// The pull request is the claim (job_e68de044f8a4; Dustin, 2026-10-10, plan step 2).
// A cloud session signs in as the admin login, which may hold one claim, so it works a
// job without claiming it. Two things make that work: complete takes a QUEUED job from
// any caller holding write on its namespace when it names the job's pull request
// (src/jobs-seat.ts completeUnclaimed), and begin marks a queued job started, a label
// and not a lease (src/jobs-begin.ts).

const NOW = new Date("2026-10-11T12:00:00.000Z");
const LATER = new Date("2026-10-11T12:30:00.000Z");
const ID = "job_0123456789ab";
const PR = "https://github.com/o/r/pull/7";
// A cloud session: the admin login, as every cloud session signs in.
const CLOUD = adminAgentForEmail("admin@example.com");
const SECRET = "test-improve-secret";
// The body as post leaves it: signed, so begin verifies it as claim does.
const BODY = await signTaskBody(SECRET, "Do the sample work.");

function job(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    namespace: "sample",
    title: "Sample job",
    body: BODY,
    posted_by: "agent:sample-poster",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

// The row-backed fake D1, with the one rewrite test/jobs-record.test.ts makes: the
// transition's summary_sig CASE, which test/fake-sql.ts does not model, becomes the branch
// SQLite takes for a non-null result_summary.
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
  return { d1, env: fakeEnv({ DB: db, APP_KV: fakeKv({}).kv, IMPROVE_SCORE_SECRET: SECRET }) };
}

// A driver with read and write on the namespace and no seat flag.
function driver(namespaces = ["sample"], name = "sample-driver"): Agent {
  const scopes = defaultScopes(namespaces);
  scopes.grants = ["read", "write"];
  return { id: "agent_0123456789ab", name, kind: "driver", actor: `agent:${name}`, scopes, admin: false, row: null };
}

const SUMMARY = "Did the sample work in one pull request.";
const withPr = { result_summary: SUMMARY, result_ref: PR, raw: { result_summary: SUMMARY, result_ref: PR } };

// GitHub is unreachable here: every read gets a 500. Verification and the overlap check
// report that as notes and never fail the call, as on a real complete.
async function offline<T>(fn: () => Promise<T>): Promise<T> {
  let out: T | undefined;
  await withFetch({}, async () => {
    out = await fn();
  });
  return out as T;
}

// claimless complete

test("a cloud session completes a queued job it never claimed by naming its pull request, and is credited", async () => {
  const { d1, env } = store([job()]);
  const r = await offline(() => completeAsCaller(env, CLOUD, NOW, ID, withPr));
  assert.equal(r.ok, true, r.refusal);
  const row = d1.rows.jobs.find((j) => j.id === ID);
  assert.equal(row?.status, "done");
  assert.equal(row?.claimed_by, CLOUD.actor, "the caller is not credited as the job's holder");
  assert.equal(row?.result_ref, PR, "the pull request is not recorded against the job, so pr_recorded_for_job could not pass");
  assert.equal(d1.rows.job_outcomes.length, 1, "no outcome row was written");
  assert.equal(d1.rows.job_outcomes[0].agent, CLOUD.actor);
  const audit = d1.rows.audit_log as Array<Record<string, unknown>>;
  assert.ok(audit.some((a) => /"status":"done"/.test(String(a.params))), "no audit row records the close");
});

test("a driver with write and no seat flag completes a queued job the same way", async () => {
  const { d1, env } = store([job()]);
  const caller = driver();
  const r = await offline(() =>
    completeAsCaller(env, caller, NOW, ID, { result_summary: SUMMARY, evidence: { prs: [PR] }, raw: { result_summary: SUMMARY } })
  );
  assert.equal(r.ok, true, r.refusal);
  assert.equal(d1.rows.jobs[0].status, "done");
  assert.equal(d1.rows.jobs[0].claimed_by, caller.actor);
  assert.equal(d1.rows.job_outcomes[0].agent, caller.actor);
});

test("PLANT: a queued job completed without a pull request is refused, and nothing is written", async () => {
  const { d1, env } = store([job()]);
  for (const ref of [undefined, "sample/notes/done.md"]) {
    const r = await offline(() => completeAsCaller(env, CLOUD, NOW, ID, { result_summary: SUMMARY, result_ref: ref, raw: { result_summary: SUMMARY } }));
    assert.equal(r.ok, false, `completed with result_ref ${ref}`);
    assert.match(r.refusal ?? "", /the pull request is the claim/);
  }
  assert.equal(d1.rows.jobs[0].status, "queued");
  assert.equal(d1.rows.jobs[0].claimed_by, null);
  assert.deepEqual(d1.recorded, []);
  assert.equal(d1.rows.job_outcomes.length, 0);
});

test("PLANT: a caller without write on the job's namespace is refused, and nothing is written", async () => {
  const { d1, env } = store([job()]);
  const r = await offline(() => completeAsCaller(env, driver(["sample-other"]), NOW, ID, withPr));
  assert.equal(r.ok, false);
  assert.match(r.refusal ?? "", /cannot complete job_0123456789ab \('Sample job'\)/);
  assert.deepEqual(d1.recorded, []);
});

test("PLANT: a pull request on a repo the namespace does not map is refused, and nothing is written", async () => {
  const { d1, env } = store([job()]);
  const other = "https://github.com/someone/unrelated/pull/1";
  for (const args of [
    { result_summary: SUMMARY, result_ref: other },
    { result_summary: SUMMARY, result_ref: PR, evidence: { prs: [other] } },
  ]) {
    const r = await offline(() => completeAsCaller(env, CLOUD, NOW, ID, { ...args, raw: { result_summary: SUMMARY } }));
    assert.equal(r.ok, false, `completed naming ${other}`);
    assert.match(r.refusal ?? "", /is not on a repo mapped to sample/);
  }
  assert.equal(d1.rows.jobs[0].status, "queued");
  assert.deepEqual(d1.recorded, []);
});

test("PLANT: what a claim asks of the caller is asked without one: required_flags and min_record", async () => {
  const flagged = store([job({ required_scopes: JSON.stringify({ flags: ["can_touch_protected"] }) })]);
  const noFlag = await offline(() => completeAsCaller(flagged.env, driver(), NOW, ID, withPr));
  assert.equal(noFlag.ok, false);
  assert.match(noFlag.refusal ?? "", /without a claim: .*can_touch_protected/);
  assert.deepEqual(flagged.d1.recorded, []);
  const record = store([job({ min_record: JSON.stringify({ prs_merged: 5 }) })]);
  const short = await offline(() => completeAsCaller(record.env, driver(), NOW, ID, withPr));
  assert.equal(short.ok, false);
  assert.match(short.refusal ?? "", /A claim would have refused it too/);
  assert.deepEqual(record.d1.recorded, []);
});

test("the close is audited as complete-unclaimed, not as the seat's record", async () => {
  const { d1, env } = store([job()]);
  await offline(() => completeAsCaller(env, CLOUD, NOW, ID, withPr));
  const actions = (d1.rows.audit_log as Array<Record<string, unknown>>).map((a) => a.action);
  assert.ok(actions.includes("job-complete-unclaimed"), JSON.stringify(actions));
  assert.ok(!actions.includes("job-record"), JSON.stringify(actions));
});

test("a claimed job is still its holder's: another caller cannot complete it without a claim", async () => {
  const { d1, env } = store([job({ status: "claimed", claimed_by: "agent:sample-driver", lease_expires: "2026-10-11T14:00:00.000Z" })]);
  const r = await offline(() => completeAsCaller(env, driver(["sample"], "other-driver"), NOW, ID, withPr));
  assert.equal(r.ok, false);
  assert.equal(d1.rows.jobs[0].status, "claimed");
  assert.equal(d1.rows.jobs[0].claimed_by, "agent:sample-driver");
});

// the started label

test("begin marks a queued job started, and a second session reading it is told who and when", async () => {
  const { d1, env } = store([job()]);
  const r = await beginJob(env, CLOUD, NOW, ID);
  assert.equal(r.ok, true, r.refusal);
  assert.equal(d1.rows.jobs[0].started_by, CLOUD.actor);
  assert.equal(d1.rows.jobs[0].started_at, NOW.toISOString());
  assert.equal(d1.rows.jobs[0].status, "queued", "a label is not a claim");
  assert.equal(d1.rows.jobs[0].claimed_by, null);
  assert.ok((d1.rows.audit_log as Array<Record<string, unknown>>).some((a) => a.action === "job-started"), "no job-started audit row");

  // A second session lists the job and learns who started it and when.
  const listed = await listJobs(env, { id: ID });
  assert.equal(listed.started?.by, CLOUD.actor);
  assert.equal(listed.started?.at, NOW.toISOString());
  assert.match(listed.started?.note ?? "", /admin@example\.com started this job at 2026-10-11T12:00:00\.000Z/);
  assert.equal((listed.jobs?.[0] as { started_by?: string }).started_by, CLOUD.actor);

  // Its own begin writes nothing and is told the same.
  const writes = d1.recorded.length;
  const second = await beginJob(env, driver(), LATER, ID);
  assert.equal(second.ok, true, "a started job refused a second begin");
  assert.equal(second.started?.by, CLOUD.actor);
  assert.equal(d1.rows.jobs[0].started_by, CLOUD.actor, "the second begin took the label");
  assert.equal(d1.recorded.length, writes, "the second begin wrote");
});

test("the mirror document and the Portal Queue show who started the job", async () => {
  const { d1, env } = store([job()]);
  await beginJob(env, CLOUD, NOW, ID);
  const doc = d1.rows.documents.find((d) => d.path === `jobs/${ID}.md`);
  assert.match(String(doc?.body), new RegExp(`- started by: ${CLOUD.actor.replace(/[.]/g, "\\.")} at 2026-10-11T12:00:00\\.000Z`));
  const feed = opsJobFrom(d1.rows.jobs[0] as unknown as JobFeedRow);
  assert.equal(feed.started_by, CLOUD.actor);
  assert.equal(feed.started_at, NOW.toISOString());
});

test("a started job refuses nothing: another session completes it with its pull request", async () => {
  const { d1, env } = store([job()]);
  await beginJob(env, CLOUD, NOW, ID);
  const r = await offline(() => completeAsCaller(env, driver(), LATER, ID, withPr));
  assert.equal(r.ok, true, r.refusal);
  assert.equal(d1.rows.jobs[0].status, "done");
});

test("PLANT: begin refuses a body changed after post, and writes nothing", async () => {
  const { d1, env } = store([job({ body: BODY.replace("sample work", "other work") })]);
  const r = await beginJob(env, CLOUD, NOW, ID);
  assert.equal(r.ok, false);
  assert.match(r.refusal ?? "", /its prompt must not be run/);
  assert.equal(d1.rows.jobs[0].started_by, null);
  assert.deepEqual(d1.recorded, []);
});

test("PLANT: begin on a claimed job is refused, and a caller outside the namespace is refused", async () => {
  const claimed = store([job({ status: "claimed", claimed_by: "agent:sample-driver" })]);
  const r = await beginJob(claimed.env, CLOUD, NOW, ID);
  assert.equal(r.ok, false);
  assert.match(r.refusal ?? "", /is claimed \(held by agent:sample-driver\)/);
  assert.deepEqual(claimed.d1.recorded, []);
  const queued = store([job()]);
  const outside = await beginJob(queued.env, driver(["sample-other"]), NOW, ID);
  assert.equal(outside.ok, false);
  assert.deepEqual(queued.d1.recorded, []);
});
