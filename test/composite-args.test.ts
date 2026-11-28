import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import { defaultScopes } from "../src/agents-schema.ts";
import { actionArgFor, defaultActionFor } from "../src/scope-guard.ts";
import { buildAdminServer, buildServer } from "../src/server.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// An action taking fewer arguments than its operation declares refuses one it does not take rather than dropping it: a comment dropped from a merge is a review nobody posted.
// An argument no action takes is refused by the tool's closed schema; one another action takes is refused by the handler, naming what this action takes.

async function call(name: string, args: Record<string, unknown>) {
  const server = buildServer(
    fakeEnv({ APP_KV: fakeKv({}).kv }),
    adminAgentForEmail("admin@example.com"),
  );
  const client = new Client({ name: "composite-args", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  try {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return {
      text: result.content.map((c) => c.text).join("\n"),
      isError: result.isError === true,
      fetches,
    };
  } finally {
    globalThis.fetch = original;
    await client.close();
  }
}

test("PLANT: an argument the action does not take is refused, and nothing reaches GitHub", async () => {
  for (const [extra, refusal] of [
    [{ action: "merge", comment: "LGTM" }, /Unrecognized key: "comment"/],
    [{ action: "close", sha: "a".repeat(40) }, /capsid_close_pr action 'close' does not take sha/],
  ] as const) {
    const r = await call("capsid_close_pr", { namespace: "sample", number: 7, ...extra });
    assert.equal(r.isError, true);
    assert.match(r.text, refusal);
    assert.equal(r.fetches, 0);
  }
});

test("THE INNOCENT DIRECTION: the arguments an action takes go through to its operation", async () => {
  const r = await call("capsid_close_pr", {
    action: "merge",
    namespace: "sample",
    number: 7,
    merge_method: "squash",
  });
  assert.doesNotMatch(r.text, /does not take/);
});

test("PLANT: two actions that share an argument name with different values each accept their own", async () => {
  // search's report is performance | inspect | sitemaps; bing's adds queries, traffic and more.
  // The tool's schema once kept only the first action's, so bing's own reports were refused.
  const bing = await call("capsid_inspect_repo", {
    action: "bing",
    namespace: "sample",
    report: "traffic",
  });
  assert.doesNotMatch(bing.text, /Invalid option|Input validation error/);
  const wrong = await call("capsid_inspect_repo", {
    action: "search",
    namespace: "sample",
    report: "traffic",
  });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /report/);
  assert.equal(wrong.fetches, 0);
});

test("DERIVED: every action tool whose action argument is optional has a table default", async () => {
  // Otherwise the registrar passes no action and a narrowed caller is refused the tool's own default.
  const tools = [];
  for (const build of [buildServer, buildAdminServer]) {
    const server = build(fakeEnv({}), adminAgentForEmail("admin@example.com"));
    const client = new Client({ name: "composite-args", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    tools.push(...(await client.listTools()).tools);
    await client.close();
  }
  const missing = tools
    .filter((t) => actionArgFor(t.name) !== undefined)
    .filter((t) => {
      const required = (t.inputSchema.required ?? []) as string[];
      return !required.includes(actionArgFor(t.name)!) && defaultActionFor(t.name) === undefined;
    })
    .map((t) => t.name);
  assert.deepEqual(missing, []);
});

test("PLANT: an agent scoped to capsid_lint_namespace.gather may call it with no mode at all", async () => {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  scopes.tools = ["capsid_lint_namespace", "capsid_lint_namespace.gather"];
  const caller: Agent = {
    id: "agent_narrow01",
    name: "narrow",
    kind: "session",
    actor: "agent:narrow",
    scopes,
    admin: false,
    row: null,
  };
  const { db } = fakeD1({
    documents: [
      { namespace: "capsid", path: "core.md", title: "core", body: "the core", type: "core" },
    ],
    namespaces: [{ namespace: "capsid", repos: "[]" }],
  });
  const server = buildServer(fakeEnv({ DB: db, APP_KV: fakeKv({}).kv }), caller);
  const client = new Client({ name: "composite-args", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = (await client.callTool({
    name: "capsid_lint_namespace",
    arguments: { namespace: "capsid" },
  })) as { isError?: boolean; content: Array<{ text: string }> };
  await client.close();
  assert.notEqual(result.isError, true, result.content[0].text);
  const packet = JSON.parse(result.content[0].text) as {
    mode: string;
    core: { body?: string } | null;
  };
  assert.equal(packet.mode, "gather");
  assert.equal(packet.core?.body, "the core");
});
