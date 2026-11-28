import assert from "node:assert/strict";
import { globSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TABLES } from "../../src/backup.ts";

// `npm run lint:docs`: a document that falls behind the code fails here.

const ROOT = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function restoreRunbook(): string {
  const doc = read("docs/backups.md");
  const from = doc.indexOf("## Restore");
  assert.ok(from >= 0, "docs/backups.md no longer has a Restore section");
  const runbook = doc.slice(from);
  assert.ok(
    runbook.length > 1000,
    `the restore runbook came back nearly empty (${runbook.length} chars)`,
  );
  return runbook;
}

test("the restore runbook names every backed-up table", () => {
  const restore = restoreRunbook();
  assert.ok(TABLES.length >= 9, `TABLES lists only ${TABLES.length} tables`);
  for (const table of TABLES) {
    assert.match(restore, new RegExp(`\\b${table}\\b`), `the restore runbook never names ${table}`);
  }
});

test("the restore runbook applies EVERY migration, derived from the directory", () => {
  const restore = restoreRunbook();
  const migrations = readdirSync(join(ROOT, "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  assert.ok(migrations.length >= 4, "the migration scan found almost nothing");
  for (const file of migrations) {
    assert.ok(
      restore.includes(file),
      `the runbook never names ${file}, so a restore that follows it stops short`,
    );
  }
});

test("the README links every document under docs/", () => {
  const readme = read("README.md");
  const docs = readdirSync(join(ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .sort();
  assert.ok(docs.length >= 10, `the docs scan found only ${docs.length} files`);
  for (const name of docs) {
    assert.ok(readme.includes(`docs/${name}`), `README never links docs/${name}`);
  }
});

test("every .claude/rules/ file is path-scoped to globs that match files, so it loads somewhere", () => {
  const files = readdirSync(join(ROOT, ".claude", "rules")).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 3, `the rules scan found only ${files.length} files`);
  for (const file of files) {
    const text = read(`.claude/rules/${file}`);
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const list = front ? /^paths:\s*\r?\n((?:[ \t]+-[^\n]*\r?\n?)+)/m.exec(front[1]) : null;
    assert.ok(
      list,
      `.claude/rules/${file} has no paths frontmatter, so it would load in every session`,
    );
    const globs = [...list[1].matchAll(/-\s*["']?([^"'\r\n]+?)["']?\s*$/gm)].map((m) => m[1]);
    assert.ok(globs.length > 0, `.claude/rules/${file} lists no paths`);
    for (const g of globs) {
      const hits = globSync(g, { cwd: ROOT, exclude: (p: string) => p.includes("node_modules") });
      assert.ok(
        hits.length > 0,
        `.claude/rules/${file}: "${g}" matches no file, so it never loads for that path`,
      );
    }
  }
});
