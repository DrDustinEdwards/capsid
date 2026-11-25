import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server.ts";
import { fakeD1, fakeEnv, type FakeD1Options } from "./fakes.ts";

// The write and restore actions must report `snapshotted` from the snapshot they took, not from the pre-read: with
// confirm: true and no if_match, a row deleted in between is recreated by the upsert with no snapshot.

async function call(opts: FakeD1Options, name: string, args: Record<string, unknown>) {
  const fake = fakeD1(opts);
  const server = buildServer(fakeEnv({ DB: fake.db }), "write", "test:snapshotted");
  const client = new Client({ name: "snapshotted", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await client.close();
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return JSON.parse(result.content[0].text) as { snapshotted: boolean };
}

const DOC = { namespace: "capsid", path: "notes/lorem.md", title: "Lorem", body: "lorem ipsum" };
const VERSION = {
  id: 5,
  document_id: 1,
  namespace: "capsid",
  path: "notes/lorem.md",
  title: "Lorem",
  body: "older lorem",
  snapshot_at: "2026-01-01 00:00:00",
};
test("restore reports snapshotted: true when the snapshot was taken", async () => {
  const out = await call({ documents: [DOC], versions: [VERSION] }, "capsid_write_doc", {
    action: "restore",
    namespace: DOC.namespace,
    path: DOC.path,
    version_id: VERSION.id,
    confirm: true,
  });
  assert.equal(out.snapshotted, true);
});
