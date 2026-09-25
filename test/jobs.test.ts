import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { JOB_ACTIONS, JOB_PARAM_NAMES, JOB_STATUSES, OPEN_JOB_STATUSES, isJobStatus, jobDocPath, mintJobId, swallowedParamTag } from "../src/jobs-schema.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { adminAgent } from "../src/agents.ts";
import { sourceFile } from "./source-files.ts";
import { claimJob, completeJob, expireJobLeases, failJob, postJob, resumeJob, supersedeJob } from "../src/jobs.ts";
import { legacyAgent } from "../src/agents.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";
import { MAX_RESUME_NOTE, MAX_TITLE } from "../src/limits.ts";

// THE WORK QUEUE'S VOCABULARY, DERIVED FROM THE MIGRATION.
//
// The behavioural half is test-integration/jobs.test.ts, which drives the real
// lifecycle against a real D1: the partial unique index, the claim CAS and the
// lease sweep are all properties of SQLite, and a fake would agree with whatever it
// was asked. This half is the part node can read that workerd cannot: the migration
// FILE, so the statuses the code believes in and the statuses the index enforces
// cannot drift apart.

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

/** Every definition of the jobs_open_title index across migrations/, in the order
 *  wrangler applies them. The LAST one is the index the database ends up with, which
 *  is the reason this reads the directory instead of one file: migrations/0019
 *  redefines the index 0006 created, and a guard pinned to 0006 would have gone on
 *  asserting the superseded clause. */
function openTitleIndexClauses(): { file: string; statuses: string[] }[] {
  const found: { file: string; statuses: string[] }[] = [];
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const definition = /CREATE UNIQUE INDEX[^;]*?jobs_open_title[^;]*?WHERE status IN \(([^)]*)\)/i.exec(sql);
    if (!definition) continue;
    found.push({
      file,
      statuses: definition[1]
        .split(",")
        .map((s) => s.trim().replace(/'/g, ""))
        .sort(),
    });
  }
  return found;
}

test("the partial index and OPEN_JOB_STATUSES name the same statuses", () => {
  // The index is what refuses a duplicate open job; OPEN_JOB_STATUSES is what the
  // code believes it says. Both directions, so adding a status to one and not the
  // other is a build failure rather than a duplicate nobody expected.
  const clauses = openTitleIndexClauses();
  // TWO definitions today: 0006 created the index and 0019 widened it to blocked.
  // Stated as a count so a regex that silently stops matching fails here rather than
  // passing over an empty list.
  assert.equal(clauses.length, 2, `expected 2 definitions of jobs_open_title, found ${clauses.map((c) => c.file).join(", ") || "none"}`);
  assert.equal(clauses[0].file, "0006_jobs.sql");
  const effective = clauses[clauses.length - 1];
  assert.deepEqual(
    effective.statuses,
    [...OPEN_JOB_STATUSES].sort(),
    `${effective.file} is the last definition of the index, and it disagrees with OPEN_JOB_STATUSES`
  );
});

test("supersede refuses a missing reason and a swallowed tag before it reads anything", async () => {
  // fakeEnv with no DB, so a refusal that reached the database would throw rather
  // than pass quietly.
  const agent = legacyAgent("write", "github:DrDustinEdwards");
  const now = new Date("2026-09-24T12:00:00.000Z");
  const blank = await supersedeJob(fakeEnv({}), agent, now, "job_abc123abc123", { reason: "  " });
  assert.equal(blank.ok, false);
  assert.match(blank.refusal ?? "", /supersede needs a reason/);
  const swallowed = await supersedeJob(fakeEnv({}), agent, now, "job_abc123abc123", { reason: "reposted</replaced_by>" });
  assert.equal(swallowed.ok, false);
  assert.match(swallowed.refusal ?? "", /^reason contains the literal text '<\/replaced_by>'\./);
});

test("isJobStatus refuses anything that is not one of them", () => {
  for (const status of JOB_STATUSES) assert.ok(isJobStatus(status));
  for (const bad of ["", "QUEUED", "running", "constructor", "toString", null, 3]) {
    assert.equal(isJobStatus(bad), false, `${String(bad)} is not a job status`);
  }
});

test("a job id is minted, not sequential", () => {
  // A sequential id invites addressing a job by arithmetic, and these are quoted in
  // chat. Two mints differ, and both are the declared shape.
  const a = mintJobId();
  const b = mintJobId();
  assert.match(a, /^job_[0-9a-f]{12}$/);
  assert.notEqual(a, b);
  assert.equal(jobDocPath(a), `jobs/${a}.md`);
});

test("every action the schema advertises is one the tool handles", async () => {
  // JOB_ACTIONS is what the description and the driver are written against. Each is
  // called through the real tool; an action with no branch falls through to the
  // "unknown jobs action" refusal.
  const d1 = fakeD1({});
  const server = buildServer(fakeEnv({ DB: d1.db, APP_KV: fakeKv({}).kv }), adminAgent("DrDustinEdwards"));
  const client = new Client({ name: "jobs-actions", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const unhandled: string[] = [];
  for (const action of JOB_ACTIONS) {
    const result = (await client.callTool({ name: "jobs", arguments: { action, namespace: "capsid" } })) as {
      content: Array<{ text: string }>;
    };
    if (/unknown jobs action/.test(result.content[0]?.text ?? "")) unhandled.push(action);
  }
  await client.close();
  assert.deepEqual(unhandled, [], `the jobs tool has no branch for: ${unhandled.join(", ")}`);
});

// scanner-rule: CLAUDE.md, path mutation rule: meta.changes cannot count what a batch did, and every transition is a keyed UPDATE with RETURNING. Derived over every UPDATE in the module
test("every queue transition is a keyed UPDATE with RETURNING, never meta.changes", () => {
  // The rule the improve state machine already runs on, applied to the queue. A
  // transition that read meta.changes would be counting the FTS5 triggers on the
  // document write that rides in the same batch.
  const jobs = sourceFile("jobs.ts");
  const updates = [...jobs.matchAll(/UPDATE jobs SET[\s\S]*?(?=`)/g)].map((m) => m[0]);
  assert.ok(updates.length >= 3, `found ${updates.length} UPDATE statements in src/jobs.ts; the scan is broken`);
  for (const update of updates) {
    assert.match(update, /\bWHERE\b/, "an unkeyed UPDATE would move every job in the table");
    assert.match(update, /RETURNING/, "a transition without RETURNING cannot tell a win from a lost race");
  }
  // Comment lines stripped first. The file's own header says "never meta.changes",
  // and a guard a comment can trip is one that gets deleted rather than fixed.
  const code = jobs
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(code, /meta\.changes/, "src/jobs.ts reads meta.changes, which the FTS5 triggers inflate");
});

// scanner-rule: CLAUDE.md, snapshot rule: every overwrite snapshots and audits. A second write path cannot be exercised before it exists
test("the queue's writes go through the shared document statements, not a second write path", () => {
  // CLAUDE.md, snapshot rule: no write path skips document_versions and audit_log. The mirror
  // uses improveDocStatements, which carries both in the same batch, rather than
  // spelling its own upsert.
  const jobs = sourceFile("jobs.ts");
  assert.match(jobs, /improveDocStatements\(/, "the job mirror no longer uses the shared document statements");
  assert.doesNotMatch(jobs, /INSERT INTO documents/, "src/jobs.ts spells its own document upsert");
  assert.doesNotMatch(jobs, /INSERT INTO document_versions/, "src/jobs.ts spells its own snapshot");
});

// ---- A SWALLOWED PARAMETER TAG IS A MALFORMED CALL, NOT A SUMMARY -------------
//
// Twice on 2026-09-11 a driver's `complete` closed a parameter tag INSIDE a value,
// so `result_ref` and `evidence` were never sent as arguments: they arrived as
// literal text in the middle of `result_summary`, and the outcome row recorded
// nothing. The row cannot be rewritten afterwards (its primary key and ON CONFLICT
// DO NOTHING are what make it evidence), so the only place to catch this is before
// the write.
//
// The string below is the ACTUAL tail of job_9980f57bd359's stored summary, read
// back from the live database rather than reconstructed, because a guard written
// against a remembered shape is a guard against the wrong shape.
const SWALLOWED_REAL =
  'up.test.ts derives from migrations/ both ways.</result_summary>\n' +
  '<result_ref>https://github.com/DrDustinEdwards/capsid-mcp/pull/21</result_ref>\n' +
  '<evidence>{"prs": ["https://github.com/DrDustinEdwards/capsid-mcp/pull/21"], "tests_added": 42}</evidence>\n' +
  '</invoke>\n';

test("PLANT: the real malformed summary from job_9980f57bd359 is detected", () => {
  const found = swallowedParamTag(SWALLOWED_REAL);
  assert.equal(found, "result_summary", "the field's own closing tag is the first one in the swallowed text");
});

test("every parameter name the guard knows is one the tool serves", async () => {
  // Derived from the served schema rather than retyped, so a name the guard lists and
  // nobody can send fails here.
  for (const name of JOB_PARAM_NAMES) {
    assert.equal(swallowedParamTag(`text </${name}> more`), name, `'</${name}>' is not detected`);
  }
  const server = buildServer(fakeEnv({ APP_KV: fakeKv({}).kv }), adminAgent("DrDustinEdwards"));
  const client = new Client({ name: "jobs-params", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  const served = Object.keys(tools.find((tool) => tool.name === "jobs")?.inputSchema.properties ?? {});
  const missing = JOB_PARAM_NAMES.filter((name) => !served.includes(name));
  assert.deepEqual(missing, [], `the jobs tool serves no parameter named: ${missing.join(", ")}`);
});

test("the jobs tool takes a resume note longer than a reason, bounded by MAX_RESUME_NOTE", async () => {
  // The seat's full approval (requested 2026-09-25). reason stays at MAX_TITLE; note
  // is the field that carries the rulings, so the served schema has to admit them.
  const server = buildServer(fakeEnv({ APP_KV: fakeKv({}).kv }), adminAgent("DrDustinEdwards"));
  const client = new Client({ name: "jobs-note", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  const props = (tools.find((tool) => tool.name === "jobs")?.inputSchema.properties ?? {}) as Record<string, { maxLength?: number }>;
  assert.equal(props.note?.maxLength, MAX_RESUME_NOTE, "the jobs tool serves no note bounded by MAX_RESUME_NOTE");
  assert.equal(props.reason?.maxLength, MAX_TITLE, "reason's bound moved");
  assert.ok(MAX_RESUME_NOTE > MAX_TITLE * 10, "the note is not bounded well above the reason");
});

test("ordinary prose is not refused, including prose ABOUT the pattern", () => {
  // The guard matches the full `</name>` spelling only. A job body explaining this
  // rule writes the pieces apart, which is what this job's own body did, and a
  // summary that merely mentions evidence or a result ref is ordinary text.
  for (const innocent of [
    "landed the change; evidence is in the PR",
    "refuse a summary containing '</' followed by a parameter name",
    "the result_ref is a document key",
    "a < b and c > d",
    "</div> in a rendered page",
    "</resultref>",
    "",
  ]) {
    assert.equal(swallowedParamTag(innocent), null, `innocent text was refused: ${innocent}`);
  }
});

// The three CALL SITES, driven. The pure function above is the detector; these prove
// each entry point actually asks it, and that nothing reaches the database when it
// does. Every refusal here returns before any D1 call, which is why fakeEnv with no
// DB is enough: if a handler ever stopped refusing, this test would throw on the
// missing binding rather than pass quietly.
test("PLANT: complete, fail and post all refuse a swallowed tag, and write nothing", async () => {
  const agent = legacyAgent("write", "agent:capsid-driver");
  const now = new Date("2026-09-11T22:00:00.000Z");

  const completed = await completeJob(fakeEnv({}), agent, now, "job_abc123abc123", {
    result_summary: SWALLOWED_REAL,
  });
  assert.equal(completed.ok, false, "complete accepted a summary with a swallowed parameter tag");
  assert.match(completed.refusal ?? "", /result_summary contains the literal text/);
  assert.match(completed.refusal ?? "", /its own closing tag/);
  assert.match(completed.refusal ?? "", /Nothing was written/);

  const failed = await failJob(fakeEnv({}), agent, now, "job_abc123abc123", `broke</evidence>`);
  assert.equal(failed.ok, false, "fail accepted a reason with a swallowed parameter tag");
  assert.match(failed.refusal ?? "", /^reason contains the literal text '<\/evidence>'\./);

  // post refuses on the BODY, which matters more than the others: a body is the
  // prompt a driver executes, and the swallowed text would be signed with it.
  const posted = await postJob(fakeEnv({ IMPROVE_SCORE_SECRET: "test-secret" }), agent, now, {
    namespace: "capsid",
    title: "a job",
    body: `do the thing</result_ref>`,
  });
  assert.equal(posted.ok, false, "post accepted a body with a swallowed parameter tag");
  assert.match(posted.refusal ?? "", /^body contains the literal text '<\/result_ref>'\./);
});

test("a well-formed call is still accepted, so the guard is not a wall", async () => {
  // The innocent case in the same commit as the guard: a guard that refuses ordinary
  // work gets deleted rather than fixed. This one gets past the tag check and stops
  // at the missing database, which is proof it was not refused.
  const agent = legacyAgent("write", "agent:capsid-driver");
  await assert.rejects(
    () =>
      completeJob(fakeEnv({}), agent, new Date(), "job_abc123abc123", {
        result_summary: "landed it; evidence is in the PR and the result_ref is a document key",
      }),
    /prepare|undefined|DB/i,
    "a clean summary was refused by the tag guard instead of reaching the database"
  );
});

// ---- the skills a run names are checked before anything is written ---------------
//
// Ruled 2026-09-16. A driver names offered and used; the credit direction comes from
// what the Worker verified. These are the two refusals that keep the offered-to-used
// rate meaning something, and both refuse BEFORE the transition, so a refused call
// writes nothing at all.

test("a skill id that does not exist is REFUSED, not dropped", async () => {
  // Dropping it would record this run as having been offered nothing, which is the one
  // way the offered-to-used rate can be wrong without anybody writing a wrong number.
  const d1 = fakeD1({ improveSkills: [{ id: "sk-real", status: "candidate", version: 1, source_namespace: "foxhound" }] });
  const out = await completeJob(fakeEnv({ DB: d1.db }), legacyAgent("write", "agent:capsid-driver"), new Date(), "job_abc123abc123", {
    result_summary: "done",
    skills: { offered: ["sk-real", "sk-ghost"], used: ["sk-real"] },
  });
  assert.equal(out.ok, false, "a non-existent skill id was accepted");
  assert.match(out.refusal ?? "", /sk-ghost/);
  assert.match(out.refusal ?? "", /refused rather than dropped/);
  const wrote = d1.recorded.some((r) => /INSERT INTO job_outcomes/i.test(r.sql));
  assert.equal(wrote, false, "a refused complete still wrote an outcome row");
});

test("a skill named as USED but not OFFERED is refused", async () => {
  // It did not come from the recommend step, so crediting it would measure something
  // this loop did not do.
  const d1 = fakeD1({ improveSkills: [{ id: "sk-a", status: "candidate", version: 1, source_namespace: "foxhound" }] });
  const out = await completeJob(fakeEnv({ DB: d1.db }), legacyAgent("write", "agent:capsid-driver"), new Date(), "job_abc123abc123", {
    result_summary: "done",
    skills: { offered: [], used: ["sk-a"] },
  });
  assert.equal(out.ok, false, "a used-but-not-offered skill was accepted");
  assert.match(out.refusal ?? "", /not as offered/);
});

test("naming no skills at all is not a refusal: most jobs have no recommend step", async () => {
  const d1 = fakeD1({});
  const out = await completeJob(fakeEnv({ DB: d1.db }), legacyAgent("write", "agent:capsid-driver"), new Date(), "job_abc123abc123", {
    result_summary: "done",
  });
  // It refuses for an unrelated reason (no such job in this fake) or succeeds, but it
  // must not refuse ON THE SKILLS.
  assert.equal(/skill/i.test(out.refusal ?? ""), false, `refused on skills when none were named: ${out.refusal}`);
});

// ---- audit 2026-09-25, F3-7: a refusal is an error to the MCP client -------------------

test("a jobs refusal comes back with isError set, and a caller still reads the refusal", async () => {
  // Every JobResult went through ok(), so ok: false came back with isError false and a
  // client keying on isError read the refusal as success.
  const server = buildServer(fakeEnv({ APP_KV: fakeKv({}).kv }), adminAgent("DrDustinEdwards"));
  const client = new Client({ name: "jobs-iserror", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name: "jobs", arguments: { action: "complete", id: "job_abc123abc123" } })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    assert.equal(result.isError, true, `a refusal read as success: ${result.content[0].text}`);
    const body = JSON.parse(result.content[0].text) as { ok: boolean; action: string; refusal?: string };
    assert.equal(body.ok, false);
    assert.equal(body.action, "complete");
    assert.match(body.refusal ?? "", /needs a result_summary/);
  } finally {
    await client.close();
  }
});

// ---- audit 2026-09-25, F3-4: marking a job failed checks that the row moved ------------
//
// A job that failed its signature check is marked failed with a keyed UPDATE. When the
// row had moved first (another driver claimed it), the three copies of this path still
// rewrote the mirror as failed and wrote an audit row saying so. The UPDATE now rides
// in one batch with its records behind requireJobUnchanged, so this fake aborts any
// batch that opens with that guard, as D1 does when the row no longer matches what was
// read. `attempted` is every batch sent, `committed` every batch that landed.
function movedJobDb(before: Record<string, unknown>, after: Record<string, unknown>) {
  const attempted: string[][] = [];
  const committed: string[][] = [];
  let reads = 0;
  const stmt = (sql: string) => {
    const flat = sql.replace(/\s+/g, " ").trim();
    const s = {
      flat,
      bind: () => s,
      first: async () => {
        if (/SELECT \* FROM jobs WHERE id = \?1/.test(flat)) return reads++ === 0 ? { ...before } : { ...after };
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => ({}),
    };
    return s;
  };
  const db = {
    prepare: (sql: string) => stmt(sql),
    batch: async (statements: Array<{ flat: string }>) => {
      const sqls = statements.map((x) => x.flat);
      attempted.push(sqls);
      if (/WHERE NOT EXISTS \(SELECT 1 FROM jobs/.test(sqls[0] ?? "")) {
        throw new Error("NOT NULL constraint failed: document_versions.document_id");
      }
      committed.push(sqls);
      return [];
    },
  };
  return { db: db as unknown as D1Database, attempted, committed };
}

// The one batch markJobFailed sends: the guard, then the UPDATE, then its records.
function assertGuardedFailBatch(attempted: string[][]) {
  assert.equal(attempted.length, 1, "the job was never offered the failed UPDATE");
  assert.match(attempted[0][0], /WHERE NOT EXISTS \(SELECT 1 FROM jobs/, "the batch does not open with the guard");
  assert.match(attempted[0][1], /^UPDATE jobs SET status = 'failed'/);
  assert.ok(attempted[0].some((sql) => /INSERT INTO audit_log/.test(sql)), "the audit row is not in the same batch");
}

const MOVED_JOB = {
  id: "job_abc123abc123",
  namespace: "capsid",
  title: "a job",
  body: "not signed",
  priority: 0,
  posted_by: "github:DrDustinEdwards",
  claimed_at: null,
  lease_expires: null,
  result_ref: null,
  result_summary: null,
  gate_required: 0,
  required_scopes: null,
  min_record: null,
  blocked_count: 0,
  resumed_count: 0,
  corrections_count: 0,
  review_required: 0,
  created_at: "2026-09-25T08:00:00.000Z",
  updated_at: "2026-09-25T08:00:00.000Z",
};

test("PLANT: a claim whose bad-signature job moved first writes no mirror and no audit row", async () => {
  const { db, attempted, committed } = movedJobDb(
    { ...MOVED_JOB, status: "queued", claimed_by: null },
    { ...MOVED_JOB, status: "claimed", claimed_by: "agent:other-driver" }
  );
  const out = await claimJob(fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: "s" }), legacyAgent("write", "agent:capsid-driver"), new Date("2026-09-25T09:00:00Z"), {
    id: "job_abc123abc123",
  });
  assertGuardedFailBatch(attempted);
  assert.equal(out.ok, false);
  assert.deepEqual(committed, [], "a job that moved was still mirrored and audited as failed");
  assert.match(out.refusal ?? "", /now claimed, held by agent:other-driver/);
  assert.doesNotMatch(out.refusal ?? "", /has been marked failed/);
});

test("PLANT: a resume whose bad-signature job moved first writes no mirror and no audit row", async () => {
  const { db, attempted, committed } = movedJobDb(
    { ...MOVED_JOB, status: "blocked", claimed_by: "agent:capsid-driver", blocked_count: 1 },
    { ...MOVED_JOB, status: "failed", claimed_by: "agent:capsid-driver", blocked_count: 1 }
  );
  const out = await resumeJob(
    fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: "s" }),
    adminAgent("DrDustinEdwards"),
    new Date("2026-09-25T09:00:00Z"),
    "job_abc123abc123",
    "ran it"
  );
  assertGuardedFailBatch(attempted);
  assert.equal(out.ok, false);
  assert.deepEqual(committed, [], "a job that moved was still mirrored and audited as failed");
  assert.match(out.refusal ?? "", /now failed/);
});

// ---- audit 2026-09-25, F1-4: one job's records failing does not cost the others theirs --

test("PLANT: expireJobLeases requeues the later jobs when an earlier job's batch throws", async () => {
  // Each expired job is requeued in its own batch with its mirror and audit row. A
  // throw on the first leaves it claimed and must not stop the second.
  const expired = { id: "job_aaaaaaaaaaaa", namespace: "capsid", title: "a", body: "b", status: "claimed", priority: 0, posted_by: "github:x", claimed_by: "agent:gone", claimed_at: "2026-09-25T00:00:00Z", lease_expires: "2026-09-25T04:00:00Z", result_ref: null, result_summary: null, gate_required: 0, required_scopes: null, min_record: null, blocked_count: 0, resumed_count: 0, corrections_count: 0, review_required: 0, created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z" };
  const rows = [expired, { ...expired, id: "job_bbbbbbbbbbbb", title: "b" }];
  const batches: string[][] = [];
  const stmt = (sql: string): unknown => {
    const s = {
      sql,
      bind: () => s,
      all: async () => (/FROM jobs WHERE status = 'claimed' AND lease_expires/.test(sql) ? { results: rows } : { results: [] }),
      first: async () => null,
      run: async () => ({}),
    };
    return s;
  };
  const db = {
    prepare: (sql: string) => stmt(sql),
    batch: async (statements: Array<{ sql: string }>) => {
      batches.push(statements.map((x) => x.sql));
      if (batches.length === 1) throw new Error("D1_ERROR: database is locked");
      return [];
    },
  };
  const out = await expireJobLeases(fakeEnv({ DB: db as never }), new Date("2026-09-25T10:00:00Z"));
  assert.equal(batches.length, 2, "the second job was never attempted");
  assert.deepEqual(out.requeued, ["job_bbbbbbbbbbbb"], "a job whose batch threw was reported as requeued");
  // Each batch is the guard, the requeue and its records together.
  for (const sqls of batches) {
    assert.match(sqls[0], /WHERE NOT EXISTS \(SELECT 1 FROM jobs/);
    assert.match(sqls[1], /UPDATE jobs SET status = 'queued'/);
    assert.ok(sqls.some((sql) => /INSERT INTO audit_log/.test(sql)));
  }
});

// ---- audit 2026-09-25, F2-8: post needs a registered namespace -------------------------

test("PLANT: post into a namespace that is not registered is refused and writes nothing", async () => {
  // A caller scoped to * could create a job and its mirror document in a namespace that
  // does not exist, which write refuses for the same document path.
  const d1 = fakeD1({});
  const env = fakeEnv({ DB: d1.db, IMPROVE_SCORE_SECRET: "test-secret" });
  const agent = legacyAgent("write", "agent:capsid-driver");
  const refused = await postJob(env, agent, new Date("2026-09-25T09:00:00Z"), { namespace: "nosuchns", title: "a job", body: "do it" });
  assert.equal(refused.ok, false, "a job was posted into an unregistered namespace");
  assert.match(refused.refusal ?? "", /unknown namespace 'nosuchns'/);
  assert.equal(d1.recorded.some((r) => /INSERT INTO jobs|INSERT INTO documents/.test(r.sql)), false, "a refused post wrote a row");

  // The innocent direction: a registered namespace still posts.
  const posted = await postJob(env, agent, new Date("2026-09-25T09:00:00Z"), { namespace: "capsid", title: "a job", body: "do it" });
  assert.equal(posted.ok, true, JSON.stringify(posted));
});
