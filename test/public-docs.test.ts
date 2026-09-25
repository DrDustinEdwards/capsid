import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// THE PUBLIC DOCS, AND THE ONE THING THAT MUST NEVER BE IN THEM.
//
// docs/ exists so a stranger can understand this system from the repository
// alone. That makes it the one directory in a public MIT repo whose whole purpose
// is to describe a private store, which is exactly the shape that leaks something.
// These tests are the guard on that boundary: no secret, no key, no hash and no
// infrastructure identifier in any file under docs/. The improve_run mint tests
// that used to live here are in test/improve-run-mint.test.ts.

const ROOT = join(import.meta.dirname, "..");
const DOCS = join(ROOT, "docs");
const read = (name: string) => readFileSync(join(DOCS, name), "utf8");

// The two guards below read every file in docs/, so an empty listing would pass them.
const docFiles = () => {
  const files = readdirSync(DOCS).filter((f) => f.endsWith(".md"));
  assert.ok(files.length > 0, "docs/ holds no .md files, so the guards below read nothing");
  return files;
};

test("PLANT: no public doc carries a secret, a key or a real credential", () => {
  // The shapes that would actually matter. A hash is included because
  // OPERATOR_KEY_HASH is the verifier: publishing one is publishing the check.
  const forbidden: Array<[RegExp, string]> = [
    [/sk-ant-[A-Za-z0-9_-]{10,}/, "an Anthropic key"],
    [/ghp_[A-Za-z0-9]{20,}/, "a GitHub token"],
    [/github_pat_[A-Za-z0-9_]{20,}/, "a GitHub fine-grained token"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
    [/\bro:[0-9a-f]{32,}/, "a minted read-only operator key"],
    [/\b[0-9a-f]{64}\b/, "something shaped like a sha256 hash"],
  ];
  for (const file of docFiles()) {
    const text = read(file);
    for (const [pattern, what] of forbidden) {
      assert.doesNotMatch(text, pattern, `docs/${file} contains ${what}`);
    }
  }
});

test("PLANT: no public doc carries private infrastructure identifiers", () => {
  // A Cloudflare resource id is not a secret, and it is also not something a
  // public doc needs. The example config carries placeholders for exactly this
  // reason; the docs should not undo that.
  for (const file of docFiles()) {
    const text = read(file);
    assert.doesNotMatch(text, /\b[0-9a-f]{32}\b/, `docs/${file} contains something shaped like a Cloudflare resource id`);
    // A UUID, which is what a D1 database id looks like.
    assert.doesNotMatch(
      text,
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/,
      `docs/${file} contains a UUID`
    );
  }
});
