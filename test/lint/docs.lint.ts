import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TABLES } from "../../src/backup.ts";
import { AUTHORITATIVE } from "../../src/counts.ts";

// The doc-drift lint. Run by `npm run lint:docs` (and `npm run lint`), in the checks
// job of .github/workflows/ci.yml; not part of `npm test`. These read prose, so they
// fail when a document falls behind the code rather than when the Worker misbehaves.
// Each count is derived from its source of truth (TABLES, migrations/, docs/,
// src/counts.ts), so the next drift fails here.

const ROOT = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// The runbook is the Restore section of docs/backups.md, which runs to the end of
// that file. Asserted non-empty so a renamed heading fails loudly instead of
// scanning an empty string.
function restoreRunbook(): string {
  const doc = read("docs/backups.md");
  const from = doc.indexOf("## Restore");
  assert.ok(from >= 0, "docs/backups.md no longer has a Restore section");
  const runbook = doc.slice(from);
  assert.ok(runbook.length > 1000, `the restore runbook came back nearly empty (${runbook.length} chars)`);
  return runbook;
}

test("the restore runbook names every backed-up table", () => {
  const restore = restoreRunbook();
  assert.ok(TABLES.length >= 9, `TABLES lists only ${TABLES.length} tables`);
  for (const table of TABLES) {
    assert.match(restore, new RegExp(`\\b${table}\\b`), `the restore runbook never names ${table}`);
  }
  // A restore that applies only 0001/0002 loses the improve tables.
  assert.doesNotMatch(restore, /\bfive real tables\b/i, "the runbook still says five real tables");
  assert.doesNotMatch(restore, /The five tables are\b/i, "the runbook still enumerates only five tables");
});

test("the restore runbook states the table count TABLES actually has", () => {
  const restore = restoreRunbook();
  // The count is spelled out in prose in three places. Derived from TABLES, so the
  // next addition fails here rather than being found during a restore.
  const words = ["five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen"];
  const correct = words[TABLES.length - 5];
  assert.ok(correct, `TABLES has ${TABLES.length} entries, outside the words this check can spell`);
  for (const [i, word] of words.entries()) {
    if (i === TABLES.length - 5) continue;
    assert.doesNotMatch(
      restore,
      new RegExp(`\\b${word} (real )?tables?\\b`, "i"),
      `the runbook says "${word} tables" and there are ${TABLES.length}`
    );
    assert.doesNotMatch(restore, new RegExp(`\\b${word} exports\\b`, "i"), `the runbook says "${word} exports"`);
  }
  assert.match(restore, new RegExp(`\\b${correct} `, "i"), `the runbook never states the count as ${correct}`);
});

test("the restore runbook applies EVERY migration, derived from the directory", () => {
  const restore = restoreRunbook();
  const migrations = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(migrations.length >= 4, "the migration scan found almost nothing");
  for (const file of migrations) {
    assert.ok(restore.includes(file), `the runbook never names ${file}, so a restore that follows it stops short`);
  }
});

test("the restore runbook names the two dump sidecars", () => {
  // The dump carries the KV pins and the holdout manifests. A restore that
  // rebuilds D1 and stops leaves the improve loop with no mode, no
  // anchor pins and no manifests, which is a loop that refuses every run.
  const restore = restoreRunbook();
  assert.match(restore, /_kv\.json/, "the runbook does not mention the KV pins sidecar");
  assert.match(restore, /_holdout-manifests\.json/, "the runbook does not mention the holdout manifests sidecar");
});

test("the README links every document under docs/", () => {
  // A doc nobody links reads as deleted. Derived from the directory, so a new doc
  // fails here until the README points at it.
  const readme = read("README.md");
  const docs = readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).sort();
  assert.ok(docs.length >= 10, `the docs scan found only ${docs.length} files`);
  for (const name of docs) {
    assert.ok(readme.includes(`docs/${name}`), `README never links docs/${name}`);
  }
});

test("the README states the authoritative tool count", () => {
  // The count lives in src/counts.ts and the README quotes it.
  const readme = read("README.md");
  assert.match(
    readme,
    new RegExp(`\\b${AUTHORITATIVE.capsid.tools} tools\\b`),
    `README does not state the current tool count (${AUTHORITATIVE.capsid.tools})`
  );
});
