import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { buildServer } from "../src/server.ts";
import { adminAgentForEmail } from "../src/agents.ts";
import { CAPSID_TOOLS } from "../src/tools/surface.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// The tool list is cached private (src/server.ts, site-runtime's mcpCacheHints, which is
// tested there): each caller is served the tools its grant can call, in registration order.

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
    server = buildServer(
      fakeEnv({ APP_KV: fakeKv({}).kv }),
      adminAgentForEmail("admin@example.com"),
    );
  } finally {
    McpServer.prototype.registerTool = original;
  }
  assert.equal(
    registered.length,
    CAPSID_TOOLS.length,
    `the spy saw ${registered.length} registrations`,
  );
  const client = await connect(server);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      registered,
      "tools/list is not in registration order",
    );
  } finally {
    await client.close();
  }
});
