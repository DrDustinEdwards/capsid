import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractStatements } from "../scripts/sql-statements.mjs";

// Audit 2026-09-25, E2-30 (finding E2-L23). The statement walk that feeds the query-plan
// check (vitest.config.ts, test-integration/query-plans.test.ts).

function extractFrom(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "sql-statements-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, "utf8");
    return extractStatements(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a statement after a skipped one still has its hole found", () => {
  // The hole regex was global, so after a skipped statement its lastIndex sat past the
  // start of the next one and the next statement's hole could be missed, which kept
  // `${...}` in SQL handed to the plan check as if it were plannable.
  const { statements, skipped } = extractFrom({
    "a.ts": [
      "db.prepare(`UPDATE improve_runs SET ${sets.join(', ')} WHERE id = ?1 AND padding_padding_padding = 1`);",
      "db.prepare(`SELECT id FROM jobs WHERE ${odd} = 1`);",
    ].join("\n"),
  });
  const withHole = statements.filter((s) => s.sql.includes("${"));
  assert.deepEqual(withHole, [], "a statement with an unsubstituted hole was returned as plannable");
  assert.equal(skipped.length, 2);
});

test("a statement with a line comment before its string is extracted", () => {
  const { statements, skipped } = extractFrom({
    "c.ts": 'db.prepare(\n  // why this query is shaped this way\n  "SELECT id FROM jobs WHERE id = ?1"\n);\n',
  });
  assert.deepEqual(statements.map((s) => s.sql), ["SELECT id FROM jobs WHERE id = ?1"]);
  assert.deepEqual(skipped, []);
});

test("a prepare call on an expression is counted as skipped", () => {
  const { statements, skipped } = extractFrom({
    "b.ts": 'db.prepare(flag ? `SELECT 1 FROM jobs` : `SELECT 2 FROM jobs`);\ndb.prepare("SELECT id FROM jobs");\n',
  });
  assert.equal(statements.length, 1);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].sql, /^\(expression\) flag \?/);
});
