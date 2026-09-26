import assert from "node:assert/strict";
import { test } from "node:test";
import { DOC_STATUSES, DOC_TYPES, validateDocStatus, validateDocType } from "../src/doc-meta.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { type DocRow, fakeD1, fakeEnv } from "./fakes.ts";

// Closure affects only brief's task list. The lint loop must not filter on it,
// because the archive/ prefix is the only thing that takes a document out of memory.
// Driven through the tools: a closed document is still in lint gather, and brief
// leaves a closed task out.
async function toolOut(name: string, documents: DocRow[]) {
  const fake = fakeD1({ documents, namespaces: [{ namespace: "capsid", repos: "[]" }] });
  const server = buildServer(fakeEnv({ DB: fake.db }), "write", "test:doc-meta");
  const client = new Client({ name: "doc-meta", version: "1.0.0" });
  const [c, t] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(t), client.connect(c)]);
  const result = (await client.callTool({ name, arguments: { namespace: "capsid" } })) as { isError?: boolean; content: Array<{ text: string }> };
  await client.close();
  assert.notEqual(result.isError, true, result.content[0]?.text);
  return JSON.parse(result.content[0].text);
}

const CLOSED_AND_OPEN: DocRow[] = [
  { namespace: "capsid", path: "core.md", title: "core", body: "core", type: "core", status: "published" },
  { namespace: "capsid", path: "concept-closed.md", title: "c", body: "c", type: "concept", status: "closed" },
  { namespace: "capsid", path: "ep-closed.md", title: "e", body: "e", type: "episodic", status: "closed" },
  { namespace: "capsid", path: "TASK-closed.md", title: "t", body: "t", type: "task", status: "closed" },
  { namespace: "capsid", path: "TASK-open.md", title: "t", body: "t", type: "task", status: "active" },
];

test("closure does not remove a document from the lint loop", async () => {
  const packet = await toolOut("lint", CLOSED_AND_OPEN);
  assert.deepEqual(packet.wiki.map((d: { path: string }) => d.path), ["concept-closed.md"], "a closed concept fell out of gather");
  assert.deepEqual(
    packet.unconsolidated.map((d: { path: string }) => d.path),
    ["ep-closed.md"],
    "a closed episodic fell out of gather, so it can never be consolidated"
  );
});

test("brief leaves a closed task out of its open tasks, and keeps an open one", async () => {
  const out = await toolOut("brief", CLOSED_AND_OPEN);
  assert.deepEqual(out.open_tasks.map((t: { path: string }) => t.path), ["TASK-open.md"]);
});

test("every valid status is accepted", () => {
  assert.ok(DOC_STATUSES.size > 0, "DOC_STATUSES is empty, so this checks nothing");
  for (const status of DOC_STATUSES) {
    assert.equal(validateDocStatus(status), null, `expected '${status}' to be accepted`);
  }
});

test("every valid type is accepted", () => {
  assert.ok(DOC_TYPES.size > 0, "DOC_TYPES is empty, so this checks nothing");
  for (const type of DOC_TYPES) {
    assert.equal(validateDocType(type), null, `expected '${type}' to be accepted`);
  }
});

// An unvalidated status would be stored silently, with no error anywhere.
test("an off-schema status is rejected and the message lists the valid set", () => {
  const error = validateDocStatus("in-progress");
  assert.ok(error, "expected 'in-progress' to be rejected");
  assert.match(error, /unknown status 'in-progress'/);
  assert.match(error, /published/);
});

test("an off-schema type is rejected and the message names episodic", () => {
  const error = validateDocType("session");
  assert.ok(error, "expected 'session' to be rejected");
  assert.match(error, /unknown type 'session'/);
  assert.match(error, /episodic/);
});

// 'active' is valid: status is not a visibility filter, and rejecting it would break
// the callers that write it.

test("status validation does not accept the empty string", () => {
  assert.ok(validateDocStatus(""), "expected the empty string to be rejected");
});
