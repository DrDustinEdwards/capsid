import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AUTO_MERGE_POLICY_PATH, loadMergePolicy } from "../src/auto-merge-policy.ts";
import { policyPin, policyPinKey, signTaskBody, splitSignedTask } from "../src/signed-docs.ts";
import { performPolicyFromRepo, planPolicyFromRepo, REPO_POLICY_PATH } from "../src/policy-sign.ts";
import { fakeD1, fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// sign_policy_from_repo (src/policy-sign.ts): the stored, signed auto-merge policy written
// from docs/policy/auto-merge.md on the default branch. Proves: a file that would not load
// is refused; a file that changed after the preview is refused; and the perform snapshots
// the prior version and audits.

const SECRET = "policy-from-repo-test-secret";
const ACTOR = "access:admin@example.com";
const SHIPPED = readFileSync(join(import.meta.dirname, "..", "docs", "policy", "auto-merge.md"), "utf8");
const STORED_VERSION = /^- version: (\d+)$/m.exec(SHIPPED)![1]!;
const NEXT = String(Number(STORED_VERSION) + 1);
const bumped = (body: string, version = NEXT) => body.replace(/^- version: \d+$/m, `- version: ${version}`);
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

async function world() {
  const { db, rows } = fakeD1({ documents: [{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "Auto-merge policy", body: await signTaskBody(SECRET, SHIPPED) }] });
  const kv = fakeKv({ seedToken: true, seed: { [policyPinKey(AUTO_MERGE_POLICY_PATH)]: JSON.stringify(await policyPin(SHIPPED)) } });
  return { env: fakeEnv({ DB: db, APP_KV: kv.kv, IMPROVE_SCORE_SECRET: SECRET }), rows, kv };
}
// The fake's audit row type names four columns; the rows it stores hold them all.
type AuditRow = { actor: string; action: string; namespace: string; path: string; params: string };
const auditRows = (rows: { audit_log: unknown[] }) => rows.audit_log as AuditRow[];
const stored = (rows: { documents: Array<{ path: string; body?: string | null }> }) => rows.documents.find((d) => d.path === AUTO_MERGE_POLICY_PATH)!.body!;

// The file on the default branch, as GitHub answers a contents read. `repo.text` is read on
// every call, so a test changes the repo between the preview and the perform.
function repoRoutes(repo: { text: string; status?: number }) {
  return {
    [`GET /repos/owner/repo/contents/${REPO_POLICY_PATH}`]: () =>
      repo.status && repo.status !== 200
        ? { status: repo.status, text: "Not Found" }
        : { body: { type: "file", encoding: "base64", content: b64(repo.text), size: repo.text.length, sha: "f".repeat(40) } },
  };
}

test("the repo's file at the next version is planned: both hashes, the lines changed, the version to type", async () => {
  const w = await world();
  const repo = { text: bumped(SHIPPED) };
  await withFetch(repoRoutes(repo), async () => {
    const plan = await planPolicyFromRepo(w.env);
    assert.ok(plan.ok, plan.ok ? "" : plan.error);
    assert.deepEqual([plan.from, plan.to], [STORED_VERSION, NEXT]);
    assert.notEqual(plan.oldSha, plan.newSha);
    assert.match(plan.oldSha, /^[0-9a-f]{64}$/);
    assert.deepEqual([plan.removed, plan.added], [[`- version: ${STORED_VERSION}`], [`- version: ${NEXT}`]]);
    const text = plan.changes.join("\n");
    assert.match(text, /Lines changed: 1 removed, 1 added/);
    assert.match(text, new RegExp(`\\+ - version: ${NEXT}`));
    assert.match(text, new RegExp(`Type ${NEXT} as confirm`));
  });
  assert.equal(stored(w.rows), await signTaskBody(SECRET, SHIPPED), "a preview wrote the policy");
  assert.equal(w.kv.puts.length, 0, "a preview moved the pin");
});

test("PLANT: a policy that would not load is refused at the preview and at the perform, and nothing is signed or written", async () => {
  const before = (await world()).rows;
  void before;
  for (const [what, text, why] of [
    ["an unknown path class", `${bumped(SHIPPED)}\n## Auto units\n\n- unit \`capsid / everything\`\n`, /'everything', which is not a path class/],
    ["a check the code enforces, dropped", bumped(SHIPPED).replace(/^.*`paths_not_refused`.*$/m, ""), /does not name paths_not_refused/],
    ["no PR author", bumped(SHIPPED).replace(/^- author .*$/gm, ""), /names no PR author/],
  ] as const) {
    const w = await world();
    const signedBefore = stored(w.rows);
    await withFetch(repoRoutes({ text }), async () => {
      const plan = await planPolicyFromRepo(w.env);
      assert.equal(plan.ok, false, `${what} was planned`);
      assert.match(!plan.ok ? plan.error : "", why, what);
      const done = await performPolicyFromRepo(w.env, ACTOR, NEXT, "a".repeat(64));
      assert.equal(done.ok, false, `${what} was signed`);
    });
    assert.equal(stored(w.rows), signedBefore, `${what}: the stored policy changed`);
    assert.equal(w.kv.puts.length, 0, `${what}: the pin moved`);
    assert.equal(w.rows.audit_log.length, 0, `${what}: an audit row was written`);
  }
});

test("PLANT: a repo change after the preview is refused, and nothing is signed or written", async () => {
  const w = await world();
  const repo = { text: bumped(SHIPPED) };
  await withFetch(repoRoutes(repo), async () => {
    const plan = await planPolicyFromRepo(w.env);
    assert.ok(plan.ok, plan.ok ? "" : plan.error);
    // Someone merges another edit to the file between the preview and the perform.
    repo.text = `${repo.text.trimEnd()}\n\nAn amendment merged after the preview.\n`;
    const signedBefore = stored(w.rows);
    const done = await performPolicyFromRepo(w.env, ACTOR, NEXT, plan.newSha);
    assert.equal(done.ok, false, "the perform signed a file the preview did not show");
    assert.match(!done.ok ? done.error : "", /changed since the preview/);
    assert.equal(stored(w.rows), signedBefore, "the stored policy changed");
    assert.equal(w.kv.puts.length, 0, "the pin moved");
    assert.equal(w.rows.audit_log.length, 0, "an audit row was written");
  });
});

test("PLANT: the perform snapshots the prior version, writes and signs the file, pins it, and audits", async () => {
  const w = await world();
  const repo = { text: bumped(SHIPPED) };
  await withFetch(repoRoutes(repo), async () => {
    const plan = await planPolicyFromRepo(w.env);
    assert.ok(plan.ok, plan.ok ? "" : plan.error);
    const done = await performPolicyFromRepo(w.env, ACTOR, NEXT, plan.newSha);
    assert.ok(done.ok, done.ok ? "" : done.error);
    // Written exactly, and signed.
    const { signature, body } = splitSignedTask(stored(w.rows));
    assert.ok(signature, "the new version is not signed");
    assert.equal(body, repo.text);
    // The prior version is in document_versions, whole.
    const snap = w.rows.versions.filter((v) => v.path === AUTO_MERGE_POLICY_PATH);
    assert.equal(snap.length, 1, "the prior version was not snapshotted exactly once");
    assert.equal(splitSignedTask(snap[0]!.body as string).body, SHIPPED);
    // An audit row names the actor, both hashes and the signature.
    const audit = auditRows(w.rows).filter((a) => a.action === "policy-loaded-from-repo");
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.actor, ACTOR);
    assert.deepEqual([audit[0]!.namespace, audit[0]!.path], ["capsid", AUTO_MERGE_POLICY_PATH]);
    assert.deepEqual(
      (({ from, to, source, old_sha256, new_sha256 }) => ({ from, to, source, old_sha256, new_sha256 }))(JSON.parse(String(audit[0]!.params))),
      { from: STORED_VERSION, to: NEXT, source: REPO_POLICY_PATH, old_sha256: plan.oldSha, new_sha256: plan.newSha }
    );
    assert.equal(JSON.parse(String(audit[0]!.params)).signature, signature);
    // The anti-rollback pin moved to the new body, and the Worker loads it.
    assert.deepEqual(JSON.parse(w.kv.puts.at(-1)!.value), await policyPin(repo.text));
    const loaded = await loadMergePolicy(w.env);
    assert.ok("policy" in loaded, "error" in loaded ? loaded.error : "");
    assert.equal(loaded.policy.version, NEXT);
  });
});

test("the typed version must be the file's, and the preview's hash must come with it", async () => {
  const w = await world();
  await withFetch(repoRoutes({ text: bumped(SHIPPED) }), async () => {
    const plan = await planPolicyFromRepo(w.env);
    assert.ok(plan.ok, plan.ok ? "" : plan.error);
    const signedBefore = stored(w.rows);
    const missing = await performPolicyFromRepo(w.env, ACTOR, undefined, plan.newSha);
    assert.match(!missing.ok ? missing.error : "", new RegExp(`typed as confirm: ${NEXT}`));
    const wrong = await performPolicyFromRepo(w.env, ACTOR, STORED_VERSION, plan.newSha);
    assert.match(!wrong.ok ? wrong.error : "", new RegExp(`confirm is '${STORED_VERSION}', but the file's version is ${NEXT}`));
    const unbound = await performPolicyFromRepo(w.env, ACTOR, NEXT, undefined);
    assert.match(!unbound.ok ? unbound.error : "", /carries the hash its preview read/);
    assert.equal(stored(w.rows), signedBefore);
    assert.equal(w.kv.puts.length, 0);
  });
});

test("a file that is not newer, is unchanged, is unreadable or is already signed is refused at the preview", async () => {
  const w = await world();
  await withFetch(repoRoutes({ text: SHIPPED }), async () => {
    const same = await planPolicyFromRepo(w.env);
    assert.match(!same.ok ? same.error : "", /already stored/);
  });
  await withFetch(repoRoutes({ text: bumped(`${SHIPPED}\nAn edit.\n`, STORED_VERSION) }), async () => {
    const stale = await planPolicyFromRepo(w.env);
    assert.match(!stale.ok ? stale.error : "", new RegExp(`says version ${STORED_VERSION}, and the stored policy is version ${STORED_VERSION}`));
  });
  await withFetch(repoRoutes({ text: "", status: 404 }), async () => {
    const gone = await planPolicyFromRepo(w.env);
    assert.match(!gone.ok ? gone.error : "", /could not be read from the capsid repo's default branch/);
  });
  await withFetch(repoRoutes({ text: `---\nimprove_signature: ${"0".repeat(64)}\n---\n${bumped(SHIPPED)}` }), async () => {
    const framed = await planPolicyFromRepo(w.env);
    assert.match(!framed.ok ? framed.error : "", /opens with frontmatter/);
  });
});
