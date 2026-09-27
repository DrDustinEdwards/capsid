import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// capsid/research/design-seat-session-hardening.md, PR 5: the canary. The weakened
// workflow is the only place the probe runs with every layer off, so what it may hold
// and what it must see are decided by its text. These read it, and the probe.

const root = join(import.meta.dirname, "..");
const strip = (text: string) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
const WEAK = strip(readFileSync(join(root, ".github", "workflows", "seat-session-canary-weakened.yml"), "utf8"));
const SESSION = strip(readFileSync(join(root, ".github", "workflows", "seat-session.yml"), "utf8"));
const PROBE = readFileSync(join(root, "test", "canary", "probe.canary.ts"), "utf8");

test("the weakened canary holds nothing real: hand-started, no secret, no environment, read-only", () => {
  const on = /^on:\n([\s\S]*?)\n\S/m.exec(WEAK);
  assert.ok(on, "no on: block parsed");
  assert.deepEqual([...on[1].matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]), ["workflow_dispatch"]);
  assert.doesNotMatch(WEAK, /secrets\./, "the weakened run reads a secret");
  assert.doesNotMatch(WEAK, /^\s+environment:/m, "the weakened run names an environment, which could hold the session's secrets");
  assert.match(WEAK, /^permissions:\n {2}contents: read\n\n/m);
  // The planted credentials are fakes, by their own spelling.
  for (const m of WEAK.matchAll(/^\s+(CLAUDE_CODE_OAUTH_TOKEN|GITHUB_TOKEN): (.+)$/gm)) assert.equal(m[2], "canary-not-a-token", `${m[1]} is not the fake`);
  assert.match(WEAK, /"Authorization":"Bearer canary-not-a-key"/);
});

test("the weakened canary runs the same harden-runner pin as the session, first", () => {
  const pin = /uses: (step-security\/harden-runner@[0-9a-f]{40})/.exec(SESSION)?.[1];
  assert.ok(pin, "no harden-runner pin in the session workflow");
  const firstStep = WEAK.slice(WEAK.indexOf("\n    steps:\n")).split(/\n {6}- /)[1] ?? "";
  assert.ok(firstStep.startsWith(`uses: ${pin}`), "the weakened canary's first step is not the session's harden-runner pin");
});

// Every probe but the OIDC one (the weakened job has no id-token permission) must read
// true without the layers, or the hardened run's false for it proves nothing.
test("the weakened canary requires every probe to see its exposure", () => {
  const block = /const result: Record<string, boolean> = \{([\s\S]*?)\n {2}\};/.exec(PROBE);
  assert.ok(block, "no result object parsed in the probe");
  const probes = [...block[1].matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]);
  assert.ok(probes.length >= 10, `only ${probes.length} probes parsed`);
  const required = /const mustBeTrue = \[([^\]]*)\]/.exec(WEAK);
  assert.ok(required, "no mustBeTrue list in the weakened canary");
  const listed = [...required[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual([...listed].sort(), probes.filter((p) => p !== "oidc_request_in_env").sort());
});

test("the probe reports booleans on one line and is not part of the default suite", () => {
  assert.match(PROBE, /console\.log\(`CANARY_RESULT \$\{JSON\.stringify\(result\)\}`\)/);
  assert.equal([...PROBE.matchAll(/console\.(log|error|info|warn)\(/g)].length, 1, "the probe prints something besides its result line");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts.test, /"test\/\*\.test\.ts"/);
});
