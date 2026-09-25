import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attributionStatements,
  dueTransitions,
  offerSkills,
  failureNoteStatements,
  ftsQuery,
  shouldCreateCandidate,
} from "../src/skills-records.ts";
import { fakeD1, fakeEnv } from "./fakes.ts";

// GROUPS 2, 3 AND 7: what gets offered, what earns a candidate, and what a failed run
// leaves behind for the next driver to read.

// A statement recorder thin enough to read the bound parameters back out.
function recorder() {
  const recorded: Array<{ sql: string; params: unknown[] }> = [];
  const stmt = (sql: string, params: unknown[] = []): D1PreparedStatement =>
    ({
      sql: sql.replace(/\s+/g, " ").trim(),
      params,
      bind: (...bound: unknown[]) => {
        const s = stmt(sql, bound);
        recorded.push({ sql: sql.replace(/\s+/g, " ").trim(), params: bound });
        return s;
      },
    }) as unknown as D1PreparedStatement;
  return { recorded, db: { prepare: (sql: string) => stmt(sql) } as unknown as D1Database };
}

// ---- group 2: what earns a candidate --------------------------------------------

test("a kept attempt earns a candidate and a reverted one does not", () => {
  assert.equal(shouldCreateCandidate({ kind: "attempt", id: "a1", kept: true }).create, true);
  assert.equal(shouldCreateCandidate({ kind: "attempt", id: "a1", kept: false }).create, false);
});

test("a job earns a candidate only when its outcome is fully verified", () => {
  assert.equal(shouldCreateCandidate({ kind: "job", id: "j1", prsMerged: 1, ciGreen: 1 }).create, true);
  // Each half missing on its own, and the null case, which is not the same as zero.
  assert.equal(shouldCreateCandidate({ kind: "job", id: "j1", prsMerged: 1, ciGreen: 0 }).create, false);
  assert.equal(shouldCreateCandidate({ kind: "job", id: "j1", prsMerged: 0, ciGreen: 1 }).create, false);
  assert.equal(shouldCreateCandidate({ kind: "job", id: "j1", prsMerged: null, ciGreen: null }).create, false);
  assert.match(
    shouldCreateCandidate({ kind: "job", id: "j1", prsMerged: null, ciGreen: 1 }).reason,
    /prs_merged null/,
    "the refusal must name which half was missing"
  );
});

// scanner-rule: skills lifecycle, "never live on creation" (docs/skills.md). A module
// that holds no INSERT cannot create a row, which no call to it can demonstrate.

// ---- group 3: what gets offered --------------------------------------------------
//
// The status, trigger, limit and failure-note rules of the recommend query, and the
// retired-source lookup, are proven against a real D1 in
// test-integration/skills-records.test.ts.

test("ftsQuery reduces free prose to bare words, so an operator in a description cannot change the query", () => {
  // FTS5 takes a query language and work descriptions regularly contain its
  // operators. A description containing NEAR or a quote must not become a syntax
  // error, or worse, a query meaning something other than it says.
  assert.equal(ftsQuery('a "slow" query NEAR the loader'), "slow OR query OR near OR the OR loader");
  assert.equal(ftsQuery("a* OR b^"), null, "nothing over two characters survives, so there is no query");
  assert.equal(ftsQuery(""), null);
  assert.equal(ftsQuery("   "), null);
  const long = ftsQuery(Array.from({ length: 100 }, (_, i) => `word${i}`).join(" "));
  assert.equal((long ?? "").split(" OR ").length, 24, "the term list is bounded");
});

// ---- group 3: attribution, applied -----------------------------------------------

// Each credit is a counter update PLUS its audit row, so the statements are read by
// kind rather than counted. The audit half arrived with the 2026-09-16 change that made
// this the loop's only credit path: recordSkillOutcome audited every outcome it wrote,
// and dropping it must not lose that.
const counterUpdates = (recorded: Array<{ sql: string; params: unknown[] }>) =>
  recorded.filter((r) => /UPDATE improve_skills SET (wins|losses)/.test(r.sql));
const outcomeAudits = (recorded: Array<{ sql: string; params: unknown[] }>) =>
  recorded.filter((r) => /INSERT INTO audit_log/.test(r.sql) && r.params[1] === "improve-skill-outcome");

test("only used skills produce a write, and the direction follows the verifier", () => {
  const { recorded, db } = recorder();
  attributionStatements(db, {
    offered: ["s1", "s2", "s3"],
    used: ["s1", "s2"],
    signal: "verified-success",
  });
  const updates = counterUpdates(recorded);
  assert.equal(updates.length, 2, "the unused skill must produce no write at all");
  assert.ok(updates.every((r) => /SET wins = wins \+ 1/.test(r.sql)));
  assert.deepEqual(updates.map((r) => r.params[0]), ["s1", "s2"]);
  // One audit row per credit, and none for the skill that earned nothing.
  const audits = outcomeAudits(recorded);
  assert.equal(audits.length, 2, "every credit carries its own audit row");
  assert.deepEqual(
    audits.map((r) => JSON.parse(String(r.params[4])).skill_id),
    ["s1", "s2"]
  );
});

test("improvised success and environment failure write nothing, even for a used skill", () => {
  for (const signal of ["improvised", "environment-failure"] as const) {
    const { recorded, db } = recorder();
    attributionStatements(db, { offered: ["s1"], used: ["s1"], signal });
    assert.equal(recorded.length, 0, `${signal} must move nothing`);
  }
});

test("a verified failure charges a loss to the used skill only", () => {
  const { recorded, db } = recorder();
  attributionStatements(db, { offered: ["s1", "s2"], used: ["s2"], signal: "verified-failure" });
  const updates = counterUpdates(recorded);
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /SET losses = losses \+ 1/);
  assert.equal(updates[0].params[0], "s2");
  const audits = outcomeAudits(recorded);
  assert.equal(audits.length, 1);
  assert.deepEqual(JSON.parse(String(audits[0].params[4])), {
    skill_id: "s2",
    credit: "loss",
    signal: "verified-failure",
    reason: "the skill was used and the verifier reported failure.",
  });
});

// ---- group 7: failure memory ------------------------------------------------------

test("a failure note is written per skill in use, carrying the source it came from", () => {
  const { recorded, db } = recorder();
  failureNoteStatements(db, "capsid", { kind: "job", id: "job_abc" }, ["s1", "s2"], "the migration was refused");
  assert.equal(recorded.length, 2);
  assert.deepEqual(recorded[0].params, ["s1", "capsid", "job", "job_abc", "the migration was refused"]);
  assert.match(recorded[0].sql, /INSERT INTO skill_failures/);
});

test("no skills in use means no notes, rather than a note attributed to nothing", () => {
  const { recorded, db } = recorder();
  failureNoteStatements(db, "capsid", { kind: "attempt", id: "a1" }, [], "it failed");
  assert.equal(recorded.length, 0);
});

test("a very long note is bounded before it is stored", () => {
  const { recorded, db } = recorder();
  failureNoteStatements(db, "capsid", { kind: "job", id: "j" }, ["s1"], "x".repeat(5000));
  assert.equal(String(recorded[0].params[4]).length, 2000);
});

// ---- the migration ----------------------------------------------------------------

// ---- offerSkills and dueTransitions, driven against the fake ---------------------

test("offerSkills returns only candidate and live skills, with their recent failures", async () => {
  const { db, rows } = fakeD1({
    documents: [
      { namespace: "capsid", path: "improve/skills/s1.md", title: "slow query", body: "look for a slow database query in a loader" },
      { namespace: "capsid", path: "improve/skills/s3.md", title: "retired idea", body: "a slow database query in a loader" },
    ],
  });
  rows.improve_skills.push(
    { id: "s1", status: "candidate", version: 1, trigger_condition: "a slow database query", body_ref: "improve/skills/s1.md", title: "slow query", namespaces: null },
    { id: "s3", status: "retired", version: 1, trigger_condition: "a slow database query", body_ref: "improve/skills/s3.md", title: "retired idea", namespaces: null }
  );
  rows.skill_failures.push(
    { skill: "s1", namespace: "capsid", source_kind: "job", source_id: "j1", note: "older", created_at: "2026-09-01" },
    { skill: "s1", namespace: "capsid", source_kind: "job", source_id: "j2", note: "newer", created_at: "2026-09-09" }
  );

  const offered = await offerSkills(fakeEnv({ DB: db }), "capsid", "a slow database query in a loader");
  assert.deepEqual(offered.map((s) => s.id), ["s1"], "the retired skill must not be offered");
  assert.equal(offered[0].recent_failures.length, 2);
  assert.equal(offered[0].recent_failures[0].note, "newer", "newest first");
});

test("offerSkills returns nothing when the work description yields no searchable terms", async () => {
  const { db } = fakeD1({});
  assert.deepEqual(await offerSkills(fakeEnv({ DB: db }), "capsid", "a of to"), []);
});

test("dueTransitions reads each skill's evaluations at its own version and applies the rules", async () => {
  const { db, rows } = fakeD1({});
  rows.improve_skills.push(
    { id: "ready", status: "candidate", version: 1 },
    { id: "thin", status: "candidate", version: 1 },
    { id: "bumped", status: "candidate", version: 2 }
  );
  const evaluation = (skill: string, version: number, verdict: string, day: string) => ({
    skill, version, namespace: "capsid", probe_set_version: "p1", delta: verdict === "positive" ? 0.1 : -0.1, runs: 5, verdict, evaluated_at: `2026-09-${day}`,
  });
  rows.skill_evaluations.push(
    evaluation("ready", 1, "positive", "01"),
    evaluation("ready", 1, "positive", "02"),
    evaluation("thin", 1, "positive", "01"),
    // Two positives, but recorded against version 1 while the skill is now version 2.
    evaluation("bumped", 1, "positive", "01"),
    evaluation("bumped", 1, "positive", "02")
  );

  const verdicts = await dueTransitions(fakeEnv({ DB: db }));
  const by = new Map(verdicts.map((v) => [v.skill, v.verdict]));
  assert.equal(by.get("ready")?.change, true, "two positives at the current version promote");
  assert.equal(by.get("thin")?.change, false, "one is not enough");
  assert.equal(by.get("bumped")?.change, false, "evidence at an older version does not carry forward");
});
