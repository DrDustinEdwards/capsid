import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// Deliberately narrower than the rule: a phrase list cannot catch a flourish it has never seen, and comments
// and commit messages are not scanned. Removing a phrase needs a reason written down.

const ROOT = join(import.meta.dirname, "..");
const DOCS = join(ROOT, "docs");

const BANNED: Array<[RegExp, string]> = [
  [/\bload[- ]bearing\b/i, '"load-bearing" (say "important", or name what breaks without it)'],
  [/\bearns its keep\b/i, '"earns its keep" (say "still matters")'],
  [
    /\b(?:it's|it is|this isn't|this is not)\s+not\b[^.!?\n]{1,60}?,\s*(?:it's|it is)\b/i,
    "the \"it's not X, it's Y\" construction (state what it is, and stop)",
  ],
];

function scannable(): Array<{ rel: string; text: string }> {
  const files = [{ rel: "README.md", text: readFileSync(join(ROOT, "README.md"), "utf8") }];
  for (const name of readdirSync(DOCS)
    .filter((f) => f.endsWith(".md"))
    .sort()) {
    files.push({ rel: `docs/${name}`, text: readFileSync(join(DOCS, name), "utf8") });
  }
  return files;
}

test("no mannered prose in README.md or docs/", () => {
  const hits: string[] = [];
  const files = scannable();
  // A glob that matched nothing, or a docs/ that moved, must not pass by reading nothing.
  assert.ok(files.length >= 10, `expected README.md plus the docs, scanned ${files.length} files`);
  for (const { rel, text } of files) {
    const lines = text.split("\n");
    for (const [pattern, what] of BANNED) {
      for (const [i, line] of lines.entries()) {
        const m = pattern.exec(line);
        if (m) hits.push(`${rel}:${i + 1} uses ${what}\n      ${line.trim().slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(
    hits,
    [],
    `mannered prose found (capsid/conventions.md, Writing style):\n    ${hits.join("\n    ")}`,
  );
});
