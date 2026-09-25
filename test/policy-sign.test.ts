import assert from "node:assert/strict";
import { test } from "node:test";
import { signPolicyDocument } from "../src/policy-sign.ts";
import { signTaskBody, splitSignedTask, verifySignedBody } from "../src/improve-task.ts";
import {
  loadMergePolicy,
  AUTO_MERGE_POLICY_PATH,
  AUTO_MERGE_REFUSED_PATHS,
  AUTO_MERGE_REQUIRED_CI,
  POLICY_CHECKS,
  requiredCiLabel,
} from "../src/auto-merge.ts";
import { adminAgent } from "../src/agents.ts";
import { checkScope, needFor, requiredForAction } from "../src/scope.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// THE ONE THING THAT MINTS POLICY AUTHORITY. Before this, verifySignedBody had no
// counterpart that could produce what it verifies, so both policies were inert. The
// tests below are mostly refusals, because the value of a signer is entirely in what
// it declines to sign.

const SECRET = "test-improve-secret";

const POLICY_BODY = [
  "# Auto-merge policy",
  "",
  "- version: 1",
  "- enabled: false",
  "- namespaces: capsid",
  "",
  "## Checks",
  "",
  ...POLICY_CHECKS.map((c) => `- \`${c}\` refuses on its own.`),
  "",
  "- author `DrDustinEdwards`",
  "",
  ...AUTO_MERGE_REFUSED_PATHS.map((p) => `- path \`${p.pattern.source}\` ${p.why}`),
  ...Object.entries(AUTO_MERGE_REQUIRED_CI).flatMap(([ns, rows]) => [
    `## Required CI, ${ns}`,
    "",
    ...rows.map((r) => `- step \`${requiredCiLabel(r)}\``),
    "",
  ]),
  "",
].join("\n");

// The body the signer committed, read out of the documents upsert it recorded.
// documentUpsert binds (namespace, path, title, body, ...), so the body is params[3].
function signedBodyFrom(recorded: Array<{ sql: string; params: unknown[] }>): string {
  const upsert = recorded.find((r) => /INSERT INTO documents/i.test(r.sql));
  assert.ok(upsert, "the signer must write the document");
  return String(upsert.params[3]);
}

function envWith(documents: Array<{ namespace: string; path: string; title: string; body: string }>, secret = SECRET) {
  const fake = fakeD1({ documents });
  return { fake, env: fakeEnv({ DB: fake.db, IMPROVE_SCORE_SECRET: secret, APP_KV: fakeKv().kv }) };
}

// ---- what it refuses to sign ----------------------------------------------------

test("sign_policy refuses a namespace other than capsid", async () => {
  const { env } = envWith([{ namespace: "foxhound", path: "policy/auto-merge.md", title: "p", body: POLICY_BODY }]);
  const result = await signPolicyDocument(env, "github:DrDustinEdwards", "foxhound", "policy/auto-merge.md");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /only signs documents in 'capsid'/);
});

test("sign_policy refuses any path outside policy/, including a traversal", async () => {
  const { env } = envWith([{ namespace: "capsid", path: "core.md", title: "core", body: "# core" }]);
  for (const path of ["core.md", "improve/scores.md", "decisions.md", "policy/../core.md"]) {
    const result = await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", path);
    assert.equal(result.ok, false, `${path} must not be signable`);
  }
});

test("sign_policy refuses a document that does not exist", async () => {
  const { env } = envWith([]);
  const result = await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /no document at capsid\/policy\/auto-merge\.md/);
});

test("sign_policy refuses an empty policy, which would otherwise be a valid signature over nothing", async () => {
  const { env } = envWith([{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: "   \n\n" }]);
  const result = await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /empty body/);
});

test("sign_policy refuses when the Worker has no signing secret", async () => {
  const { env } = envWith([{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: POLICY_BODY }], "");
  const result = await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /signing is not configured/);
});

// ---- what it produces -----------------------------------------------------------

test("a signed policy verifies, and the same store then loads it", async () => {
  const { fake, env } = envWith([{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: POLICY_BODY }]);
  const result = await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  assert.equal(result.ok && result.resigned, false, "a first signature is not a re-sign");
  assert.match(result.ok ? result.signature : "", /^[0-9a-f]{64}$/);

  // The fake does not apply upserts back onto its rows, so the bytes that were
  // written are read from the statement the signer committed rather than from the
  // table. That is the value under test either way: it is what would land in D1.
  const written = signedBodyFrom(fake.recorded);
  const verdict = await verifySignedBody(SECRET, written, "merge policy");
  assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);

  // The end of the chain the whole part exists for: the verifier that decides whether
  // a pull request may merge now accepts this document. Fed back in as the stored row.
  const { env: reloaded } = envWith([{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: written }]);
  const loaded = await loadMergePolicy(reloaded);
  assert.ok("policy" in loaded, `the signed policy must load: ${"error" in loaded ? loaded.error : ""}`);
  assert.equal(loaded.policy.version, "1");
  assert.equal(loaded.policy.enabled, false, "the shipped policy is disabled, and signing does not enable it");
});

test("signing an already-signed policy replaces the frontmatter rather than nesting it", async () => {
  const { fake, env } = envWith([{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: POLICY_BODY }]);
  const first = await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);
  assert.equal(first.ok, true);
  const onceSigned = signedBodyFrom(fake.recorded);

  // The already-signed body fed back in, which is what a second call would read.
  const { fake: again, env: envAgain } = envWith([
    { namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: onceSigned },
  ]);
  const second = await signPolicyDocument(envAgain, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);
  assert.equal(second.ok, true);
  assert.equal(second.ok && second.resigned, true, "the second call must report that it replaced a signature");
  assert.equal(first.ok && second.ok ? second.signature : "", first.ok ? first.signature : "x", "the same bytes must sign the same way");

  const twiceSigned = signedBodyFrom(again.recorded);
  assert.equal(twiceSigned.split("capsid-task-signature").length - 1, 1, "a nested signature would leave two frontmatter lines");
  assert.equal(twiceSigned, onceSigned, "re-signing unchanged bytes is a no-op in content");
  assert.equal(splitSignedTask(twiceSigned).body, POLICY_BODY, "the signed body must be the original bytes, unchanged");
});

test("signing a tampered policy produces a signature for the tampered bytes, and the old one stops verifying", async () => {
  const { fake, env } = envWith([{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: POLICY_BODY }]);
  const first = await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);
  const firstSignature = first.ok ? first.signature : "";

  const row = fake.rows.documents.find((d) => d.path === AUTO_MERGE_POLICY_PATH);
  assert.ok(row);
  row.body = String(row.body).replace("- enabled: false", "- enabled: true");
  const tampered = await verifySignedBody(SECRET, String(row.body), "merge policy");
  assert.equal(tampered.ok, false, "an edit after signing must stop verifying, or the signature means nothing");

  const second = await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);
  assert.equal(second.ok, true);
  assert.notEqual(second.ok ? second.signature : "", firstSignature, "different bytes must sign differently");
});

// ---- the write invariants -------------------------------------------------------

test("signing snapshots the prior body and writes an audit row, in one batch", async () => {
  const { fake, env } = envWith([{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: POLICY_BODY }]);
  await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);

  const sqls = fake.recorded.map((r) => r.sql.replace(/\s+/g, " "));
  assert.ok(
    sqls.some((s) => /INSERT INTO document_versions/i.test(s)),
    "an overwrite that does not snapshot is a write path that skips the invariant"
  );
  const audit = fake.recorded.find((r) => /INSERT INTO audit_log/i.test(r.sql));
  assert.ok(audit, "signing must be audit-logged");
  assert.equal(audit.params[1], "policy-signed");
  assert.equal(audit.params[2], "capsid");
  assert.equal(audit.params[3], AUTO_MERGE_POLICY_PATH);
  const params = JSON.parse(String(audit.params[4])) as Record<string, unknown>;
  assert.match(String(params.signature), /^[0-9a-f]{64}$/);
  assert.equal(params.resigned, false);
  assert.equal(
    typeof params.sha256,
    "string",
    "the audit row records which bytes were blessed, so a reader can check the document against the log"
  );
  assert.equal(Object.hasOwn(params, "body"), false, "the audit row must not copy the policy body");
  assert.equal(fake.batches.length, 1, "the snapshot, the write and the audit row go in together or not at all");
});

// ---- admin only -----------------------------------------------------------------

test("sign_policy is admin only in the scope table, and the refusal says why", () => {
  // Stated in TOOL_ACTION_GRANTS and enforced by the registrar since 2026-09-16; the
  // handler in src/tools/improve.ts used to check ctx.agent.admin itself.
  assert.equal(requiredForAction("improve_run", "sign_policy"), "admin", "signing a policy must be gated on admin, not on the write grant");
  const driver = { ...adminAgent("DrDustinEdwards"), actor: "agent:capsid-driver", admin: false };
  const refusal = checkScope(driver, { tool: "improve_run", action: "sign_policy", namespace: "capsid", ...needFor(requiredForAction("improve_run", "sign_policy")) });
  assert.ok(refusal, "a driver holding every grant was allowed to sign a policy");
  assert.match(refusal, /admin only/);
  assert.match(refusal, /widen/i, "the refusal should say why, not only that it refused");
  // That no handler decides admin for itself is asserted for every handler in
  // test/route-gates.test.ts.
});


// THE SIGNER TAKES NO BODY ARGUMENT, so it cannot be used to sign arbitrary bytes: it
// signs what the store holds. A type-level check, compiled by npm run check:test: a new
// parameter changes the tuple length and this assignment stops compiling. The tampering
// test above shows it signs the stored bytes.
// Exact, in both directions: an optional parameter makes the length 4 | 5, which a plain
// assignment of 4 would still accept.
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const SIGNER_ARITY_IS_FOUR: Exactly<Parameters<typeof signPolicyDocument>["length"], 4> = true;
test("the signer takes exactly env, actor, namespace and path", () => {
  assert.equal(SIGNER_ARITY_IS_FOUR, true);
});

// ---- anti-rollback (audit 2026-09-25, E2-2) ------------------------------------------
//
// Every signed version stays in document_versions and still verifies, so putting an
// older one back used to reload it. sign_policy now records which body is current, and
// the loader refuses any other. The fake does not apply upserts to its rows, so each
// test copies the signed text into the row by hand, as D1 would.

function pinnedStore(kvOpts: Parameters<typeof fakeKv>[0] = {}) {
  const fake = fakeD1({ documents: [{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: POLICY_BODY }] });
  const kv = fakeKv(kvOpts);
  const env = fakeEnv({ DB: fake.db, IMPROVE_SCORE_SECRET: SECRET, APP_KV: kv.kv });
  const row = fake.rows.documents.find((d) => d.path === AUTO_MERGE_POLICY_PATH)!;
  // Sign whatever the row holds, and store the signed text the way the upsert would.
  const sign = async (): Promise<string> => {
    const result = await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    const upserts = fake.recorded.filter((r) => /INSERT INTO documents/i.test(r.sql));
    row.body = String(upserts[upserts.length - 1].params[3]);
    return row.body;
  };
  return { fake, kv, env, row, sign };
}

const VERSION_2 = POLICY_BODY.replace("- version: 1", "- version: 2");

test("PLANT: an older signed policy put back after a newer one was signed does not load", async () => {
  const { env, row, sign } = pinnedStore();
  const signedV1 = await sign();
  row.body = VERSION_2;
  const signedV2 = await sign();
  const current = await loadMergePolicy(env);
  assert.equal("policy" in current && current.policy.version, "2");

  // What `restore` of the earlier version writes: the version 1 text, signature and all.
  row.body = signedV1;
  const rolledBack = await loadMergePolicy(env);
  assert.ok("error" in rolledBack, "an older signed policy put back in place loaded");
  assert.match(rolledBack.error, /version 1, .* not the one last signed \(version 2,/);

  // The seat means it: signing version 1 again makes it current, and version 2 put
  // back after that is refused although its number is higher.
  await sign();
  const resigned = await loadMergePolicy(env);
  assert.equal("policy" in resigned && resigned.policy.version, "1");
  row.body = signedV2;
  const newerPutBack = await loadMergePolicy(env);
  assert.ok("error" in newerPutBack, "a withdrawn version 2 put back loaded");
  assert.match(newerPutBack.error, /version 2, .* not the one last signed \(version 1,/);
});

test("the seat re-signing the same body keeps it loading", async () => {
  const { env, kv, sign } = pinnedStore();
  await sign();
  assert.ok("policy" in (await loadMergePolicy(env)));
  await sign();
  const again = await loadMergePolicy(env);
  assert.ok("policy" in again, "error" in again ? again.error : "");
  const pins = kv.puts.filter((p) => p.key === "policy:signed:policy/auto-merge.md");
  assert.equal(pins.length, 2);
  assert.equal(pins[0].value, pins[1].value, "a re-sign of the same body recorded a different pin");
});

test("the first load with no record pins the signed policy it finds, and refuses a different one after", async () => {
  const { env, kv, row } = pinnedStore();
  row.body = await signTaskBody(SECRET, VERSION_2);
  const first = await loadMergePolicy(env);
  assert.ok("policy" in first, "error" in first ? first.error : "");
  assert.equal(JSON.parse(kv.store.get("policy:signed:policy/auto-merge.md") ?? "{}").version, "2");
  row.body = await signTaskBody(SECRET, POLICY_BODY);
  const other = await loadMergePolicy(env);
  assert.ok("error" in other);
  assert.match(other.error, /not the one last signed/);
});

test("a load whose record cannot be read is refused", async () => {
  const { env, row } = pinnedStore({ failGet: true });
  row.body = await signTaskBody(SECRET, POLICY_BODY);
  const loaded = await loadMergePolicy(env);
  assert.ok("error" in loaded);
  assert.match(loaded.error, /anti-rollback record .* could not be read/);
});

test("sign_policy stores nothing when the record cannot be written", async () => {
  const { env, fake } = pinnedStore({ failPut: true });
  const result = await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /anti-rollback record .* could not be written/);
  assert.deepEqual(fake.recorded, []);
});
