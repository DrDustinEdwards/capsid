import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

// Cloudflare's Workers best-practices guide says to enable no-floating-promises: a
// promise started and dropped loses its rejection, and in a Worker it can outlive the
// request (https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
// The rule needs type information, so it runs through oxlint's type-aware mode
// (oxlint-tsgolint), configured in .oxlintrc.json to that one rule. Run by
// `npm run lint`, in the checks job of .github/workflows/ci.yml, with no workflow edit.

const ROOT = join(import.meta.dirname, "..", "..");
const OXLINT = join(ROOT, "node_modules", "oxlint", "bin", "oxlint");

function oxlint(args: string[]): { status: number | null; output: string } {
  const run = spawnSync(process.execPath, [OXLINT, "--type-aware", "-c", join(ROOT, ".oxlintrc.json"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 240_000,
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

test("src/ has no floating promise", () => {
  const run = oxlint(["--tsconfig", "tsconfig.json", "src"]);
  assert.equal(run.status, 0, `oxlint found a floating promise, or did not run:\n${run.output}`);
});

// The check is trusted only after it is seen failing. This keeps that proof in the suite:
// the fixture holds one dropped promise and four handled ones, and the rule must flag
// exactly the dropped one. Without it, a config that quietly turned the rule off would
// leave the test above green on an empty scan.
test("the rule flags a dropped promise and passes awaited, returned, caught and void ones", () => {
  const fixture = join("test", "lint", "fixtures", "floating-promises");
  const run = oxlint(["--tsconfig", join(fixture, "tsconfig.json"), fixture]);
  assert.equal(run.status, 1, `expected the fixture to fail:\n${run.output}`);
  assert.match(run.output, /bad\.ts:\d+:\d+/, "bad.ts was not flagged");
  assert.doesNotMatch(run.output, /good\.ts/, "a handled promise in good.ts was flagged");
  assert.equal((run.output.match(/no-floating-promises/g) ?? []).length, 1, `expected exactly one finding:\n${run.output}`);
});
