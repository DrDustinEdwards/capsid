import assert from "node:assert/strict";
import { globSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// `npm run lint:docs`: a document that falls behind the code fails here.

const ROOT = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

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
