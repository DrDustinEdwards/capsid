import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// The docs describe a private store in a public repo: no secret, key, hash or infrastructure identifier may appear.

const ROOT = join(import.meta.dirname, "..");
const DOCS = join(ROOT, "docs");
const read = (name: string) => readFileSync(join(DOCS, name), "utf8");

// The two guards below read every file in docs/, so an empty listing would pass them.
const docFiles = () => {
  const files = readdirSync(DOCS).filter((f) => f.endsWith(".md"));
  assert.ok(files.length > 0, "docs/ holds no .md files, so the guards below read nothing");
  return files;
};

test("PLANT: no public doc carries a secret, a key, a credential or an infrastructure identifier", () => {
  // A hash is included because a stored sha256 is a key's verifier.
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
  // A Cloudflare resource id is not a secret, but a public doc does not need one; the
  // example config carries placeholders for this reason.
  for (const file of docFiles()) {
    const text = read(file);
    assert.doesNotMatch(
      text,
      /\b[0-9a-f]{32}\b/,
      `docs/${file} contains something shaped like a Cloudflare resource id`,
    );
    assert.doesNotMatch(
      text,
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/,
      `docs/${file} contains a UUID`,
    );
  }
});
