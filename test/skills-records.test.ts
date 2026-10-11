import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attributionStatements,
  shouldCreateCandidate,
} from "../src/skills-records.ts";

// What earns a candidate and how a verified run credits a skill.

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

// what earns a candidate

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

// attribution, applied

// Each credit is a counter update plus its audit row, so the statements are read by
// kind rather than counted. This is the loop's only credit path, so every outcome it
// writes is audited.
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
