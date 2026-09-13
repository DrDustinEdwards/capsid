import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { defaultScopes } from "../src/agents-schema.ts";
import { adminAgent, type Agent } from "../src/agents.ts";
import { watcherAgent } from "../src/watcher.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// THE SURFACES THE REGISTRAR CANNOT SEE.
//
// guardRegistrations wraps server.registerTool. Everything else a client can call is
// outside it by construction: resources/read, resources/list, prompts/list and
// prompts/get are raw protocol handlers, `namespaces` takes no arguments so
// namespaceRefusal has nothing to fire on, `jobs` action list returned before its own
// scope call, and improve_run's control actions ran on a plain write grant.
//
// Audit 2026-09-13, findings 5, 6 and 7. Every plant here goes through a real MCP
// client, because the point of all five is that a real client could reach them.

const DOCS = [
  { namespace: "capsid", path: "core.md", title: "capsid core", body: "ours", type: "core" },
  { namespace: "foxhound", path: "core.md", title: "foxhound core", body: "SECRET", type: "core" },
  { namespace: "capsid", path: "prompts/ours.md", title: "ours", body: "hello {{name}}", type: "prompt" },
  { namespace: "foxhound", path: "prompts/theirs.md", title: "theirs", body: "secret {{name}}", type: "prompt" },
];

const NAMESPACES = [
  { namespace: "capsid", repos: JSON.stringify([{ repo: "DrDustinEdwards/capsid", label: "primary" }]) },
  { namespace: "foxhound", repos: JSON.stringify([{ repo: "DrDustinEdwards/foxhound", label: "primary" }]) },
];

async function connect(caller: Agent) {
  const d1 = fakeD1({ documents: DOCS, namespaces: NAMESPACES });
  const server = buildServer(fakeEnv({ DB: d1.db, APP_KV: fakeKv({ seedToken: true }).kv }), caller);
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
  return { id: "agent_0123456789ab", name: `${namespace}-driver`, kind: "driver", actor: `agent:${namespace}-driver`, scopes, admin: false, row: null };
}

// ---- finding 6: resources and prompts ---------------------------------------------

test("PLANT: a driver cannot READ another namespace's document by resource URI", async () => {
  // The whole finding in one call. The `read` tool refused this; the resource handler
  // was not wrapped by anything and answered.
  const { client, close } = await connect(driver());
  await assert.rejects(
    () => client.readResource({ uri: "capsid://foxhound/core.md" }),
    /not scoped to the 'foxhound' namespace/,
    "a one-namespace driver read another namespace's document by URI"
  );
  await close();
});

test("THE INNOCENT DIRECTION: the same driver reads its OWN namespace by URI", async () => {
  const { client, close } = await connect(driver());
  const result = (await client.readResource({ uri: "capsid://capsid/core.md" })) as { contents: Array<{ text: string }> };
  await close();
  assert.equal(result.contents[0].text, "ours", "the driver was refused its own namespace, so the plant above proves nothing");
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
    "another namespace's documents were listed to a scoped caller"
  );
  assert.ok(uris.some((u) => u === "capsid://capsid/core.md"), "the caller's own documents went missing with the filter");
});

test("THE ADMIN STILL SEES EVERY NAMESPACE, so the filter is a scope and not a ceiling", async () => {
  const { client, close } = await connect(adminAgent("DrDustinEdwards"));
  const listed = (await client.listResources()) as { resources: Array<{ uri: string }> };
  await close();
  const uris = listed.resources.map((r) => r.uri);
  assert.ok(uris.includes("capsid://foxhound/core.md"), "the admin lost sight of a namespace it is scoped to");
});

test("PLANT: a driver cannot GET another namespace's prompt", async () => {
  // A prompt body reaches the client's model. Handing one across a namespace boundary
  // hands whoever last wrote that row a message in a session it is not scoped to.
  const { client, close } = await connect(driver());
  await assert.rejects(
    () => client.getPrompt({ name: "foxhound/prompts/theirs", arguments: { name: "x" } }),
    /not scoped to the 'foxhound' namespace/,
    "a one-namespace driver fetched another namespace's prompt"
  );
  await close();
});

test("THE INNOCENT DIRECTION: the same driver gets its OWN prompt", async () => {
  const { client, close } = await connect(driver());
  const result = (await client.getPrompt({ name: "capsid/prompts/ours", arguments: { name: "world" } })) as {
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
  assert.deepEqual(names.filter((n) => n.startsWith("foxhound/")), [], "another namespace's prompts were listed");
});

// ---- finding 7: the mapping is the boundary, so it is not handed out ----------------

test("PLANT: `namespaces` shows a scoped caller only its own row", async () => {
  // The tool takes no arguments, so namespaceRefusal had nothing to fire on and every
  // read-grant agent read the whole mapping. That mapping is what the repos axis is
  // built from and what resolveRepo resolves through.
  const { client, close } = await connect(driver());
  const result = (await client.callTool({ name: "namespaces", arguments: {} })) as { content: Array<{ text: string }> };
  await close();
  const rows = JSON.parse(result.content[0].text) as Array<{ namespace: string }>;
  assert.deepEqual(rows.map((r) => r.namespace), ["capsid"], "a one-namespace driver read the whole namespace-to-repo mapping");
});

test("THE ADMIN STILL SEES THE WHOLE MAPPING", async () => {
  const { client, close } = await connect(adminAgent("DrDustinEdwards"));
  const result = (await client.callTool({ name: "namespaces", arguments: {} })) as { content: Array<{ text: string }> };
  await close();
  const rows = JSON.parse(result.content[0].text) as Array<{ namespace: string }>;
  assert.deepEqual(rows.map((r) => r.namespace).sort(), ["capsid", "foxhound"]);
});

test("PLANT: improve_status hands a scoped caller NO credential inventory", async () => {
  // The other site of the same bug as `namespaces`, and the one that matters more:
  // `agents` names every minted credential, its namespaces, its grants and the
  // blast-radius flags it holds, which is the map an agent looking to widen itself
  // would want. It was attached even when the caller named one namespace.
  const { client, close } = await connect(driver());
  const result = (await client.callTool({ name: "improve_status", arguments: { namespace: "capsid" } })) as {
    content: Array<{ text: string }>;
  };
  await close();
  const body = JSON.parse(result.content[0].text) as { agents?: unknown[] };
  assert.equal(body.agents, undefined, "a scoped driver read the whole credential inventory");
});

test("THE ADMIN STILL GETS THE INVENTORY, which is who it is for", async () => {
  const { client, close } = await connect(adminAgent("DrDustinEdwards"));
  const result = (await client.callTool({ name: "improve_status", arguments: {} })) as { content: Array<{ text: string }> };
  await close();
  const body = JSON.parse(result.content[0].text) as { agents?: unknown[] };
  assert.ok(Array.isArray(body.agents), "the admin lost the inventory it is the audience for");
});

// ---- finding 5: jobs.list, and improve_run's control surface ------------------------

test("PLANT: an agent scoped to jobs.post is REFUSED action list", async () => {
  // list returned before ctx.scope, so it was the one action of this tool that reached
  // no check of its own. The registrar now passes the action, which is what makes the
  // qualified list mean something here.
  const caller = driver();
  caller.scopes.tools = ["jobs", "jobs.post"];
  const { client, close } = await connect(caller);
  const result = (await client.callTool({ name: "jobs", arguments: { action: "list", namespace: "capsid" } })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await close();
  assert.equal(result.isError, true, "a post-only agent listed the queue");
  assert.match(result.content[0].text, /not scoped to the 'jobs\.list' tool/, result.content[0].text);
});

test("THE INNOCENT DIRECTION: an agent scoped to jobs.list may list", async () => {
  const caller = driver();
  caller.scopes.tools = ["jobs", "jobs.list"];
  const { client, close } = await connect(caller);
  const result = (await client.callTool({ name: "jobs", arguments: { action: "list", namespace: "capsid" } })) as {
    content: Array<{ text: string }>;
  };
  await close();
  assert.doesNotMatch(result.content[0].text, /unauthorized:/, `a list-scoped agent was refused list: ${result.content[0].text}`);
});

test("PLANT: a WRITE-ONLY agent is refused jobs list, which is the grant half", async () => {
  // The registrar checks no grant for `jobs`, because TOOL_GRANTS calls it an "action"
  // tool: one tool with a read action and seven write ones, and only the handler knows
  // which this is. So the handler's own check is the ONLY thing standing here, and it
  // did not exist for list. The in-Worker watcher is exactly this shape: grants
  // ["write"] and nothing else (src/watcher.ts).
  //
  // Recorded because the first plant of this line did not redden anything: removing it
  // left the suite green, since the qualified-tools refusal above fires first for a
  // post-only caller. A caller that CLEARS the registrar is what proves this line.
  const caller = driver();
  caller.scopes.grants = ["write"];
  const { client, close } = await connect(caller);
  const result = (await client.callTool({ name: "jobs", arguments: { action: "list", namespace: "capsid" } })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await close();
  assert.equal(result.isError, true, "an agent with no read grant listed the queue");
  assert.match(result.content[0].text, /requires the read grant/, result.content[0].text);
});

test("PLANT: a driver is REFUSED improve_run action pause", async () => {
  // TOOL_GRANTS.improve_run is "write", which every driver holds, and nothing asked
  // again. pause stops a namespace, mode switches the whole loop off.
  const { client, close } = await connect(driver());
  const result = (await client.callTool({ name: "improve_run", arguments: { action: "pause", namespace: "capsid" } })) as {
    content: Array<{ text: string }>;
  };
  await close();
  assert.match(result.content[0].text, /admin only/, result.content[0].text);
});

test("PLANT: a driver is REFUSED improve_run action mode, which switches the whole loop off", async () => {
  const { client, close } = await connect(driver());
  // The namespace is passed because improve_run declares one and namespaceRefusal
  // fires first for a scoped caller that omits it. That refusal is real, and it is a
  // different guard; this plant is about the admin check behind it.
  const result = (await client.callTool({ name: "improve_run", arguments: { action: "mode", value: "off", namespace: "capsid" } })) as {
    content: Array<{ text: string }>;
  };
  await close();
  assert.match(result.content[0].text, /admin only/, result.content[0].text);
});

test("THE INNOCENT DIRECTION: a driver may still CLAIM its own lease", async () => {
  // The one control action that is a driver's own work, every run. Refusing it would
  // remove the only thing stopping two drivers working one namespace in subscription
  // mode, which creates no run row for the database index to catch.
  const { client, close } = await connect(driver());
  const result = (await client.callTool({ name: "improve_run", arguments: { action: "claim", namespace: "capsid" } })) as {
    content: Array<{ text: string }>;
  };
  await close();
  assert.doesNotMatch(result.content[0].text, /admin only/, `a driver was refused its own lease: ${result.content[0].text}`);
  assert.doesNotMatch(result.content[0].text, /unauthorized:/, result.content[0].text);
});

// ---- audit 2026-09-13, finding C2: lint gather is jobs.list's twin -----------------

test("PLANT: a WRITE-ONLY agent is refused lint gather, which is the grant half", async () => {
  // The exact shape of the jobs.list plant above, on the one branch that still had
  // nothing. lint is an "action" tool too, so the registrar names no grant and leaves
  // it to the handler; the handler checked the WRITE grant, and gather returns before
  // reaching that line. So gather asked for no grant at all.
  //
  // The caller CLEARS the registrar on purpose, for the reason recorded on the
  // jobs.list plant: a caller narrowed on the tools axis is refused there first, and
  // the plant would then stay green with this line deleted. Full tools axis, one
  // grant, and the grant is the wrong one.
  //
  // The in-Worker watcher is this shape: grants ["write"] and no read (src/watcher.ts).
  const caller = driver();
  caller.scopes.grants = ["write"];
  const { client, close } = await connect(caller);
  const result = (await client.callTool({ name: "lint", arguments: { namespace: "capsid" } })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await close();
  assert.equal(result.isError, true, "an agent with no read grant gathered the whole namespace");
  assert.match(result.content[0].text, /requires the read grant/, result.content[0].text);
});

test("THE INNOCENT DIRECTION: a read-grant agent may still gather", async () => {
  // gather is the read half of the loop and the driving client runs it every pass. A
  // guard that fires here gets deleted rather than fixed.
  const caller = driver();
  caller.scopes.grants = ["read"];
  const { client, close } = await connect(caller);
  const result = (await client.callTool({ name: "lint", arguments: { namespace: "capsid" } })) as {
    content: Array<{ text: string }>;
  };
  await close();
  assert.doesNotMatch(result.content[0].text, /unauthorized:/, `a read agent was refused gather: ${result.content[0].text}`);
});

test("THE OTHER INNOCENT DIRECTION: the write branches still take the write grant", async () => {
  // gather now names its own action, and report/finalize must not have been narrowed
  // by that: a read-only caller is still refused report, from the line below gather.
  const caller = driver();
  caller.scopes.grants = ["read"];
  const { client, close } = await connect(caller);
  const result = (await client.callTool({ name: "lint", arguments: { namespace: "capsid", mode: "report" } })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await close();
  assert.equal(result.isError, true, "a read-only agent ran lint report, which writes a document");
  assert.match(result.content[0].text, /requires the write grant/, result.content[0].text);
});

test("the in-Worker watcher is NOT the write-only caller that reaches gather", async () => {
  // The audit named the watcher as the live instance of the shape above. It is not:
  // its tools axis is ["jobs", "jobs.post"], so the registrar refuses it lint before
  // any grant is considered. The SHAPE is real and the plant above is the one that
  // proves the line; this asserts the named example is not an instance, so nobody
  // re-derives a severity from it.
  const { client, close } = await connect(watcherAgent());
  const result = (await client.callTool({ name: "lint", arguments: { namespace: "capsid" } })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await close();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not scoped to the 'lint' tool/, result.content[0].text);
});
