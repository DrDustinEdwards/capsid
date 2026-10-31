import assert from "node:assert/strict";
import { test } from "node:test";
import { buildServer } from "../src/server.ts";
import { adminAgentForEmail } from "../src/agents.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";
import { httpClient, LEGACY, mcpFetch, MODERN } from "./mcp-http.ts";

// Capsid's tools in both eras through src/mcp-handler.ts: 2026-07-28 by server/discover
// and the per-request envelope, and 2025-11-25 by initialize through site-runtime's
// routeMcpEra, which is tested there.

const env = () =>
  fakeEnv({
    DB: fakeD1({ documents: [{ id: 1, namespace: "sample", path: "notes/one.md", title: "One", body: "one", type: "note" }], namespaces: [{ namespace: "sample", repos: "[]" }] }).db,
    APP_KV: fakeKv({}).kv,
  });
const admin = adminAgentForEmail("admin@example.com");

for (const era of [MODERN, LEGACY] as const) {
  test(`PLANT: a ${era} client lists the tools and calls one`, async () => {
    const e = env();
    const client = await httpClient(e, () => buildServer(e, admin), era);
    try {
      assert.equal(client.getNegotiatedProtocolVersion(), era);
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === "capsid_read_doc"));
      const result = (await client.callTool({ name: "capsid_read_doc", arguments: { namespace: "sample", path: "notes/one.md" } })) as { content: Array<{ text: string }>; isError?: boolean };
      assert.notEqual(result.isError, true, result.content[0]?.text);
      assert.match(result.content[0].text, /"body":\s*"one"/);
    } finally {
      await client.close();
    }
  });
}

test("PLANT: /ops/mcp refuses a foreign browser Origin; /mcp leaves Origin to src/index.ts, which admits claude.ai", async () => {
  const e = env();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "o", version: "1" } } });
  const headers = (origin: string) => ({ "Content-Type": "application/json", Accept: "application/json, text/event-stream", Origin: origin });
  const ops = await mcpFetch(e, () => buildServer(e, admin), "/ops/mcp")("https://mcp.example.com/ops/mcp", { method: "POST", headers: headers("https://evil.example"), body });
  assert.equal(ops.status, 403);
  const mcp = await mcpFetch(e, () => buildServer(e, admin), "/mcp")("https://mcp.example.com/mcp", { method: "POST", headers: headers("https://claude.ai"), body });
  assert.equal(mcp.status, 200, "the wrapper refused claude.ai on /mcp, which src/index.ts admits");
});
