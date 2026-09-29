import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildServer } from "../src/server.ts";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import { defaultScopes } from "../src/agents-schema.ts";
import { decorateCacheHints, LIST_TTL_MS, PRIVATE_LIST, PUBLIC_LIST } from "../src/cache-hints.ts";
import { TOOL_HINTS } from "../src/tool-annotations.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// Cache hints on list results (src/cache-hints.ts): the tool list is the same for
// every caller, so public; prompts and resources are filtered per caller, so private.
// Both for 60 seconds.

async function connect(server: McpServer) {
  const client = new Client({ name: "cache-hints", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const fixtureDb = () =>
  fakeD1({
    documents: [
      { id: 1, namespace: "sample", path: "notes/one.md", title: "One", body: "one", type: "note" },
      { id: 2, namespace: "sample", path: "prompts/hello", title: "Hello", body: "Hello {{name}}", type: "prompt" },
    ],
    namespaces: [{ namespace: "sample", repos: "[]" }],
  }).db;

const hintsOf = (result: Record<string, unknown>) => ({ ttlMs: result.ttlMs, cacheScope: result.cacheScope });

const withoutHints = (result: Record<string, unknown>) => {
  const copy = { ...result };
  delete copy.ttlMs;
  delete copy.cacheScope;
  return copy;
};

test("the TTL is sixty seconds and the scopes are the two the protocol names", () => {
  assert.equal(LIST_TTL_MS, 60_000);
  assert.deepEqual(PUBLIC_LIST, { ttlMs: 60_000, cacheScope: "public" });
  assert.deepEqual(PRIVATE_LIST, { ttlMs: 60_000, cacheScope: "private" });
});

test("PLANT: tools/list carries ttlMs 60000 and cacheScope public", async () => {
  const client = await connect(buildServer(fakeEnv({ APP_KV: fakeKv({}).kv }), adminAgentForEmail("admin@example.com")));
  try {
    const result = (await client.listTools()) as unknown as Record<string, unknown>;
    assert.deepEqual(hintsOf(result), PUBLIC_LIST, "tools/list was served without its cache hints");
  } finally {
    await client.close();
  }
});

test("PLANT: prompts/list, resources/list, resources/templates/list and resources/read carry private hints", async () => {
  const client = await connect(buildServer(fakeEnv({ DB: fixtureDb(), APP_KV: fakeKv({}).kv }), adminAgentForEmail("admin@example.com")));
  try {
    const prompts = (await client.listPrompts()) as unknown as Record<string, unknown>;
    assert.ok((prompts.prompts as unknown[]).length > 0, "the fixture prompt was not listed, so the hint is checked on an empty result");
    assert.deepEqual(hintsOf(prompts), PRIVATE_LIST, "prompts/list");
    const resources = (await client.listResources()) as unknown as Record<string, unknown>;
    assert.ok((resources.resources as unknown[]).length > 0, "the fixture documents were not listed");
    assert.deepEqual(hintsOf(resources), PRIVATE_LIST, "resources/list");
    const templates = (await client.listResourceTemplates()) as unknown as Record<string, unknown>;
    assert.deepEqual(hintsOf(templates), PRIVATE_LIST, "resources/templates/list");
    const read = (await client.readResource({ uri: "capsid://sample/notes/one.md" })) as unknown as Record<string, unknown>;
    assert.equal((read.contents as Array<{ text: string }>)[0].text, "one", "resources/read lost its content");
    assert.deepEqual(hintsOf(read), PRIVATE_LIST, "resources/read");
  } finally {
    await client.close();
  }
});

test("resources/list's early return for a caller scoped to no namespace carries the hints too", async () => {
  const agent: Agent = { id: "agent_nowhere1", name: "nowhere", kind: "session", actor: "agent:nowhere", scopes: defaultScopes([]), admin: false, row: null };
  const client = await connect(buildServer(fakeEnv({ DB: fixtureDb(), APP_KV: fakeKv({}).kv }), agent));
  try {
    const resources = (await client.listResources()) as unknown as Record<string, unknown>;
    assert.deepEqual(resources.resources, []);
    assert.deepEqual(hintsOf(resources), PRIVATE_LIST);
  } finally {
    await client.close();
  }
});

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
  assert.equal(registered.length, Object.keys(TOOL_HINTS).length, `the spy saw ${registered.length} registrations`);
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

test("PLANT: decorating leaves the original tools/list result intact", async () => {
  // Two identical servers, one decorated. Everything but the two hint fields must
  // match, so the SDK's JSON Schema conversion is still the one served.
  const make = () => {
    const server = new McpServer({ name: "cache-hints-fixture", version: "1.0.0" });
    server.registerTool(
      "sample_tool",
      { description: "A sample tool.", inputSchema: { path: z.string().max(10), n: z.number().int().optional() }, annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] })
    );
    server.registerResource("sample", "sample://one", { mimeType: "text/plain" }, async (uri) => ({ contents: [{ uri: uri.href, text: "one" }] }));
    return server;
  };
  const decorated = make();
  decorateCacheHints(decorated);
  const plainClient = await connect(make());
  const decoratedClient = await connect(decorated);
  try {
    const plain = (await plainClient.listTools()) as unknown as Record<string, unknown>;
    const withHints = (await decoratedClient.listTools()) as unknown as Record<string, unknown>;
    assert.deepEqual(hintsOf(withHints), PUBLIC_LIST);
    assert.equal(plain.ttlMs, undefined, "the undecorated fixture already carries a hint, so this comparison proves nothing");
    assert.deepEqual(withoutHints(withHints), plain, "decorating changed the result it decorates");
    const plainRead = (await plainClient.readResource({ uri: "sample://one" })) as unknown as Record<string, unknown>;
    const decoratedRead = (await decoratedClient.readResource({ uri: "sample://one" })) as unknown as Record<string, unknown>;
    assert.deepEqual(hintsOf(decoratedRead), PRIVATE_LIST);
    assert.deepEqual(withoutHints(decoratedRead), plainRead, "decorating changed the resources/read result");
  } finally {
    await plainClient.close();
    await decoratedClient.close();
  }
});

test("PLANT: decorating a server with no tool handler fails closed and names the method", () => {
  // Called before any registration, there is nothing to wrap. Serving the list
  // without its hints would be the silent version of this.
  const server = new McpServer({ name: "cache-hints-empty", version: "1.0.0" });
  assert.throws(() => decorateCacheHints(server), /tools\/list/);
});
