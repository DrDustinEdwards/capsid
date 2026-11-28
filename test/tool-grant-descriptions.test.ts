import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildAdminServer, buildServer } from "../src/server.ts";
import { adminAgentForEmail } from "../src/agents.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// Claude Code cuts a tool description at 4,096 characters.
test("every served tool's description fits the 4,096 characters Claude Code shows", async () => {
  const over: string[] = [];
  let served = 0;
  for (const build of [buildServer, buildAdminServer]) {
    const server = build(
      fakeEnv({ APP_KV: fakeKv({}).kv }),
      adminAgentForEmail("admin@example.com"),
    );
    const client = new Client({ name: "tool-descriptions", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    await client.close();
    served += tools.length;
    for (const t of tools)
      if ((t.description ?? "").length > 4096) over.push(`${t.name} (${t.description?.length})`);
  }
  assert.ok(served > 0, "the server served no tools");
  assert.deepEqual(over, []);
});
