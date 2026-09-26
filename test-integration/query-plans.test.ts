import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// EXPLAIN QUERY PLAN over every read in src/, against the real schema.
//
// The statements are walked out of the source (scripts/sql-statements.mjs) rather
// than listed here, so a newly added query is covered without anyone adding it.
//
// What counts as a finding: SQLite writes "SCAN" both for walking a table with no
// usable index and for walking an index in order. Only the first is a defect, so the
// rule is a bare `SCAN <table>` with no ` USING INDEX` and no ` VIRTUAL TABLE`, on
// one of the tables that grows without bound.

const HOT_TABLES = [
  "documents",
  "document_links",
  "document_versions",
  "audit_log",
  "improve_runs",
  "improve_attempts",
  "improve_scores",
  "improve_skills",
  "improve_jti",
];

// Reads that walk a whole table on purpose, each named with its reason, so a new
// exception has to be added here explicitly.
const WHOLE_TABLE_BY_DESIGN = [
  { file: "backup.ts", sql: /^SELECT \* FROM /i, why: "the nightly dump reads every row of a table on purpose" },
  {
    file: "console-activity.ts",
    sql: /^SELECT at, actor, action, namespace, path FROM audit_log WHERE 1 = 1 ORDER BY id DESC LIMIT/i,
    why:
      "the console's UNFILTERED activity read. With no WHERE and ORDER BY id DESC LIMIT 50, SQLite walks the rowid " +
      "b-tree backwards and stops at 50 rows: the plan carries NO TEMP B-TREE, so nothing is sorted, and it reads " +
      "LIMIT rows rather than the table. No index improves on reading the last 50 rowids. The FILTERED variants of " +
      "this same statement are not exempt and are checked by name below, because those are the ones that could scan.",
  },
];

function arity(sql: string): number {
  const numbered = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
  if (numbered.length > 0) return Math.max(...numbered);
  return (sql.match(/\?/g) ?? []).length;
}

// A bare table scan: "SCAN <name>" with nothing after it. "SCAN x USING INDEX y"
// is an index scan and "SCAN documents_fts VIRTUAL TABLE INDEX 0:M2" is how FTS
// reports a MATCH; neither is a defect.
function bareScan(detail: string): string | null {
  const match = /^SCAN ([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(detail.trim());
  return match ? match[1] : null;
}

async function planOf(sql: string): Promise<{ details: string[] } | { error: string }> {
  try {
    const result = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...new Array(arity(sql)).fill("x"))
      .all<{ detail: string }>();
    return { details: result.results.map((r) => r.detail) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const reads = () => env.TEST_SQL_STATEMENTS.filter((s) => /^SELECT\b/i.test(s.sql));

describe("query plans", () => {
  it("the walk found the statements at all, so nothing below can pass by reading nothing", () => {
    // Every src/ file that calls `.prepare(` (listed by a separate fs walk in
    // vitest.config.ts) must have yielded at least one statement, extracted or
    // skipped. That catches the walk missing a file or directory without a fixed
    // floor that breaks when statements move between files.
    const files = env.TEST_SQL_PREPARE_FILES;
    expect(files.length, "no src/ file calls .prepare(; the file listing is broken").toBeGreaterThan(0);
    const seen = new Set([...env.TEST_SQL_STATEMENTS, ...env.TEST_SQL_SKIPPED].map((s) => s.file));
    const unseen = files.filter((f) => !seen.has(f));
    expect(unseen, `files that call .prepare( but yielded no statement: ${unseen.join(", ")}`).toEqual([]);
    expect(reads().length, "no SELECTs among them").toBeGreaterThan(0);
    // A statement the walk could not reconstruct is reported rather than dropped, so
    // the plan check cannot quietly cover only part of the reads.
    expect(
      env.TEST_SQL_SKIPPED.length,
      `${env.TEST_SQL_SKIPPED.length} statements could not be reconstructed: ${env.TEST_SQL_SKIPPED.map((s) => `${s.file}: ${s.sql.slice(0, 70)}`).join(" | ")}`
      // Three: advanceRun's built SET list, and two .prepare() calls that take an
      // expression (backup.ts's dump, improve/open.ts's attempt read).
    ).toBeLessThanOrEqual(3);
  });

  it("every read PLANS at all, so a statement the schema rejects is a build failure", async () => {
    const broken: string[] = [];
    for (const statement of reads()) {
      const plan = await planOf(statement.sql);
      if ("error" in plan) broken.push(`${statement.file}: ${plan.error} :: ${statement.sql.slice(0, 90)}`);
      else if (plan.details.length === 0) broken.push(`${statement.file}: empty plan :: ${statement.sql.slice(0, 90)}`);
    }
    expect(broken, broken.join("\n")).toEqual([]);
  });

  it("PLANT: no read bare-scans a table that grows without bound", async () => {
    const findings: string[] = [];
    for (const statement of reads()) {
      const exempt = WHOLE_TABLE_BY_DESIGN.some((e) => e.file === statement.file && e.sql.test(statement.sql));
      if (exempt) continue;
      const plan = await planOf(statement.sql);
      if ("error" in plan) continue; // the previous test owns that failure
      for (const detail of plan.details) {
        const table = bareScan(detail);
        if (table && HOT_TABLES.includes(table)) {
          findings.push(`${statement.file} :: ${detail} :: ${statement.sql.slice(0, 120)}`);
        }
      }
    }
    expect(findings, `bare table scans on growing tables:\n${findings.join("\n")}`).toEqual([]);
  });

  it("PLANT: the two hottest reads use the indexes 0005 added, by name", async () => {
    // `id DESC` inside these indexes lets the LIMIT 1 stop at the first entry instead
    // of sorting; a plan that says SEARCH but then TEMP B-TREE FOR ORDER BY has lost that.
    const lastActor = await planOf(
      "SELECT actor FROM audit_log WHERE namespace = ?1 AND path = ?2 ORDER BY id DESC LIMIT 1"
    );
    expect("details" in lastActor).toBe(true);
    const actorPlan = ("details" in lastActor ? lastActor.details : []).join(" | ");
    expect(actorPlan).toContain("audit_log_doc");
    expect(actorPlan).not.toContain("TEMP B-TREE");

    const prune = await planOf("SELECT COUNT(*) AS n FROM document_versions WHERE snapshot_at < datetime('now', ?1)");
    const prunePlan = ("details" in prune ? prune.details : []).join(" | ");
    expect(prunePlan).toContain("document_versions_snapshot");
  });

  // The walker substitutes an optional `${clause}` with `WHERE 1 = 1`, but a filter
  // can change the plan, not only narrow it: with `WHERE namespace = ?` the activity
  // read can pick an index whose id ordering is out of reach and sort every row to
  // take the newest 50. So the filtered variants are checked here by name.
  const ACTIVITY_VARIANTS: Array<[string, string, number, string]> = [
    [
      "by namespace",
      "SELECT at, actor, action, namespace, path FROM audit_log WHERE namespace = ?1 ORDER BY id DESC LIMIT ?2",
      2,
      "audit_log_ns_recent",
    ],
    [
      "by actor",
      "SELECT at, actor, action, namespace, path FROM audit_log WHERE actor = ?1 ORDER BY id DESC LIMIT ?2",
      2,
      "audit_log_actor_recent",
    ],
    [
      "by both",
      "SELECT at, actor, action, namespace, path FROM audit_log WHERE namespace = ?1 AND actor = ?2 ORDER BY id DESC LIMIT ?3",
      3,
      "audit_log_ns_recent",
    ],
  ];

  it("PLANT: every FILTERED activity read uses an index and sorts nothing", async () => {
    for (const [label, sql, n, index] of ACTIVITY_VARIANTS) {
      const result = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...new Array(n).fill("x"))
        .all<{ detail: string }>();
      const plan = result.results.map((r) => r.detail).join(" | ");
      expect(plan, `activity ${label} does not use ${index}`).toContain(index);
      expect(plan, `activity ${label} sorts its rows to honour the LIMIT`).not.toContain("TEMP B-TREE");
    }
  });

  it("PLANT: the reputation aggregations group in index order, not through a temp b-tree", async () => {
    for (const sql of [
      "SELECT actor, COUNT(*) AS n FROM audit_log WHERE action = 'open_pr' GROUP BY actor",
      `SELECT actor, COUNT(*) AS n FROM audit_log WHERE action = 'manage_pr' AND params LIKE '%"merged":true%' GROUP BY actor`,
    ]) {
      const result = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>();
      const plan = result.results.map((r) => r.detail).join(" | ");
      expect(plan, `${sql.slice(0, 60)} does not use audit_log_action_actor`).toContain("audit_log_action_actor");
      expect(plan, `${sql.slice(0, 60)} builds a temp b-tree to group`).not.toContain("TEMP B-TREE");
    }
  });
});
