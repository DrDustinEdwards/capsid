import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveBackupCredentialKey } from "../src/signed-requests.ts";
import { deriveTaskKey, signTaskBody, splitSignedTask, TASK_SIGNATURE_FIELD, verifySignedBody } from "../src/signed-docs.ts";

// Signed document integrity: the signed policies (capsid/policy/) and the signed job
// bodies use this envelope. A write-grant key must not be able to author one.

const ROOT = "test-root-secret-not-a-real-one";
const WHAT = "policy document";

test("the signing key is derived under its own context, unequal to the backup key", async () => {
  const key = await deriveTaskKey(ROOT);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(key, await deriveBackupCredentialKey(ROOT), "the backup key must not open a signed document");
});

test("a signed document round-trips and verifies", async () => {
  const body = "# Auto-merge policy\n\n- version: 7\n";
  const signed = await signTaskBody(ROOT, body);
  assert.match(signed, new RegExp(`^---\\n${TASK_SIGNATURE_FIELD}: [0-9a-f]{64}\\n---\\n`));
  const split = splitSignedTask(signed);
  assert.equal(split.body, body, "the signed body must come back byte-identical");
  assert.deepEqual(await verifySignedBody(ROOT, signed, WHAT), { ok: true, body });
});

test("PLANT: a signed document with any other line in its frontmatter is refused", async () => {
  // The HMAC covers only the body below the frontmatter, so a line added beside the
  // signature leaves the signature valid. The Worker writes exactly one line there.
  const body = "# Auto-merge policy\n\n- enabled: false\n";
  const signed = await signTaskBody(ROOT, body);
  const sigLine = signed.split("\n")[1];
  const plants = [
    signed.replace(`${sigLine}\n`, `${sigLine}\n- enabled: true\n`),
    signed.replace(`${sigLine}\n`, `- enabled: true\n${sigLine}\n`),
    signed.replace(`${sigLine}\n`, `${sigLine}\n${sigLine}\n`),
    signed.replace(`${sigLine}\n`, `${sigLine}\n\n`),
  ];
  for (const plant of plants) {
    assert.notEqual(plant, signed, "the plant must actually change the frontmatter");
    assert.equal(splitSignedTask(plant).body, body, "the signed body is untouched, so only the frontmatter rule can catch this");
    const verdict = await verifySignedBody(ROOT, plant, WHAT);
    assert.equal(verdict.ok, false, `frontmatter with an extra line must not verify: ${JSON.stringify(plant.slice(0, 120))}`);
    assert.match(String(verdict.ok === false && verdict.reason), /besides the capsid-task-signature line/);
  }
});

test("PLANT: a document edited after signing is refused", async () => {
  const body = "# Auto-merge policy\n\n- enabled: false\n";
  const signed = await signTaskBody(ROOT, body);
  // The attack: keep the signature line, rewrite the body under it.
  const tampered = signed.replace("- enabled: false", "- enabled: true");
  assert.notEqual(tampered, signed, "the plant must actually change the body");
  const verdict = await verifySignedBody(ROOT, tampered, WHAT);
  assert.equal(verdict.ok, false);
  assert.match(String(verdict.ok === false && verdict.reason), /does not match its body/);
});

test("PLANT: an unsigned document is refused", async () => {
  const verdict = await verifySignedBody(ROOT, "# Auto-merge policy\n\n- enabled: true\n", WHAT);
  assert.equal(verdict.ok, false);
  assert.match(String(verdict.ok === false && verdict.reason), /carries no capsid-task-signature/);
});

test("PLANT: a document signed with the wrong key is refused", async () => {
  const signed = await signTaskBody("some-other-root", "# Auto-merge policy\n");
  const verdict = await verifySignedBody(ROOT, signed, WHAT);
  assert.equal(verdict.ok, false);
  assert.match(String(verdict.ok === false && verdict.reason), /does not match its body/);
});

test("an unconfigured Worker refuses every signed document rather than skipping the check", async () => {
  const signed = await signTaskBody(ROOT, "# Auto-merge policy\n");
  const verdict = await verifySignedBody(undefined, signed, WHAT);
  assert.equal(verdict.ok, false);
  assert.match(String(verdict.ok === false && verdict.reason), /not configured/);
});

test("splitSignedTask tolerates a document with no frontmatter", () => {
  const split = splitSignedTask("# plain\n\nbody\n");
  assert.equal(split.signature, null);
  assert.equal(split.body, "# plain\n\nbody\n");
});
