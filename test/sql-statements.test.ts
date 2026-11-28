import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractStatements } from "../scripts/sql-statements.ts";

function extractFrom(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "sql-statements-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, "utf8");
    return extractStatements(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the extractor skips a statement with a hole or on an expression, and finds one after a skipped one or a line comment", () => {
  for (const [label, text, sqls, skipped] of [
    [
      "a hole, then another",
      "db.prepare(`UPDATE docs SET ${sets} WHERE id = ?1 AND padding_padding_padding = 1`);\ndb.prepare(`SELECT id FROM docs WHERE ${odd} = 1`);",
      [],
      2,
    ],
    [
      "a line comment before the string",
      'db.prepare(\n  // why\n  "SELECT id FROM docs WHERE id = ?1"\n);\n',
      ["SELECT id FROM docs WHERE id = ?1"],
      0,
    ],
    [
      "an expression, then a plain statement",
      'db.prepare(flag ? `SELECT 1 FROM docs` : `SELECT 2 FROM docs`);\ndb.prepare("SELECT id FROM docs");\n',
      ["SELECT id FROM docs"],
      1,
    ],
  ] as const) {
    const out = extractFrom({ "a.ts": text });
    assert.deepEqual(
      out.statements.map((s) => s.sql),
      sqls,
      label,
    );
    assert.equal(out.skipped.length, skipped, label);
  }
});
