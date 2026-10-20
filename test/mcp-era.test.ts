import assert from "node:assert/strict";
import { test } from "node:test";
import { buildServer } from "../src/server.ts";
import { adminAgentForEmail } from "../src/agents.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";
import { allSourceText } from "./source-files.ts";
import { httpClient, LEGACY, mcpFetch, MODERN } from "./mcp-http.ts";

// The two eras through src/mcp-handler.ts: 2026-07-28 by server/discover and the
// per-request envelope, and 2025-11-25 by initialize through the shim in
// src/legacy-era.ts. The tools are the same in both: this PR changes no tool.

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

test("both eras serve the same tool list", async () => {
  const e = env();
  const modern = await httpClient(e, () => buildServer(e, admin), MODERN);
  const legacy = await httpClient(e, () => buildServer(e, admin), LEGACY);
  try {
    assert.deepEqual((await modern.listTools()).tools, (await legacy.listTools()).tools);
  } finally {
    await modern.close();
    await legacy.close();
  }
});

test("a bare 2025-era initialize is answered with 2025-11-25, and the GET stream is 405", async () => {
  const e = env();
  const fetchMcp = mcpFetch(e, () => buildServer(e, admin));
  const init = await fetchMcp("https://mcp.example.com/ops/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "bare", version: "1" } } }),
  });
  assert.equal(init.status, 200);
  const text = await init.text();
  assert.match(text, /"protocolVersion":"2025-11-25"/);
  assert.match(text, /"name":"capsid"/);
  const get = await fetchMcp("https://mcp.example.com/ops/mcp", { method: "GET", headers: { Accept: "text/event-stream" } });
  assert.equal(get.status, 405);
});

test("PLANT: /ops/mcp refuses a foreign browser Origin; /mcp leaves Origin to src/security-headers.ts, which admits claude.ai", async () => {
  const e = env();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "o", version: "1" } } });
  const headers = (origin: string) => ({ "Content-Type": "application/json", Accept: "application/json, text/event-stream", Origin: origin });
  const ops = await mcpFetch(e, () => buildServer(e, admin), "/ops/mcp")("https://mcp.example.com/ops/mcp", { method: "POST", headers: headers("https://evil.example"), body });
  assert.equal(ops.status, 403);
  const mcp = await mcpFetch(e, () => buildServer(e, admin), "/mcp")("https://mcp.example.com/mcp", { method: "POST", headers: headers("https://claude.ai"), body });
  assert.equal(mcp.status, 200, "the wrapper refused claude.ai on /mcp, which src/security-headers.ts admits");
});

test("the legacy shim has one call site, so deleting src/legacy-era.ts leaves a modern-only server", () => {
  const text = allSourceText();
  assert.equal(text.split('from "./legacy-era"').length - 1, 1);
  assert.equal(text.split("createLegacyEraHandler(").length - 1, 2, "one definition and one call");
});
