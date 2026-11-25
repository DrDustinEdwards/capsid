import assert from "node:assert/strict";
import { policyDocument } from "./policy-doc.ts";
import { test } from "node:test";
import { signPolicyDocument } from "../src/policy-sign.ts";
import { signTaskBody, splitSignedTask, verifySignedBody } from "../src/signed-docs.ts";
import { loadMergePolicy, AUTO_MERGE_POLICY_PATH } from "../src/auto-merge-policy.ts";
import { adminAgentForEmail } from "../src/agents.ts";
import { checkScope, needFor, requiredForAction } from "../src/scope.ts";
import { COMPOSITES } from "../src/tools/surface.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildAdminServer } from "../src/server.ts";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";

// The one thing that mints policy authority: the counterpart to verifySignedBody. The
// tests are mostly refusals, because a signer's value is in what it declines to sign.

const SECRET = "test-improve-secret";

const POLICY_BODY = policyDocument(1, { enabled: false });

// The body the signer committed, read out of the documents upsert it recorded.
// documentUpsert binds (namespace, path, title, body, ...), so the body is params[3].
function signedBodyFrom(recorded: Array<{ sql: string; params: unknown[] }>): string {
  const upsert = recorded.find((r) => /INSERT INTO documents/i.test(r.sql));
  assert.ok(upsert, "the signer must write the document");
  return String(upsert.params[3]);
}

function envWith(
  documents: Array<{ namespace: string; path: string; title: string; body: string }>,
  secret = SECRET,
) {
  const fake = fakeD1({ documents });
  return { fake, env: fakeEnv({ DB: fake.db, IMPROVE_SCORE_SECRET: secret, APP_KV: fakeKv().kv }) };
}

// what it refuses to sign

test("sign_policy refuses what it must not sign: another namespace, a path outside policy/, a missing or empty document, no secret", async () => {
  const ME = "github:DrDustinEdwards";
  const doc = (namespace: string, path: string, body: string) => ({
    namespace,
    path,
    title: "p",
    body,
  });
  const cases: Array<{
    label: string;
    docs: ReturnType<typeof doc>[];
    secret?: string;
    namespace: string;
    path: string;
    error?: RegExp;
  }> = [
    {
      label: "another namespace",
      docs: [doc("foxhound", "policy/auto-merge.md", POLICY_BODY)],
      namespace: "foxhound",
      path: "policy/auto-merge.md",
      error: /only signs documents in 'capsid'/,
    },
    ...["core.md", "improve/scores.md", "decisions.md", "policy/../core.md"].map((path) => ({
      label: `path ${path}`,
      docs: [doc("capsid", "core.md", "# core")],
      namespace: "capsid",
      path,
    })),
    {
      label: "a document that does not exist",
      docs: [],
      namespace: "capsid",
      path: AUTO_MERGE_POLICY_PATH,
      error: /no document at capsid\/policy\/auto-merge\.md/,
    },
    {
      // An empty policy would otherwise be a valid signature over nothing.
      label: "an empty policy",
      docs: [doc("capsid", AUTO_MERGE_POLICY_PATH, "   \n\n")],
      namespace: "capsid",
      path: AUTO_MERGE_POLICY_PATH,
      error: /empty body/,
    },
    {
      label: "no signing secret",
      docs: [doc("capsid", AUTO_MERGE_POLICY_PATH, POLICY_BODY)],
      secret: "",
      namespace: "capsid",
      path: AUTO_MERGE_POLICY_PATH,
      error: /signing is not configured/,
    },
  ];
  for (const c of cases) {
    const { env, fake } = envWith(c.docs, c.secret);
    const result = await signPolicyDocument(env, ME, c.namespace, c.path);
    assert.equal(result.ok, false, `${c.label} must not be signable`);
    if (c.error) assert.match(result.ok ? "" : result.error, c.error, c.label);
    assert.deepEqual(fake.recorded, [], `${c.label} wrote while refusing`);
  }
});

// what it produces

test("a signed policy verifies, and the same store then loads it", async () => {
  const { fake, env } = envWith([
    { namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: POLICY_BODY },
  ]);
  const result = await signPolicyDocument(
    env,
    "github:DrDustinEdwards",
    "capsid",
    AUTO_MERGE_POLICY_PATH,
  );
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  assert.equal(result.ok && result.resigned, false, "a first signature is not a re-sign");
  assert.match(result.ok ? result.signature : "", /^[0-9a-f]{64}$/);

  // The fake does not apply upserts back onto its rows, so the bytes that were
  // written are read from the statement the signer committed: what would land in D1.
  const written = signedBodyFrom(fake.recorded);
  const verdict = await verifySignedBody(SECRET, written, "merge policy");
  assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);

  // The verifier that decides whether a pull request may merge accepts this document,
  // fed back in as the stored row.
  const { env: reloaded } = envWith([
    { namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: written },
  ]);
  const loaded = await loadMergePolicy(reloaded);
  assert.ok(
    "policy" in loaded,
    `the signed policy must load: ${"error" in loaded ? loaded.error : ""}`,
  );
  assert.equal(loaded.policy.version, "1");
  assert.equal(
    loaded.policy.enabled,
    false,
    "the shipped policy is disabled, and signing does not enable it",
  );
});

test("signing an already-signed policy replaces the frontmatter rather than nesting it", async () => {
  const { fake, env } = envWith([
    { namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: POLICY_BODY },
  ]);
  const first = await signPolicyDocument(
    env,
    "github:DrDustinEdwards",
    "capsid",
    AUTO_MERGE_POLICY_PATH,
  );
  assert.equal(first.ok, true);
  const onceSigned = signedBodyFrom(fake.recorded);

  // The already-signed body fed back in, which is what a second call would read.
  const { fake: again, env: envAgain } = envWith([
    { namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: onceSigned },
  ]);
  const second = await signPolicyDocument(
    envAgain,
    "github:DrDustinEdwards",
    "capsid",
    AUTO_MERGE_POLICY_PATH,
  );
  assert.equal(second.ok, true);
  assert.equal(
    second.ok && second.resigned,
    true,
    "the second call must report that it replaced a signature",
  );
  assert.equal(
    first.ok && second.ok ? second.signature : "",
    first.ok ? first.signature : "x",
    "the same bytes must sign the same way",
  );

  const twiceSigned = signedBodyFrom(again.recorded);
  assert.equal(
    twiceSigned.split("capsid-task-signature").length - 1,
    1,
    "a nested signature would leave two frontmatter lines",
  );
  assert.equal(twiceSigned, onceSigned, "re-signing unchanged bytes is a no-op in content");
  assert.equal(
    splitSignedTask(twiceSigned).body,
    POLICY_BODY,
    "the signed body must be the original bytes, unchanged",
  );
});

// the write invariants

test("signing snapshots the prior body and writes an audit row, in one batch", async () => {
  const { fake, env } = envWith([
    { namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: POLICY_BODY },
  ]);
  await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);

  const sqls = fake.recorded.map((r) => r.sql.replace(/\s+/g, " "));
  assert.ok(
    sqls.some((s) => /INSERT INTO document_versions/i.test(s)),
    "an overwrite that does not snapshot is a write path that skips the invariant",
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
    "the audit row records which bytes were blessed, so a reader can check the document against the log",
  );
  assert.equal(Object.hasOwn(params, "body"), false, "the audit row must not copy the policy body");
  assert.equal(
    fake.batches.length,
    1,
    "the snapshot, the write and the audit row go in together or not at all",
  );
});

// admin only

test("sign_policy is admin only, never signs the auto-merge policy, and signs only the body read", async () => {
  // Served as capsid_admin_manage_switches action "sign_policy", an admin tool in
  // TOOL_GRANTS, and enforced by the registrar. The driver's capsid_read_status serves
  // status and the versions model, two reads, so no driver tool can name sign_policy.
  assert.equal(
    requiredForAction("capsid_admin_manage_switches", "sign_policy"),
    "admin",
    "signing a policy must be gated on admin, not on the write grant",
  );
  const runImprove = COMPOSITES.find((c) => c.name === "capsid_read_status");
  assert.ok(runImprove, "capsid_read_status is not served");
  assert.deepEqual(
    Object.keys(runImprove.actions),
    ["status", "versions"],
    "the driver's status tool serves an action beyond its two reads",
  );
  const driver = {
    ...adminAgentForEmail("admin@example.com"),
    actor: "agent:capsid-driver",
    admin: false,
  };
  const refusal = checkScope(driver, {
    tool: "capsid_admin_manage_switches",
    action: "sign_policy",
    namespace: "capsid",
    ...needFor(requiredForAction("capsid_admin_manage_switches", "sign_policy")),
  });
  assert.ok(refusal, "a driver holding every grant was allowed to sign a policy");
  assert.match(refusal, /admin only/);
  assert.match(refusal, /widen/i, "the refusal should say why, not only that it refused");

  // PLANT: even the admin's raw switch never signs the auto-merge policy, and signs another
  // policy only when it names the sha256 of the body it read.
  const { env } = envWith([
    { namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: POLICY_BODY },
    { namespace: "capsid", path: "policy/gates.md", title: "g", body: "# Gates\n\n- version: 2\n" },
  ]);
  const server = buildAdminServer(env, adminAgentForEmail("admin@example.com"));
  const client = new Client({ name: "t", version: "1.0.0" });
  const [c, sv] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(sv)]);
  const sign = (path: string, sha256: string) =>
    client.callTool({
      name: "capsid_admin_manage_switches",
      arguments: { action: "sign_policy", namespace: "capsid", path, sha256 },
    }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  const merge = await sign(AUTO_MERGE_POLICY_PATH, await sha256Hex(POLICY_BODY));
  assert.equal(merge.isError, true, "the raw switch signed the auto-merge policy");
  assert.match(merge.content[0].text, /does not sign policy\/auto-merge\.md/);
  const stale = await sign("policy/gates.md", "0".repeat(64));
  assert.equal(stale.isError, true, "the switch signed a body its caller did not read");
  assert.match(stale.content[0].text, /not the body you read/);
  const read = await sign("policy/gates.md", await sha256Hex("# Gates\n\n- version: 2\n"));
  assert.ok(!read.isError, read.content[0]?.text);
  await client.close();
});

// Anti-rollback. Every signed version stays in document_versions and still verifies,
// so sign_policy records which body is current and the loader refuses any other. The
// fake does not apply upserts to its rows, so each test copies the signed text into
// the row by hand, as D1 would.

function pinnedStore(kvOpts: Parameters<typeof fakeKv>[0] = {}) {
  const fake = fakeD1({
    documents: [
      { namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: POLICY_BODY },
    ],
  });
  const kv = fakeKv(kvOpts);
  const env = fakeEnv({ DB: fake.db, IMPROVE_SCORE_SECRET: SECRET, APP_KV: kv.kv });
  const row = fake.rows.documents.find((d) => d.path === AUTO_MERGE_POLICY_PATH)!;
  // Sign whatever the row holds, and store the signed text the way the upsert would.
  const sign = async (): Promise<string> => {
    const result = await signPolicyDocument(
      env,
      "github:DrDustinEdwards",
      "capsid",
      AUTO_MERGE_POLICY_PATH,
    );
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
  const result = await signPolicyDocument(
    env,
    "github:DrDustinEdwards",
    "capsid",
    AUTO_MERGE_POLICY_PATH,
  );
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /anti-rollback record .* could not be written/);
  assert.deepEqual(fake.recorded, []);
});
