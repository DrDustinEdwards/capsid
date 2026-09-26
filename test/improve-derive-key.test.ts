import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deriveScoreKey } from "../src/improve-scorer.ts";
import { ROSTER } from "../src/improve-schema.ts";

// The script and the Worker must derive the same key.
//
// scripts/improve-derive-key.mjs computes the repo secret; src/improve-scorer.ts
// verifies reports against it. The script is a plain .mjs that cannot import the
// TypeScript module, so it restates the derivation; drift would be silent until a
// report failed to verify. The two are compared here by running the script.

const SCRIPT = join(import.meta.dirname, "..", "scripts", "improve-derive-key.mjs");
const ROOT = "a-test-root-secret";

// spawnSync rather than execFileSync, because both streams are needed on both paths:
// execFileSync returns stdout only and throws on a non-zero exit.
function run(namespace: string, env: Record<string, string | undefined> = {}): { stdout: string; status: number; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, namespace], {
    encoding: "utf8",
    env: { ...process.env, IMPROVE_SCORE_SECRET: ROOT, ...env },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

test("THE SCRIPT DERIVES EXACTLY WHAT THE WORKER VERIFIES, for every roster namespace", async () => {
  for (const namespace of ROSTER) {
    const result = run(namespace);
    assert.equal(result.status, 0, `the script failed for ${namespace}: ${result.stderr}`);
    assert.equal(
      result.stdout.trim(),
      await deriveScoreKey(ROOT, namespace),
      `the script and src/improve-scorer.ts disagree for ${namespace}`
    );
  }
});

test("stdout is JUST the key, so it can be piped straight into gh secret set", () => {
  const result = run("capsid");
  assert.match(result.stdout, /^[0-9a-f]{64}\n$/, `stdout was not a bare key: ${JSON.stringify(result.stdout)}`);
  // Everything explanatory goes to stderr, which is why stdout stays pipeable.
  assert.match(result.stderr, /Set it as the repo secret IMPROVE_SCORE_KEY/);
});

test("IT NEVER PRINTS THE ROOT SECRET, on any path", () => {
  for (const args of [["capsid"], ["not-a-namespace"], [""]]) {
    const result = run(args[0]);
    assert.equal(result.stdout.includes(ROOT), false, "the root secret reached stdout");
    assert.equal(result.stderr.includes(ROOT), false, "the root secret reached stderr");
  }
});

test("an off-roster namespace is refused, so a secret cannot be set on the wrong repo", () => {
  const result = run("julieedwards");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is not on the improve roster/);
  assert.equal(result.stdout.trim(), "");
});

test("a missing root secret is refused, and says there is no way to read one back", () => {
  const result = run("capsid", { IMPROVE_SCORE_SECRET: undefined });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /IMPROVE_SCORE_SECRET is not set/);
  assert.match(result.stderr, /no way to read a Worker secret back/);
});

// A key derived from spaces would fail every report.
test("a whitespace-only root secret is refused like a missing one", () => {
  const result = run("capsid", { IMPROVE_SCORE_SECRET: "  \t " });
  assert.notEqual(result.status, 0, "a key was derived from a blank secret");
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /IMPROVE_SCORE_SECRET is not set/);
});

test("THE ROSTER IN THE SCRIPT MATCHES THE ROSTER IN SOURCE", () => {
  // The script cannot import the TypeScript module, so it restates the list. Drift
  // would refuse a legitimate namespace.
  const script = readFileSync(SCRIPT, "utf8");
  const declared = /const ROSTER = \[([^\]]+)\]/.exec(script);
  assert.ok(declared, "scripts/improve-derive-key.mjs no longer declares a ROSTER");
  const inScript = [...declared[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(inScript, [...ROSTER].sort());
});
