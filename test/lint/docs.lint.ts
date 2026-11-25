import assert from "node:assert/strict";
import { globSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TABLES } from "../../src/backup.ts";
import { AUTHORITATIVE } from "../../src/counts.ts";

// Run by `npm run lint:docs` in CI's checks job, not `npm test`: these read prose and fail when a document
// falls behind the code, each count derived from its source of truth.

const ROOT = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// The runbook runs to the end of docs/backups.md; asserted non-empty so a renamed heading fails loudly
// instead of scanning an empty string.
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
  // A restore that applies only 0001/0002 loses the improve tables.
  // Not after a hyphen: "twenty-five real tables" is not "five real tables".
  assert.doesNotMatch(
    restore,
    /(?<![\w-])five real tables\b/i,
    "the runbook still says five real tables",
  );
  assert.doesNotMatch(
    restore,
    /The five tables are\b/i,
    "the runbook still enumerates only five tables",
  );
});

test("the restore runbook states the table count TABLES actually has", () => {
  const restore = restoreRunbook();
  // The count is spelled out in prose in three places. Derived from TABLES, so the
  // next addition fails here rather than being found during a restore.
  const words = [
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
    "twenty",
    "twenty-one",
    "twenty-two",
    "twenty-three",
    "twenty-four",
    "twenty-five",
    "twenty-six",
    "twenty-seven",
    "twenty-eight",
    "twenty-nine",
    "thirty",
    "thirty-one",
    "thirty-two",
    "thirty-three",
    "thirty-four",
    "thirty-five",
    "thirty-six",
    "thirty-seven",
    "thirty-eight",
    "thirty-nine",
    "forty",
  ];
  const correct = words[TABLES.length - 5];
  assert.ok(correct, `TABLES has ${TABLES.length} entries, outside the words this check can spell`);
  for (const [i, word] of words.entries()) {
    if (i === TABLES.length - 5) continue;
    assert.doesNotMatch(
      restore,
      new RegExp(`(?<![\\w-])${word} (real )?tables?\\b`, "i"),
      `the runbook says "${word} tables" and there are ${TABLES.length}`,
    );
    assert.doesNotMatch(
      restore,
      new RegExp(`(?<![\\w-])${word} exports\\b`, "i"),
      `the runbook says "${word} exports"`,
    );
  }
  assert.match(
    restore,
    new RegExp(`(?<![\\w-])${correct} `, "i"),
    `the runbook never states the count as ${correct}`,
  );
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

test("the restore runbook names the KV pins sidecar", () => {
  // A restore that rebuilds D1 and stops leaves the KV pins behind.
  const restore = restoreRunbook();
  assert.match(restore, /_kv\.json/, "the runbook does not mention the KV pins sidecar");
});

test("the README links every document under docs/", () => {
  // A doc nobody links reads as deleted. Derived from the directory, so a new doc
  // fails here until the README points at it.
  const readme = read("README.md");
  const docs = readdirSync(join(ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .sort();
  assert.ok(docs.length >= 10, `the docs scan found only ${docs.length} files`);
  for (const name of docs) {
    assert.ok(readme.includes(`docs/${name}`), `README never links docs/${name}`);
  }
});

test("the README states the authoritative tool count", () => {
  const readme = read("README.md");
  assert.match(
    readme,
    new RegExp(`\\b${AUTHORITATIVE.capsid.tools} tools\\b`),
    `README does not state the current tool count (${AUTHORITATIVE.capsid.tools})`,
  );
});

// CLAUDE.md loads whole in every session, so it holds only what is true of this repo and stays under 5KB;
// detail lives in path-scoped .claude/rules/.
const CLAUDE_MD_CAP_BYTES = 5 * 1024;

test("CLAUDE.md stays under 5KB", () => {
  const bytes = Buffer.byteLength(read("CLAUDE.md"), "utf8");
  assert.ok(bytes > 500, `CLAUDE.md read as ${bytes} bytes, which is not the file`);
  assert.ok(
    bytes <= CLAUDE_MD_CAP_BYTES,
    `CLAUDE.md is ${bytes} bytes, over ${CLAUDE_MD_CAP_BYTES}: move detail into a path-scoped .claude/rules/ file`,
  );
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
