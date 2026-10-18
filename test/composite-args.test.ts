import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { adminAgentForEmail } from "../src/agents.ts";
import { buildServer } from "../src/server.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// An action that takes fewer arguments than its operation declares (src/tools/surface.ts
// ActionSpec.fields) refuses one it does not take, rather than dropping it. A comment
// silently dropped from a merge is a review nobody posted; a sha dropped from a comment
// is a check nobody made. The refusal must hold for an argument NO action of the tool
// takes, which the SDK would strip before the handler saw it if the schema did.

async function call(name: string, args: Record<string, unknown>) {
  const server = buildServer(fakeEnv({ APP_KV: fakeKv({}).kv }), adminAgentForEmail("admin@example.com"));
  const client = new Client({ name: "composite-args", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true, fetches };
  } finally {
    globalThis.fetch = original;
    await client.close();
  }
}

test("PLANT: a comment sent with a merge is refused, and nothing reaches GitHub", async () => {
  const r = await call("capsid_close_pr", { action: "merge", namespace: "sample", number: 7, comment: "LGTM" });
  assert.equal(r.isError, true);
  assert.match(r.text, /capsid_close_pr action 'merge' does not take comment/);
  assert.equal(r.fetches, 0);
});

test("PLANT: a sha sent with a comment is refused, and nothing is posted", async () => {
  const r = await call("capsid_open_pr", { action: "comment", namespace: "sample", number: 7, comment: "a note", sha: "a".repeat(40) });
  assert.equal(r.isError, true);
  assert.match(r.text, /capsid_open_pr action 'comment' does not take sha/);
  assert.equal(r.fetches, 0);
});

test("PLANT: a sha sent with a close is refused", async () => {
  const r = await call("capsid_close_pr", { action: "close", namespace: "sample", number: 7, sha: "a".repeat(40) });
  assert.equal(r.isError, true);
  assert.match(r.text, /does not take sha/);
  assert.equal(r.fetches, 0);
});

test("PLANT: an unknown argument to a run_improve claim is refused", async () => {
  const r = await call("capsid_run_improve", { action: "claim", namespace: "sample", mode: "off" });
  assert.equal(r.isError, true);
  assert.match(r.text, /capsid_run_improve action 'claim' does not take mode/);
});

test("THE INNOCENT DIRECTION: the arguments an action takes go through to its operation", async () => {
  const r = await call("capsid_close_pr", { action: "merge", namespace: "sample", number: 7, merge_method: "squash" });
  assert.doesNotMatch(r.text, /does not take/);
});

test("PLANT: two actions that share an argument name with different values each accept their own", async () => {
  // search's report is performance | inspect | sitemaps; bing's adds queries, traffic and more.
  // The tool's schema once kept only the first action's, so bing's own reports were refused.
  const bing = await call("capsid_inspect_repo", { action: "bing", namespace: "sample", report: "traffic" });
  assert.doesNotMatch(bing.text, /Invalid option|Input validation error/);
  const wrong = await call("capsid_inspect_repo", { action: "search", namespace: "sample", report: "traffic" });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /report/);
  assert.equal(wrong.fetches, 0);
});
