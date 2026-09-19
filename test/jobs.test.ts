import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { JOB_ACTIONS, JOB_LEASE_SECONDS, JOB_PARAM_NAMES, JOB_STATUSES, OPEN_JOB_STATUSES, TERMINAL_JOB_STATUSES, isJobStatus, isTerminalJobStatus, jobDocPath, mintJobId, swallowedParamTag } from "../src/jobs-schema.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { adminAgent } from "../src/agents.ts";
import { sourceFile } from "./source-files.ts";
import { completeJob, failJob, postJob } from "../src/jobs.ts";
import { legacyAgent } from "../src/agents.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// THE WORK QUEUE'S VOCABULARY, DERIVED FROM THE MIGRATION.
//
// The behavioural half is test-integration/jobs.test.ts, which drives the real
// lifecycle against a real D1: the partial unique index, the claim CAS and the
// lease sweep are all properties of SQLite, and a fake would agree with whatever it
// was asked. This half is the part node can read that workerd cannot: the migration
// FILE, so the statuses the code believes in and the statuses the index enforces
// cannot drift apart.

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");
const MIGRATION = readFileSync(join(MIGRATIONS_DIR, "0006_jobs.sql"), "utf8");

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

test("BLOCKED IS AN OPEN STATUS, in the code and in the index the database ends up with", () => {
  // The 2026-09-18 duplicate, pinned from both sides. The watcher re-posted a finding
  // twelve minutes after the first copy was blocked for the seat, because neither the
  // index nor the code counted a blocked job as holding its title.
  assert.ok(OPEN_JOB_STATUSES.includes("blocked"), "a blocked job is a pause with somebody waiting on it, which is open");
  const effective = openTitleIndexClauses().at(-1);
  assert.ok(effective, "no migration defines jobs_open_title");
  assert.ok(effective.statuses.includes("blocked"), `${effective.file} does not count a blocked job as open`);
});

test("every status the code knows is a status the migration's comment declares", () => {
  // The column is a bare TEXT with no CHECK, so the migration's own comment is the
  // schema's statement of the vocabulary. Asserting against it keeps that comment
  // honest rather than decorative.
  const declared = /-- (queued \| claimed \| done \| failed \| blocked)\./.exec(MIGRATION);
  assert.ok(declared, "migrations/0006_jobs.sql no longer declares the status vocabulary");
  assert.deepEqual(declared[1].split(" | ").sort(), [...JOB_STATUSES].sort());
});

test("every status in the vocabulary is classified terminal or not, and the two do not overlap", () => {
  // The mirror document's status is decided by this classification, so a status
  // added to JOB_STATUSES and left out of the classification would project as open
  // work forever. That is the defect this pins: `failed` was unclassified in effect,
  // because the mirror asked `=== "done"` rather than asking the vocabulary.
  for (const status of JOB_STATUSES) {
    assert.equal(
      typeof isTerminalJobStatus(status),
      "boolean",
      `${status} is not classified by isTerminalJobStatus`
    );
  }
  assert.deepEqual([...TERMINAL_JOB_STATUSES].sort(), ["done", "failed"]);
  // Both directions: a terminal status is a real status, and the open ones are not
  // terminal. `blocked` is in neither list and that is deliberate, so it is named.
  for (const status of TERMINAL_JOB_STATUSES) assert.ok(isJobStatus(status));
  for (const status of OPEN_JOB_STATUSES) assert.equal(isTerminalJobStatus(status), false);
  assert.equal(isTerminalJobStatus("blocked"), false, "a blocked job is paused, not finished");
});

// Proven against a real D1 in test-integration/jobs.test.ts: "PLANT: a failed job's document is closed too" and "a blocked job's document stays active".


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

test("the lease is the four hours the table's comment claims", () => {
  assert.equal(JOB_LEASE_SECONDS, 4 * 60 * 60);
  assert.match(MIGRATION, /lease_expires four hours out/);
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

// scanner-rule: CLAUDE.md rule 8, meta.changes cannot count what a batch did, and every transition is a keyed UPDATE with RETURNING. Derived over every UPDATE in the module
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

// scanner-rule: CLAUDE.md rule 5, every overwrite snapshots and audits. A second write path cannot be exercised before it exists
test("the queue's writes go through the shared document statements, not a second write path", () => {
  // Hard rule 5: no write path skips document_versions and audit_log. The mirror
  // uses improveDocStatements, which carries both in the same batch, rather than
  // spelling its own upsert.
  const jobs = sourceFile("jobs.ts");
  assert.match(jobs, /improveDocStatements\(/, "the job mirror no longer uses the shared document statements");
  assert.doesNotMatch(jobs, /INSERT INTO documents/, "src/jobs.ts spells its own document upsert");
  assert.doesNotMatch(jobs, /INSERT INTO document_versions/, "src/jobs.ts spells its own snapshot");
});

// BLOCKED IS NOT TERMINAL (2026-09-10). The counters live in their own migration,
// so the same derive-from-the-source rule applies to them.
const RESUME_MIGRATION = readFileSync(join(import.meta.dirname, "..", "migrations", "0007_jobs_resume.sql"), "utf8");

// Proven against a real D1 in test-integration/jobs.test.ts: "a job can hit a gate, come back, and hit another, counting each".


// Proven against a real D1 in test-integration/jobs.test.ts: "resume refuses a queued job and a done job" and "a blocked job cannot be claimed".


// Proven against a real D1 in test-integration/jobs.test.ts: "PLANT: a body edited while the job sat blocked is refused and failed".


// Proven against a real D1 in test-integration/jobs.test.ts: "resume holds the one-claim-per-caller rule".


// That the jobs tool is served, once, is covered by the tool count in
// test/counts.test.ts and by every test here and in test/jobs-list.test.ts that calls it.


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
