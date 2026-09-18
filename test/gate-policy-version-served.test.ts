import assert from "node:assert/strict";
import { test } from "node:test";
import { improveStatus } from "../src/improve-run.ts";
import { GATE_POLICY_PATH } from "../src/gate-policy.ts";
import {
  AUTO_MERGE_POLICY_PATH,
  AUTO_MERGE_REFUSED_PATHS,
  AUTO_MERGE_REQUIRED_CI,
  POLICY_CHECKS,
  requiredCiLabel,
} from "../src/auto-merge.ts";
import { signTaskBody } from "../src/improve-task.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2, type DocRow } from "./fakes.ts";

// EVERY DRIVER CAN LEARN THE POLICY VERSION IT MUST APPROVE UNDER.
//
// /improve step 4b tells a driver to read capsid/policy/gates.md and pass its version
// as approved_by_policy. A namespace-scoped driver cannot read the capsid namespace,
// so every driver except capsid's was refused at that first step with
// "agent:claude-skills-driver is not scoped to the 'capsid' namespace", had nothing to
// pass, and rightly refused to guess. Measured on claude-skills job_33d90163ad1e,
// 2026-09-17.
//
// The fix serves the version and the enabled flag, and nothing else: not the body, not
// the classes, not the never list. A driver needs to name the version it is approving
// under. Reading the policy itself stays scoped to capsid.

const SECRET = "test-improve-secret";

const GATES = [
  "# Pre-approved gates",
  "",
  "- version: 7",
  "- enabled: true",
  "",
  "## Classes",
  "",
  "- `additive_migration` an additive migration.",
  "- `push_branch` a branch push.",
  "- `open_pr` a pull request.",
].join("\n");

// Built from the code's own lists rather than retyped. loadMergePolicy refuses a
// document that describes less than the code enforces, which is the behaviour being
// relied on two tests below, so a hand-written short fixture would only ever exercise
// the refusal.
const AUTO_MERGE = [
  "# Auto-merge policy",
  "",
  "- version: 3",
  "- enabled: true",
  "- namespaces: capsid",
  "",
  "## Checks",
  "",
  ...POLICY_CHECKS.map((c) => `- \`${c}\` enforced.`),
  "",
  "## Refused paths",
  "",
  ...AUTO_MERGE_REFUSED_PATHS.map(({ pattern, why }) => `- path \`${pattern.source}\` ${why}.`),
  "",
  "## Required CI",
  "",
  ...AUTO_MERGE_REQUIRED_CI.map((r) => `- step \`${requiredCiLabel(r)}\``),
].join("\n");

async function envWith(documents: DocRow[], secret: string | undefined = SECRET) {
  const d1 = fakeD1({ documents });
  return fakeEnv({
    DB: d1.db,
    APP_KV: fakeKv({}).kv,
    MEDIA: fakeR2().bucket,
    HOLDOUT: fakeR2().bucket,
    IMPROVE_SCORE_SECRET: secret,
  });
}

async function signedDoc(path: string, body: string): Promise<DocRow> {
  return { namespace: "capsid", path, title: path, type: "procedural", body: await signTaskBody(SECRET, body) };
}

test("a driver scoped to ANOTHER namespace is still served the gates policy version", async () => {
  const env = await envWith([await signedDoc(GATE_POLICY_PATH, GATES), await signedDoc(AUTO_MERGE_POLICY_PATH, AUTO_MERGE)]);

  // The claude-skills driver's own scope: its namespace, and not capsid.
  const status = await improveStatus(env, undefined, undefined, { namespaces: ["claude-skills"], admin: false });

  assert.ok("version" in status.policies.gates, `gates policy not served: ${JSON.stringify(status.policies.gates)}`);
  assert.equal(status.policies.gates.version, "7");
  assert.equal(status.policies.gates.enabled, true);
});

test("the auto-merge policy version is served on the same terms", async () => {
  const env = await envWith([await signedDoc(GATE_POLICY_PATH, GATES), await signedDoc(AUTO_MERGE_POLICY_PATH, AUTO_MERGE)]);
  const status = await improveStatus(env, undefined, undefined, { namespaces: ["germomics"], admin: false });
  assert.ok("version" in status.policies.auto_merge, JSON.stringify(status.policies.auto_merge));
  assert.equal(status.policies.auto_merge.version, "3");
});

test("ONLY the version and the enabled flag: the body and the classes are not served", async () => {
  const env = await envWith([await signedDoc(GATE_POLICY_PATH, GATES), await signedDoc(AUTO_MERGE_POLICY_PATH, AUTO_MERGE)]);
  const status = await improveStatus(env, undefined, undefined, { namespaces: ["claude-skills"], admin: false });
  assert.deepEqual(Object.keys(status.policies.gates).sort(), ["enabled", "version"]);
  // The whole served object must not carry the document text anywhere.
  const serialized = JSON.stringify(status.policies);
  assert.equal(/Pre-approved gates|push_branch|never list/.test(serialized), false, `the policy body leaked: ${serialized}`);
});

test("AN UNSIGNED POLICY REPORTS WHY, rather than a version", async () => {
  // A driver that passed a version read from a document the Worker would refuse to act
  // on would be refused again at the resume, with a less obvious message.
  const env = await envWith([
    { namespace: "capsid", path: GATE_POLICY_PATH, title: "gates", type: "procedural", body: GATES },
    await signedDoc(AUTO_MERGE_POLICY_PATH, AUTO_MERGE),
  ]);
  const status = await improveStatus(env, undefined, undefined, { namespaces: ["claude-skills"], admin: false });
  assert.ok("reason" in status.policies.gates, "an unsigned gate policy was served as a version");
  assert.match(status.policies.gates.reason, /signature|signed|carries no/i);
});

test("a MISSING policy reports why, and does not fail the whole status call", async () => {
  const env = await envWith([]);
  const status = await improveStatus(env, undefined, undefined, { namespaces: ["claude-skills"], admin: false });
  assert.ok("reason" in status.policies.gates);
  assert.ok("reason" in status.policies.auto_merge);
  // Status still answered: a driver asking the version should not lose the rest.
  assert.ok(Array.isArray(status.protected_paths) && status.protected_paths.length > 0);
});

test("the credential inventory is STILL withheld from a scoped caller", async () => {
  // Serving the policy version must not have widened what else a driver sees.
  const env = await envWith([await signedDoc(GATE_POLICY_PATH, GATES), await signedDoc(AUTO_MERGE_POLICY_PATH, AUTO_MERGE)]);
  const scoped = await improveStatus(env, undefined, undefined, { namespaces: ["claude-skills"], admin: false });
  assert.equal("agents" in scoped, false, "a scoped caller was handed the credential inventory");
  const admin = await improveStatus(env);
  assert.ok("agents" in admin, "the admin lost the inventory");
});
