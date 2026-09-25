import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { fakeD1, fakeEnv, type FakeD1Options, type FakeD1Rows } from "./fakes.ts";

// write AND restore REPORT `snapshotted` FROM THE SNAPSHOT THEY TOOK (audit 2026-09-25,
// item E1-20, finding F3-8). Both used to answer snapshotted: true whenever their
// pre-read found a row. With confirm: true and no if_match no guard is armed, so a row
// deleted between the pre-read and the batch is snapshotted by nothing and the upsert
// recreates it; the response still said a snapshot was taken. Nothing is lost (the
// delete snapshotted it), but the response was wrong. The same race against real
// SQLite is in test-integration/snapshotted.test.ts.

async function call(opts: FakeD1Options, name: string, args: Record<string, unknown>) {
  const fake = fakeD1(opts);
  const server = buildServer(fakeEnv({ DB: fake.db }), "write", "test:snapshotted");
  const client = new Client({ name: "snapshotted", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  await client.close();
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return JSON.parse(result.content[0].text) as { snapshotted: boolean };
}

const DOC = { namespace: "capsid", path: "notes/lorem.md", title: "Lorem", body: "lorem ipsum" };
const VERSION = { id: 5, document_id: 1, namespace: "capsid", path: "notes/lorem.md", title: "Lorem", body: "older lorem", snapshot_at: "2026-01-01 00:00:00" };
const deleteTarget = (rows: FakeD1Rows, target: { namespace: string; path: string }) => {
  rows.documents = rows.documents.filter((d) => !(d.namespace === target.namespace && d.path === target.path));
};

test("write reports snapshotted: false when the row was deleted before its batch", async () => {
  const out = await call({ documents: [DOC], raceAfterPreRead: deleteTarget }, "write", {
    namespace: DOC.namespace,
    path: DOC.path,
    title: "Lorem",
    body: "new lorem",
    confirm: true,
  });
  assert.equal(out.snapshotted, false, "write claimed a snapshot that no statement took");
});

test("write reports snapshotted: true when the snapshot was taken", async () => {
  const out = await call({ documents: [DOC] }, "write", { namespace: DOC.namespace, path: DOC.path, title: "Lorem", body: "new lorem", confirm: true });
  assert.equal(out.snapshotted, true);
});

test("restore reports snapshotted: false when the row was deleted before its batch", async () => {
  const out = await call({ documents: [DOC], versions: [VERSION], raceAfterPreRead: deleteTarget }, "restore", {
    namespace: DOC.namespace,
    path: DOC.path,
    version_id: VERSION.id,
    confirm: true,
  });
  assert.equal(out.snapshotted, false, "restore claimed a snapshot that no statement took");
});

test("restore reports snapshotted: true when the snapshot was taken", async () => {
  const out = await call({ documents: [DOC], versions: [VERSION] }, "restore", {
    namespace: DOC.namespace,
    path: DOC.path,
    version_id: VERSION.id,
    confirm: true,
  });
  assert.equal(out.snapshotted, true);
});
