import assert from "node:assert/strict";
import { test } from "node:test";
import { capsidStatus } from "../src/status.ts";
import { GATE_POLICY_PATH } from "../src/gate-policy.ts";
import { signTaskBody } from "../src/signed-docs.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2, type DocRow } from "./fakes.ts";

// Every driver can learn the policy version it must approve under.
//
// A driver passes the version of capsid/policy/gates.md as approved_by_policy, but a
// namespace-scoped driver cannot read the capsid namespace. So capsid_read_status action status serves
// the version and the enabled flag, and nothing else: not the body, not the classes,
// not the never list. Reading the policy itself stays scoped to capsid.

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
  return {
    namespace: "capsid",
    path,
    title: path,
    type: "procedural",
    body: await signTaskBody(SECRET, body),
  };
}

test("a driver scoped to ANOTHER namespace is served the gate policy's version and enabled flag, and nothing else", async () => {
  const env = await envWith([await signedDoc(GATE_POLICY_PATH, GATES)]);

  // The claude-skills driver's own scope: its namespace, and not capsid.
  const status = await capsidStatus(env, undefined, {
    namespaces: ["claude-skills"],
    admin: false,
  });

  assert.ok(
    "version" in status.policies.gates,
    `gates policy not served: ${JSON.stringify(status.policies.gates)}`,
  );
  assert.equal(status.policies.gates.version, "7");
  assert.equal(status.policies.gates.enabled, true);

  assert.deepEqual(Object.keys(status.policies.gates).sort(), ["enabled", "version"]);
  // The whole served object must not carry the document text anywhere.
  const serialized = JSON.stringify(status.policies);
  assert.equal(
    /Pre-approved gates|push_branch|never list/.test(serialized),
    false,
    `the policy body leaked: ${serialized}`,
  );
});

test("AN UNSIGNED POLICY REPORTS WHY, rather than a version", async () => {
  // A driver that passed a version read from a document the Worker would refuse to act
  // on would be refused again at the resume, with a less obvious message.
  const env = await envWith([
    {
      namespace: "capsid",
      path: GATE_POLICY_PATH,
      title: "gates",
      type: "procedural",
      body: GATES,
    },
  ]);
  const status = await capsidStatus(env, undefined, {
    namespaces: ["claude-skills"],
    admin: false,
  });
  assert.ok("reason" in status.policies.gates, "an unsigned gate policy was served as a version");
  assert.match(status.policies.gates.reason, /signature|signed|carries no/i);
});

test("a MISSING policy reports why, and does not fail the whole status call", async () => {
  const env = await envWith([]);
  const status = await capsidStatus(env, undefined, {
    namespaces: ["claude-skills"],
    admin: false,
  });
  assert.ok("reason" in status.policies.gates);
  // Status still answered: a driver asking the version should not lose the rest.
  assert.ok(Array.isArray(status.namespaces) && status.canon_paths !== undefined);
});
