import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { policyField, readSignedPolicy, signTaskBody } from "../src/improve-task.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// One signed-policy reader, shared by the merge policy and the gate policy so a fix
// is made in one place. These tests drive it, and the last one keeps the two loaders
// from growing a private copy.

const SECRET = "test-root-secret-not-a-real-one";
const BODY = "# Policy\n\n- version: 7\n- enabled: false\n";

function envWith(body: string | null) {
  const { db } = fakeD1({
    documents: body === null ? [] : [{ namespace: "capsid", path: "policy/example.md", title: "policy", body }],
  });
  return fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET, APP_KV: fakeKv().kv });
}

test("readSignedPolicy returns the signed body and not the frontmatter", async () => {
  const read = await readSignedPolicy(envWith(await signTaskBody(SECRET, BODY)), "policy/example.md", "example policy", "nothing happens");
  assert.deepEqual(read, { body: BODY });
});

test("readSignedPolicy refuses an absent, unsigned or edited document", async () => {
  const absent = await readSignedPolicy(envWith(null), "policy/example.md", "example policy", "nothing happens");
  assert.deepEqual(absent, { error: "no example policy at capsid/policy/example.md, so nothing happens." });

  const unsigned = await readSignedPolicy(envWith(BODY), "policy/example.md", "example policy", "nothing happens");
  assert.ok("error" in unsigned);
  assert.match(unsigned.error, /carries no capsid-task-signature/);

  const edited = (await signTaskBody(SECRET, BODY)).replace("- enabled: false", "- enabled: true");
  const tampered = await readSignedPolicy(envWith(edited), "policy/example.md", "example policy", "nothing happens");
  assert.ok("error" in tampered);
  assert.match(tampered.error, /does not match its body/);
});

test("policyField reads the first matching list item, in any letter case, and null when absent", () => {
  assert.equal(policyField("- Version: 3\n- version: 4", "version"), "3");
  assert.equal(policyField("  - enabled:  true  ", "enabled"), "true");
  assert.equal(policyField("version: 3", "version"), null);
});

test("neither policy loader reads, verifies or parses a policy field on its own", () => {
  // Three spellings of a private copy: a direct documents query, a direct call to the
  // verifier, and a local field parser. Each file is read, so a scan that found no
  // file would fail on the read rather than pass with nothing checked.
  const files = ["src/auto-merge.ts", "src/gate-policy.ts"];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    assert.match(src, /readSignedPolicy\(/, `${file} does not read its policy through readSignedPolicy`);
    assert.doesNotMatch(src, /FROM documents/, `${file} queries the documents table itself`);
    assert.doesNotMatch(src, /verifySignedBody\(/, `${file} calls the verifier itself`);
    assert.doesNotMatch(src, /function field\(/, `${file} defines its own field parser`);
  }
  assert.equal(files.length, 2);
});
