import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { signPolicyDocument } from "../src/policy-sign.ts";
import { AUTO_MERGE_POLICY_PATH } from "../src/auto-merge.ts";
import { fakeD1, fakeEnv, fakeKv, type DocRow, type FakeD1Options } from "./fakes.ts";

// Dash normalization on append and patch, and the body guard on sign_policy.
// Recording a delete's edges inside the batch is in
// test-integration/delete-edges.test.ts, because only real SQLite evaluates the
// INSERT ... SELECT json_group_array that records them.

// Built from its code point so this file carries no literal wide dash.
const EM = String.fromCharCode(0x2014);

async function connect(opts: FakeD1Options) {
  const fake = fakeD1(opts);
  const server = buildServer(fakeEnv({ DB: fake.db }), "write", "test:e1-6");
  const client = new Client({ name: "e1-6", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { fake, client };
}

const call = async (client: Client, args: Record<string, unknown>) =>
  (await client.callTool({ name: "write", arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };

// documentUpsert binds (namespace, path, title, body, ...), so the body is params[3].
function storedBody(recorded: Array<{ sql: string; params: unknown[] }>): string {
  const upsert = recorded.find((r) => /INSERT INTO documents/i.test(r.sql));
  assert.ok(upsert, "the write must upsert the document");
  return String(upsert.params[3]);
}

const doc = (body: string): DocRow => ({ namespace: "capsid", path: "doc.md", title: "Doc", body });

test("append normalizes the appended text and leaves a wide dash already stored untouched", async () => {
  const prior = `stored before the normalizer ${EM} left as it is`;
  const { fake, client } = await connect({ documents: [doc(prior)] });
  const result = await call(client, { namespace: "capsid", path: "doc.md", mode: "append", body: `added ${EM} by the caller` });
  await client.close();
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(storedBody(fake.recorded), `${prior}\n\nadded, by the caller`);
});

test("patch normalizes replace_with and leaves the rest of the stored body untouched", async () => {
  const prior = `line one ${EM} stored\nANCHOR\nline three ${EM} stored`;
  const { fake, client } = await connect({ documents: [doc(prior)] });
  const result = await call(client, {
    namespace: "capsid",
    path: "doc.md",
    mode: "patch",
    find: "ANCHOR",
    replace_with: `new ${EM} text`,
    confirm: true,
  });
  await client.close();
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(storedBody(fake.recorded), `line one ${EM} stored\nnew, text\nline three ${EM} stored`);
});

test("replace still normalizes the whole body, because the caller supplied all of it", async () => {
  const { fake, client } = await connect({ documents: [doc("old")] });
  const result = await call(client, { namespace: "capsid", path: "doc.md", title: `A ${EM} B`, body: `x ${EM} y`, confirm: true });
  await client.close();
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(storedBody(fake.recorded), "x, y");
});

test("sign_policy refuses and writes nothing when the policy changes between its read and its batch", async () => {
  const fake = fakeD1({
    documents: [{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: "# policy\n\n- version: 1\n" }],
    raceAfterPreRead: (rows, target) => {
      const row = rows.documents.find((d) => d.namespace === target.namespace && d.path === target.path);
      assert.ok(row);
      row.body = "# policy\n\n- version: 2\n";
    },
  });
  const env = fakeEnv({ DB: fake.db, IMPROVE_SCORE_SECRET: "test-improve-secret", APP_KV: fakeKv().kv });
  const result = await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);
  assert.equal(result.ok, false, "the signer overwrote a policy edit with the signed older body");
  assert.match(result.ok ? "" : result.error, /changed or was removed after sign_policy read it/);
  assert.deepEqual(fake.recorded, [], "a refused signing must commit nothing");
  assert.equal(
    fake.rows.documents.find((d) => d.path === AUTO_MERGE_POLICY_PATH)?.body,
    "# policy\n\n- version: 2\n",
    "the newer policy must be left in place"
  );
});
