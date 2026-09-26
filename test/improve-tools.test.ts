import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, type ToolGrant } from "../src/server.ts";
import { anchorChecksum, parseScoresDoc, seedScoresDoc } from "../src/improve-scores.ts";
import { ROSTER } from "../src/improve-schema.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2, withFetch } from "./fakes.ts";

// improve_run and improve_status, over a real MCP connection. A read-only key must
// not reach improve_run; its SQL lives in a helper the source scan in
// test/invariants.test.ts cannot see, so the gate is driven here.

const SCORES = seedScoresDoc("capsid");

async function connect(grant: ToolGrant, opts: { seedToken?: boolean } = {}) {
  const d1 = fakeD1({
    documents: [{ namespace: "capsid", path: "improve/scores.md", title: "scores", body: SCORES, type: "reference" }],
  });
  const kv = fakeKv({
    seedToken: opts.seedToken,
    seed: {
      improve_mode: "api",
      "improve:anchor:capsid": await anchorChecksum(parseScoresDoc("capsid", SCORES)),
    },
  });
  const env = fakeEnv({ DB: d1.db, APP_KV: kv.kv, HOLDOUT: fakeR2().bucket, MEDIA: fakeR2().bucket });
  const server = buildServer(env, grant, "opkey:test");
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    d1,
    kv,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

test("A READ-ONLY KEY CANNOT REACH improve_run, and writes nothing while refusing", async () => {
  await withFetch({}, async () => {
    const { client, d1, kv, close } = await connect("read");
    const result = (await client.callTool({ name: "improve_run", arguments: { namespace: "capsid" } })) as ToolResult;
    await close();
    assert.equal(result.isError, true, "a read-only key reached improve_run");
    // The refusal names the missing scope (src/scope.ts).
    assert.match(result.content[0].text, /requires the write grant/);
    // The refusal has to come before any statement.
    assert.deepEqual(d1.recorded, [], "improve_run wrote statements while refusing a read-only key");
    assert.deepEqual(kv.puts, [], "improve_run wrote to KV while refusing a read-only key");
  });
});

test("a read-only key CAN read improve_status, because it is a read tool", async () => {
  await withFetch({}, async () => {
    const { client, close } = await connect("read");
    const result = (await client.callTool({ name: "improve_status", arguments: { namespace: "capsid" } })) as ToolResult;
    await close();
    assert.ok(!result.isError, `improve_status refused a read-only key: ${result.content?.[0]?.text}`);
    const parsed = JSON.parse(result.content[0].text) as { mode: string; namespaces: Array<{ namespace: string }> };
    assert.equal(parsed.mode, "api");
    assert.equal(parsed.namespaces[0].namespace, "capsid");
  });
});

test("improve_status NEVER WRITES, whatever grant it is called with", async () => {
  for (const grant of ["read", "write"] as const) {
    await withFetch({}, async () => {
      const { client, d1, kv, close } = await connect(grant);
      await client.callTool({ name: "improve_status", arguments: {} });
      await close();
      assert.deepEqual(d1.recorded, [], `improve_status wrote statements under the ${grant} grant`);
      assert.deepEqual(kv.puts, [], `improve_status wrote to KV under the ${grant} grant`);
    });
  }
});

test("improve_run REFUSES A NAMESPACE THAT IS NOT ON THE ROSTER, and names the roster", async () => {
  await withFetch({}, async () => {
    const { client, d1, close } = await connect("write");
    const result = (await client.callTool({ name: "improve_run", arguments: { namespace: "julieedwards" } })) as ToolResult;
    await close();
    assert.equal(result.isError, true, "an off-roster namespace was accepted");
    assert.match(result.content[0].text, /not on the improve roster/);
    assert.ok(ROSTER.length > 0, "the roster is empty, so the refusal was not checked for any name");
    for (const namespace of ROSTER) {
      assert.match(result.content[0].text, new RegExp(namespace), `the refusal does not name ${namespace}`);
    }
    assert.deepEqual(d1.recorded, [], "an off-roster refusal still wrote statements");
  });
});

test("improve_run with dry_run WRITES NOTHING through the tool surface either", async () => {
  // The repo is reachable, so the preview really reads GitHub (the default branch and
  // its sha). What it must not do is write there: no branch, no dispatch.
  const routes = {
    "GET /repos/owner/repo": { body: { default_branch: "main" } },
    "GET /repos/owner/repo/git/ref/heads/main": { body: { object: { sha: "a".repeat(40) } } },
  };
  await withFetch(routes, async (calls) => {
    const { client, d1, kv, close } = await connect("write", { seedToken: true });
    const result = (await client.callTool({
      name: "improve_run",
      arguments: { namespace: "capsid", dry_run: true },
    })) as ToolResult;
    await close();
    assert.ok(!result.isError, `dry_run errored: ${result.content?.[0]?.text}`);
    const parsed = JSON.parse(result.content[0].text) as { dry_run: boolean; opened: Array<{ note: string }> };
    assert.equal(parsed.dry_run, true);
    assert.equal(parsed.opened.length, 1);
    assert.match(parsed.opened[0].note, new RegExp(`would open a run and baseline ${"a".repeat(40)}`));
    assert.deepEqual(d1.recorded, [], "a dry run through the tool wrote statements");
    assert.deepEqual(kv.puts, [], "a dry run through the tool wrote to KV");
    assert.ok(calls.length > 0, "the preview never read GitHub, so no write could have been observed");
    const writes = calls.filter((c) => c.method !== "GET");
    assert.deepEqual(writes, [], "a dry run through the tool made a write call to GitHub");
  });
});
