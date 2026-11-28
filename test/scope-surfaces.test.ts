import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server.ts";
import { defaultScopes } from "../src/agents-schema.ts";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// The surfaces the registrar cannot see. guardRegistrations wraps server.registerTool;
// resources and prompts are raw protocol handlers, `namespaces` takes no arguments so
// namespaceRefusal has nothing to fire on, and lint's gather needs its own check. Every plant goes through a real MCP client, because a
// real client can reach these surfaces.

const DOCS = [
  { namespace: "capsid", path: "core.md", title: "capsid core", body: "ours", type: "core" },
  { namespace: "foxhound", path: "core.md", title: "foxhound core", body: "SECRET", type: "core" },
  {
    namespace: "capsid",
    path: "prompts/ours.md",
    title: "ours",
    body: "hello {{name}}",
    type: "prompt",
  },
  {
    namespace: "foxhound",
    path: "prompts/theirs.md",
    title: "theirs",
    body: "secret {{name}}",
    type: "prompt",
  },
];

const NAMESPACES = [
  {
    namespace: "capsid",
    repos: JSON.stringify([{ repo: "DrDustinEdwards/capsid", label: "primary" }]),
  },
  {
    namespace: "foxhound",
    repos: JSON.stringify([{ repo: "DrDustinEdwards/foxhound", label: "primary" }]),
  },
];

async function connect(caller: Agent) {
  const d1 = fakeD1({ documents: DOCS, namespaces: NAMESPACES });
  const server = buildServer(
    fakeEnv({ DB: d1.db, APP_KV: fakeKv({ seedToken: true }).kv }),
    caller,
  );
  const client = new Client({ name: "scope-surfaces", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

// A driver as the roster mints one: one namespace, write, no flags.
function driver(namespace = "capsid"): Agent {
  const scopes = defaultScopes([namespace]);
  scopes.grants = ["read", "write"];
  return {
    id: "agent_0123456789ab",
    name: `${namespace}-driver`,
    kind: "driver",
    actor: `agent:${namespace}-driver`,
    scopes,
    admin: false,
    row: null,
  };
}

// resources and prompts

test("PLANT: a driver cannot READ another namespace's document by resource URI", async () => {
  // The `read` tool refuses this; the resource handler is not wrapped by the registrar.
  const { client, close } = await connect(driver());
  await assert.rejects(
    () => client.readResource({ uri: "capsid://foxhound/core.md" }),
    /not scoped to the 'foxhound' namespace/,
    "a one-namespace driver read another namespace's document by URI",
  );
  await close();
});

test("THE INNOCENT DIRECTION: the same driver reads its OWN namespace by URI", async () => {
  const { client, close } = await connect(driver());
  const result = (await client.readResource({ uri: "capsid://capsid/core.md" })) as {
    contents: Array<{ text: string }>;
  };
  await close();
  assert.equal(
    result.contents[0].text,
    "ours",
    "the driver was refused its own namespace, so the plant above proves nothing",
  );
});

test("PLANT: resources/list shows only the namespaces the caller is scoped to", async () => {
  const { client, close } = await connect(driver());
  const listed = (await client.listResources()) as { resources: Array<{ uri: string }> };
  await close();
  const uris = listed.resources.map((r) => r.uri);
  assert.ok(uris.length > 0, "the listing came back empty, so it proves nothing about the filter");
  assert.deepEqual(
    uris.filter((u) => u.includes("foxhound")),
    [],
    "another namespace's documents were listed to a scoped caller",
  );
  assert.ok(
    uris.some((u) => u === "capsid://capsid/core.md"),
    "the caller's own documents went missing with the filter",
  );
});

test("THE ADMIN STILL SEES EVERY NAMESPACE, so the filter is a scope and not a ceiling", async () => {
  const { client, close } = await connect(adminAgentForEmail("admin@example.com"));
  const listed = (await client.listResources()) as { resources: Array<{ uri: string }> };
  await close();
  const uris = listed.resources.map((r) => r.uri);
  assert.ok(
    uris.includes("capsid://foxhound/core.md"),
    "the admin lost sight of a namespace it is scoped to",
  );
});

test("PLANT: a driver cannot GET another namespace's prompt", async () => {
  // A prompt body reaches the client's model. Handing one across a namespace boundary
  // hands whoever last wrote that row a message in a session it is not scoped to.
  const { client, close } = await connect(driver());
  await assert.rejects(
    () => client.getPrompt({ name: "foxhound/prompts/theirs", arguments: { name: "x" } }),
    /not scoped to the 'foxhound' namespace/,
    "a one-namespace driver fetched another namespace's prompt",
  );
  await close();
});

test("THE INNOCENT DIRECTION: the same driver gets its OWN prompt", async () => {
  const { client, close } = await connect(driver());
  const result = (await client.getPrompt({
    name: "capsid/prompts/ours",
    arguments: { name: "world" },
  })) as {
    messages: Array<{ content: { resource: { text: string } } }>;
  };
  await close();
  assert.match(result.messages[0].content.resource.text, /hello world/);
});

test("PLANT: prompts/list shows only the caller's namespaces", async () => {
  const { client, close } = await connect(driver());
  const listed = (await client.listPrompts()) as { prompts: Array<{ name: string }> };
  await close();
  const names = listed.prompts.map((p) => p.name);
  assert.ok(names.length > 0, "the prompt listing came back empty, so it proves nothing");
  assert.deepEqual(
    names.filter((n) => n.startsWith("foxhound/")),
    [],
    "another namespace's prompts were listed",
  );
});

test("PLANT: a caller narrowed away from capsid_read_doc lists no resources and no prompts", async () => {
  // The read handlers ask checkScope as capsid_read_doc; the lists must ask the same, or a
  // narrowed key (a status-only driver) enumerates paths and prompt names.
  const narrowed = driver();
  narrowed.scopes.tools = ["capsid_read_status"];
  const { client, close } = await connect(narrowed);
  await assert.rejects(client.listResources(), /capsid_read_doc/);
  await assert.rejects(client.listPrompts(), /capsid_read_doc/);
  await close();
});

// the mapping is the boundary, so it is not handed out

test("PLANT: `capsid_find_docs` action `namespaces` shows a scoped caller only its own row", async () => {
  // The action takes no arguments, so namespaceRefusal has nothing to fire on. The mapping
  // is what the repos axis is built from and what resolveRepo resolves through.
  const { client, close } = await connect(driver());
  const result = (await client.callTool({
    name: "capsid_find_docs",
    arguments: { action: "namespaces" },
  })) as { content: Array<{ text: string }> };
  await close();
  const rows = JSON.parse(result.content[0].text) as Array<{ namespace: string }>;
  assert.deepEqual(
    rows.map((r) => r.namespace),
    ["capsid"],
    "a one-namespace driver read the whole namespace-to-repo mapping",
  );
});

test("THE ADMIN STILL SEES THE WHOLE MAPPING", async () => {
  const { client, close } = await connect(adminAgentForEmail("admin@example.com"));
  const result = (await client.callTool({
    name: "capsid_find_docs",
    arguments: { action: "namespaces" },
  })) as { content: Array<{ text: string }> };
  await close();
  const rows = JSON.parse(result.content[0].text) as Array<{ namespace: string }>;
  assert.deepEqual(rows.map((r) => r.namespace).sort(), ["capsid", "foxhound"]);
});

test("PLANT: capsid_read_status status hands a scoped caller NO credential inventory", async () => {
  // `agents` names every minted credential, its namespaces, its grants and its
  // blast-radius flags: the map an agent looking to widen itself would want.
  const { client, close } = await connect(driver());
  const result = (await client.callTool({
    name: "capsid_read_status",
    arguments: { action: "status", namespace: "capsid" },
  })) as {
    content: Array<{ text: string }>;
  };
  await close();
  const body = JSON.parse(result.content[0].text) as { agents?: unknown[] };
  assert.equal(body.agents, undefined, "a scoped driver read the whole credential inventory");
});

test("THE ADMIN STILL GETS THE INVENTORY, which is who it is for", async () => {
  const { client, close } = await connect(adminAgentForEmail("admin@example.com"));
  const result = (await client.callTool({
    name: "capsid_read_status",
    arguments: { action: "status" },
  })) as { content: Array<{ text: string }> };
  await close();
  const body = JSON.parse(result.content[0].text) as { agents?: unknown[] };
  assert.ok(Array.isArray(body.agents), "the admin lost the inventory it is the audience for");
});

// lint gather

test("PLANT: a WRITE-ONLY agent is refused lint gather, which is the grant half", async () => {
  // lint is an "action" tool, so the registrar names no grant and the handler must ask
  // for read on gather. The caller clears the registrar on purpose: full tools axis, one
  // grant, and the grant is the wrong one, so the plant would fail with the handler check deleted.
  const caller = driver();
  caller.scopes.grants = ["write"];
  const { client, close } = await connect(caller);
  const result = (await client.callTool({
    name: "capsid_lint_namespace",
    arguments: { namespace: "capsid" },
  })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await close();
  assert.equal(result.isError, true, "an agent with no read grant gathered the whole namespace");
  assert.match(result.content[0].text, /requires the read grant/, result.content[0].text);
});

test("THE INNOCENT DIRECTION: a read-grant agent may still gather", async () => {
  // gather is the read half of the loop and the driving client runs it every pass.
  const caller = driver();
  caller.scopes.grants = ["read"];
  const { client, close } = await connect(caller);
  const result = (await client.callTool({
    name: "capsid_lint_namespace",
    arguments: { namespace: "capsid" },
  })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await close();
  assert.doesNotMatch(
    result.content[0].text,
    /unauthorized:/,
    `a read agent was refused gather: ${result.content[0].text}`,
  );
  assert.notEqual(result.isError, true, result.content[0].text);
  const packet = JSON.parse(result.content[0].text) as {
    mode: string;
    core: { body: string } | null;
  };
  assert.equal(packet.mode, "gather");
  assert.equal(packet.core?.body, "ours", "gather did not return the caller's own core document");
});

test("THE OTHER INNOCENT DIRECTION: the write branches still take the write grant", async () => {
  // report and finalize still require write: a read-only caller is refused report.
  const caller = driver();
  caller.scopes.grants = ["read"];
  const { client, close } = await connect(caller);
  const result = (await client.callTool({
    name: "capsid_lint_namespace",
    arguments: { namespace: "capsid", mode: "report" },
  })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await close();
  assert.equal(result.isError, true, "a read-only agent ran lint report, which writes a document");
  assert.match(result.content[0].text, /requires the write grant/, result.content[0].text);
});
