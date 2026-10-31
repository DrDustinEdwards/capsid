import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { buildServer } from "../src/server.ts";
import { adminAgentForEmail } from "../src/agents.ts";
import { CAPSID_TOOLS } from "../src/tools/surface.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// The tool list is cached as "public" (src/server.ts, site-runtime's mcpCacheHints, which
// is tested there): every caller must be served the same list, in registration order.

async function connect(server: McpServer) {
  const client = new Client({ name: "cache-hints", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("PLANT: the tool list is served in registration order", async () => {
  // Every registerTool call, in the order buildServer makes them. guardRegistrations
  // binds the prototype method it finds, so a spy there sees every registration.
  const registered: string[] = [];
  const original = McpServer.prototype.registerTool;
  McpServer.prototype.registerTool = function (this: McpServer, ...args: unknown[]) {
    registered.push(String(args[0]));
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  } as unknown as typeof original;
  let server: McpServer;
  try {
    server = buildServer(fakeEnv({ APP_KV: fakeKv({}).kv }), adminAgentForEmail("admin@example.com"));
  } finally {
    McpServer.prototype.registerTool = original;
  }
  assert.equal(registered.length, CAPSID_TOOLS.length, `the spy saw ${registered.length} registrations`);
  const client = await connect(server);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      registered,
      "tools/list is not in registration order"
    );
  } finally {
    await client.close();
  }
});

test("PLANT: the tool list is identical across two builds for two different callers", async () => {
  // "public" is a claim that every caller gets the same list. A read-only operator
  // key and the admin are the two ends of the scope range.
  const env = fakeEnv({ APP_KV: fakeKv({}).kv });
  const admin = await connect(buildServer(env, adminAgentForEmail("admin@example.com")));
  const readOnly = await connect(buildServer(env, "read", "test:cache-hints"));
  try {
    const a = (await admin.listTools()) as unknown;
    const b = (await readOnly.listTools()) as unknown;
    assert.equal(JSON.stringify(a), JSON.stringify(b), "two callers were served different tool lists, so the list cannot be public");
  } finally {
    await admin.close();
    await readOnly.close();
  }
});
