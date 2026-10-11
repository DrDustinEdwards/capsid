import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { buildServer } from "../src/server.ts";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import { defaultScopes } from "../src/agents-schema.ts";
import { CACHE_HINTS, LIST_TTL_MS, PRIVATE_LIST, PUBLIC_LIST } from "../src/cache-hints.ts";
import { CAPSID_TOOLS } from "../src/tools/surface.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";
import { httpClient, LEGACY, MODERN } from "./mcp-http.ts";

// Cache hints on list results (src/cache-hints.ts): the tool list is the same for
// every caller, so public; prompts and resources are filtered per caller, so private.
// Both for 60 seconds. They are the SDK's cacheHints server option, which fills them on
// 2026-07-28 responses and never on 2025-11-25 ones.

const fixtureDb = () =>
  fakeD1({
    documents: [
      { id: 1, namespace: "sample", path: "notes/one.md", title: "One", body: "one", type: "note" },
      { id: 2, namespace: "sample", path: "prompts/hello", title: "Hello", body: "Hello {{name}}", type: "prompt" },
    ],
    namespaces: [{ namespace: "sample", repos: "[]" }],
  }).db;

const hintsOf = (result: Record<string, unknown>) => ({ ttlMs: result.ttlMs, cacheScope: result.cacheScope });

const adminEnv = () => fakeEnv({ DB: fixtureDb(), APP_KV: fakeKv({}).kv });

test("the TTL is sixty seconds and the scopes are the two the protocol names", () => {
  assert.equal(LIST_TTL_MS, 60_000);
  assert.deepEqual(PUBLIC_LIST, { ttlMs: 60_000, cacheScope: "public" });
  assert.deepEqual(PRIVATE_LIST, { ttlMs: 60_000, cacheScope: "private" });
  assert.deepEqual(CACHE_HINTS["tools/list"], PUBLIC_LIST);
  assert.deepEqual(CACHE_HINTS["server/discover"], PUBLIC_LIST);
  for (const method of ["prompts/list", "resources/list", "resources/templates/list", "resources/read"] as const) {
    assert.deepEqual(CACHE_HINTS[method], PRIVATE_LIST, method);
  }
});

test("PLANT: tools/list on 2026-07-28 carries ttlMs 60000 and cacheScope public", async () => {
  const env = adminEnv();
  const client = await httpClient(env, () => buildServer(env, adminAgentForEmail("admin@example.com")), MODERN);
  try {
    assert.equal(client.getNegotiatedProtocolVersion(), MODERN, "the client did not reach the modern era, so this checks nothing");
    const result = (await client.listTools()) as unknown as Record<string, unknown>;
    assert.deepEqual(hintsOf(result), { ttlMs: 60000, cacheScope: "public" }, "tools/list was served without its cache hints");
  } finally {
    await client.close();
  }
});

test("PLANT: prompts/list, resources/list, resources/templates/list and resources/read carry private hints", async () => {
  const env = adminEnv();
  const client = await httpClient(env, () => buildServer(env, adminAgentForEmail("admin@example.com")), MODERN);
  try {
    // One page each (an explicit cursor), so the result is the server's own and not
    // the client's aggregate.
    const prompts = (await client.listPrompts({ cursor: "" })) as unknown as Record<string, unknown>;
    assert.ok((prompts.prompts as unknown[]).length > 0, "the fixture prompt was not listed, so the hint is checked on an empty result");
    assert.deepEqual(hintsOf(prompts), { ttlMs: 60000, cacheScope: "private" }, "prompts/list");
    const resources = (await client.listResources({ cursor: "" })) as unknown as Record<string, unknown>;
    assert.ok((resources.resources as unknown[]).length > 0, "the fixture documents were not listed");
    assert.deepEqual(hintsOf(resources), { ttlMs: 60000, cacheScope: "private" }, "resources/list");
    const templates = (await client.listResourceTemplates({ cursor: "" })) as unknown as Record<string, unknown>;
    assert.deepEqual(hintsOf(templates), { ttlMs: 60000, cacheScope: "private" }, "resources/templates/list");
    const read = (await client.readResource({ uri: "capsid://sample/notes/one.md" })) as unknown as Record<string, unknown>;
    assert.equal((read.contents as Array<{ text: string }>)[0].text, "one", "resources/read lost its content");
    assert.deepEqual(hintsOf(read), { ttlMs: 60000, cacheScope: "private" }, "resources/read");
  } finally {
    await client.close();
  }
});

test("resources/list's early return for a caller scoped to no namespace carries the hints too", async () => {
  const agent: Agent = { id: "agent_nowhere1", name: "nowhere", kind: "session", actor: "agent:nowhere", scopes: defaultScopes([]), admin: false, row: null };
  const env = adminEnv();
  const client = await httpClient(env, () => buildServer(env, agent), MODERN);
  try {
    const resources = (await client.listResources({ cursor: "" })) as unknown as Record<string, unknown>;
    assert.deepEqual(resources.resources, []);
    assert.deepEqual(hintsOf(resources), PRIVATE_LIST);
  } finally {
    await client.close();
  }
});

test("a 2025-11-25 client sees the lists exactly as before: no cache fields", async () => {
  const env = adminEnv();
  const client = await httpClient(env, () => buildServer(env, adminAgentForEmail("admin@example.com")), LEGACY);
  try {
    assert.equal(client.getNegotiatedProtocolVersion(), LEGACY);
    const tools = (await client.listTools()) as unknown as Record<string, unknown>;
    assert.ok((tools.tools as unknown[]).length > 0);
    assert.deepEqual(hintsOf(tools), { ttlMs: undefined, cacheScope: undefined }, "a legacy response carried 2026 cache fields");
  } finally {
    await client.close();
  }
});

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

test("PLANT: the private request handler map is no longer touched", async () => {
  // The hints were once a patch on the SDK's private _requestHandlers map. They are the
  // SDK's own option now, and nothing in src/ reaches into its private fields.
  const { readFileSync, readdirSync } = await import("node:fs");
  const offenders = readdirSync("src", { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts") && readFileSync(`src/${f}`, "utf8").includes("_requestHandlers"));
  assert.deepEqual(offenders, []);
});
