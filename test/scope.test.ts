import assert from "node:assert/strict";
import { test } from "node:test";
import { SCOPE_FLAGS, defaultScopes, type ScopeFlag } from "../src/agents-schema.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { adminAgent, legacyAgent, type Agent } from "../src/agents.ts";
import { AUTHORITATIVE } from "../src/counts.ts";
import { buildServer } from "../src/server.ts";
import { TOOL_GRANTS, actionArgFor, checkScope, isMoneyPath, repoWriteFlags, requiredGrant } from "../src/scope.ts";
import { fakeD1, fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// One enforcement point, and the refusal names what is missing.
//
// checkScope called directly, then two sweeps that call every served tool over a
// real MCP connection. test/blast-radius.test.ts proves each flag is refused at every
// path that needs it.

function scopedAgent(mutate: (scopes: ReturnType<typeof defaultScopes>) => void = () => {}): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  mutate(scopes);
  return { id: "agent_aaaaaaaaaaaa", name: "capsid-driver", kind: "driver", actor: "agent:capsid-driver", scopes, admin: false, row: null };
}

test("a caller inside every axis is not refused", () => {
  // The innocent case first: a guard that fires on correct calls gets deleted rather
  // than fixed.
  const agent = scopedAgent();
  assert.equal(checkScope(agent, { tool: "write", namespace: "capsid", grant: "write" }), null);
  assert.equal(checkScope(agent, { tool: "read", namespace: "capsid", grant: "read" }), null);
  assert.equal(checkScope(adminAgent("DrDustinEdwards"), { tool: "manage_pr", namespace: "foxhound", grant: "write", flags: SCOPE_FLAGS }), null);
});

test("the refusal names the axis that failed, and names the scope the caller actually has", () => {
  const agent = scopedAgent();
  const namespace = checkScope(agent, { tool: "write", namespace: "foxing", grant: "write" });
  assert.match(String(namespace), /not scoped to the 'foxing' namespace/);
  assert.match(String(namespace), /namespace scope is capsid/, "a refusal that does not say what the scope IS costs a round trip");

  const readOnly = scopedAgent((s) => {
    s.grants = ["read"];
  });
  assert.match(String(checkScope(readOnly, { tool: "write", namespace: "capsid", grant: "write" })), /requires the write grant/);

  const narrowTools = scopedAgent((s) => {
    s.tools = ["read", "search"];
  });
  assert.match(String(checkScope(narrowTools, { tool: "write", namespace: "capsid", grant: "write" })), /not scoped to the 'write' tool/);

  const narrowRepos = scopedAgent((s) => {
    s.repos = ["primary"];
  });
  assert.match(String(checkScope(narrowRepos, { tool: "read_repo_file", namespace: "capsid", repo: "legacy", grant: "read" })), /not scoped to the 'legacy' repo/);
});

test("a missing flag is refused by name, and the refusal says why the flag exists", () => {
  const agent = scopedAgent();
  for (const flag of SCOPE_FLAGS) {
    const refusal = checkScope(agent, { tool: "write_repo_file", namespace: "capsid", grant: "write", flags: [flag] });
    assert.match(String(refusal), new RegExp(`needs the ${flag} flag`), `${flag} was not refused by name`);
    assert.match(String(refusal), /because /, `the ${flag} refusal does not say why the flag exists`);
  }
});

test("the tool check comes before the namespace check, so a refusal does not leak which namespaces exist", () => {
  const agent = scopedAgent((s) => {
    s.tools = ["read"];
  });
  const refusal = checkScope(agent, { tool: "write", namespace: "a-namespace-this-caller-cannot-see", grant: "write" });
  assert.match(String(refusal), /not scoped to the 'write' tool/);
  assert.doesNotMatch(String(refusal), /a-namespace-this-caller-cannot-see/);
});

test("a caller with no scopes at all is refused everything, which is what the fail-closed parse relies on", () => {
  const empty: Agent = {
    id: "agent_000000000000",
    name: "corrupt",
    kind: "driver",
    actor: "agent:corrupt",
    scopes: { namespaces: [], repos: [], tools: [], grants: [], flags: Object.fromEntries(SCOPE_FLAGS.map((f) => [f, false])) as Record<ScopeFlag, boolean> },
    admin: false,
    row: null,
  };
  assert.match(String(checkScope(empty, { tool: "read", namespace: "capsid", grant: "read" })), /not scoped to the 'read' tool/);
  assert.match(String(checkScope(empty, { tool: "list" })), /not scoped to the 'list' tool/);
});

test("the legacy caller passes every check, which is the one thing this migration must not break", () => {
  const legacy = legacyAgent("write", "opkey:0123456789ab");
  for (const tool of Object.keys(TOOL_GRANTS)) {
    assert.equal(checkScope(legacy, { tool, namespace: "foxhound", repo: "legacy", grant: "write", flags: SCOPE_FLAGS }), null, `the legacy key was refused ${tool}`);
  }
});

test("requiredGrant fails closed for a tool nobody has classified", () => {
  assert.equal(requiredGrant("a_tool_nobody_classified"), "write");
  // And the lookup does not answer for Object.prototype keys.
  assert.equal(requiredGrant("constructor"), "write");
  assert.equal(requiredGrant("toString"), "write");
});

test("repoWriteFlags derives the flags from the CALL, not from the tool name", () => {
  assert.deepEqual(repoWriteFlags("write_repo_file", { path: "src/x.ts", mode: "pr" }), []);
  assert.deepEqual(repoWriteFlags("write_repo_file", { path: "src/x.ts", mode: "direct" }), ["can_direct_write"]);
  assert.deepEqual(repoWriteFlags("manage_pr", { action: "merge" }), ["can_merge"]);
  // close carries can_merge too: closing deletes the head branch, as merging does.
  assert.deepEqual(repoWriteFlags("manage_pr", { action: "close" }), ["can_merge"]);
  assert.deepEqual(repoWriteFlags("ci_dispatch", { path: "improve-score.yml" }), ["can_dispatch"]);
  assert.deepEqual(repoWriteFlags("write_repo_file", { path: ".github/workflows/ci.yml", mode: "pr", allow_workflow_write: true }), [
    "can_write_workflows",
    "can_touch_protected",
  ]);
  // The protected list is the improve loop's, not a second copy.
  assert.deepEqual(repoWriteFlags("write_repo_file", { path: "package.json", mode: "pr" }), ["can_touch_protected"]);
  assert.deepEqual(repoWriteFlags("write_repo_file", { path: "test/thing.test.ts", mode: "pr" }), ["can_touch_protected"]);
  assert.deepEqual(repoWriteFlags("write_repo_file", { path: "app/billing/charge.ts", mode: "pr" }), ["money_paths"]);
});

test("a money path is matched by name, and an innocent path is not", () => {
  for (const path of ["app/billing/charge.ts", "src/payments.ts", "lib/stripe-client.ts", "routes/checkout/index.tsx", "src/invoice-pdf.ts"]) {
    assert.ok(isMoneyPath(path), `${path} should trip the money-path tripwire`);
  }
  for (const path of ["src/server.ts", "app/routes/billboards.ts", "docs/repayment-history.md", "src/unsubscribe-token.ts"]) {
    assert.equal(isMoneyPath(path), false, `${path} is not a money path and a guard that fires on it gets deleted rather than fixed`);
  }
});

// The sweep: every served tool, called through a real MCP connection.
//
// The tool list comes from the server's own listTools, so a tool added later is in
// the sweep once registered. Arguments are built from each tool's served input
// schema, because the SDK validates arguments before the wrapped handler runs and
// would otherwise refuse the call itself.

interface JsonProp {
  type?: string;
  enum?: unknown[];
}
interface ServedTool {
  name: string;
  inputSchema: { properties?: Record<string, JsonProp>; required?: string[] };
}
interface SweepResult {
  text: string;
  isError: boolean;
  // What the call reached before it answered. A refusal from the registrar reaches
  // neither: the handler never ran.
  prepared: number;
  fetched: number;
}

function valueFor(name: string, prop: JsonProp): unknown {
  if (prop.enum && prop.enum.length > 0) return prop.enum[0];
  if (name === "namespace") return "capsid";
  if (prop.type === "integer" || prop.type === "number") return 1;
  if (prop.type === "boolean") return false;
  if (prop.type === "array") return [];
  if (prop.type === "object") return {};
  return "x";
}

// The required arguments, each given a value its schema accepts. `action` overrides
// the tool's action argument (see actionArgFor) when the sweep walks the actions.
function argsFor(tool: ServedTool, action?: string): Record<string, unknown> {
  const props = tool.inputSchema.properties ?? {};
  const args: Record<string, unknown> = {};
  for (const name of tool.inputSchema.required ?? []) args[name] = valueFor(name, props[name] ?? {});
  // Named on every tool that takes one, so the refusal is never the omitted-namespace
  // one and the call is about the tool, the grant or the action.
  if (Object.hasOwn(props, "namespace")) args.namespace = "capsid";
  const key = actionArgFor(tool.name);
  if (action !== undefined && key) args[key] = action;
  return args;
}

// The action values a tool's schema offers, or [undefined] for a tool with none.
function actionsOf(tool: ServedTool): Array<string | undefined> {
  const key = actionArgFor(tool.name);
  const values = key ? tool.inputSchema.properties?.[key]?.enum : undefined;
  return values && values.length > 0 ? values.map(String) : [undefined];
}

async function sweep(caller: Agent, calls: (tools: ServedTool[]) => Array<{ tool: string; args: Record<string, unknown> }>) {
  let prepared = 0;
  const d1 = fakeD1();
  const db = {
    prepare: (sql: string) => {
      prepared += 1;
      return d1.db.prepare(sql);
    },
    batch: (statements: unknown[]) => d1.db.batch(statements as never),
  };
  const server = buildServer(fakeEnv({ DB: db, APP_KV: fakeKv({ seedToken: true }).kv }), caller);
  const client = new Client({ name: "scope-sweep", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const results = new Map<string, SweepResult>();
  let served: ServedTool[] = [];
  try {
    served = (await client.listTools()).tools as ServedTool[];
    for (const { tool, args } of calls(served)) {
      await withFetch({}, async (fetches) => {
        const before = prepared;
        const result = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
        const key = actionArgFor(tool);
        const label = key && typeof args[key] === "string" ? `${tool}.${args[key]}` : tool;
        results.set(label, { text: result.content[0]?.text ?? "", isError: result.isError === true, prepared: prepared - before, fetched: fetches.length });
      });
    }
  } finally {
    await client.close();
    await server.close();
  }
  return { served, results };
}

// A caller that holds every grant, every namespace and every repo, and no tools.
function noToolsAgent(): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.namespaces = "*";
  scopes.grants = ["read", "write"];
  scopes.tools = [];
  for (const flag of SCOPE_FLAGS) scopes.flags[flag] = true;
  return { id: "agent_bbbbbbbbbbbb", name: "no-tools", kind: "driver", actor: "agent:no-tools", scopes, admin: true, row: null };
}

// A tool registered before the guard, or around it, answers here.
test("SWEEP: every served tool refuses a caller whose tools axis is empty, by name, before its handler runs", async () => {
  const { served, results } = await sweep(noToolsAgent(), (tools) => tools.map((tool) => ({ tool: tool.name, args: argsFor(tool) })));
  // Not vacuous: the sweep called every served tool, and that is the pinned surface.
  assert.equal(served.length, AUTHORITATIVE.capsid.tools, "listTools did not return the pinned surface");
  assert.equal(results.size, AUTHORITATIVE.capsid.tools, "the sweep did not call every tool");
  for (const tool of served) {
    const key = [...results.keys()].find((label) => label === tool.name || label.startsWith(`${tool.name}.`));
    assert.ok(key, `${tool.name} was not called`);
    const result = results.get(key)!;
    assert.equal(result.isError, true, `${tool.name} answered a caller with no tools: ${result.text}`);
    assert.match(result.text, new RegExp(`not scoped to the '${tool.name}(\\.[a-z_]+)?' tool`), `${tool.name} was not refused by name: ${result.text}`);
    assert.equal(result.prepared, 0, `${tool.name} reached D1 before refusing, so its handler ran`);
    assert.equal(result.fetched, 0, `${tool.name} reached the network before refusing, so its handler ran`);
  }
});

// The read actions of the two tools whose handler decides the grant per action (see
// TOOL_GRANTS "action"). Every other action is expected to refuse a read-only caller,
// so an action added to either tool is expected to refuse until it is listed here.
const READ_ACTIONS: Record<string, string[]> = { jobs: ["list"], lint: ["gather"] };

function isReadCall(tool: string, action: string | undefined): boolean {
  if (TOOL_GRANTS[tool] === "read") return true;
  return action !== undefined && Object.hasOwn(READ_ACTIONS, tool) && READ_ACTIONS[tool].includes(action);
}

// A handler that decides a grant for itself is observable only where it disagrees
// with checkScope, and it can only disagree by refusing, because the registrar runs
// first. The write half proves every write refuses with checkScope's own sentence and
// touches nothing; the read half proves no read is refused, which a private gate on a
// read tool would do.
test("SWEEP: a read-only caller is refused every write by checkScope, and no read", async () => {
  const readOnly = legacyAgent("read", "opkey:readonly0000");
  const { served, results } = await sweep(readOnly, (tools) =>
    tools.flatMap((tool) => actionsOf(tool).map((action) => ({ tool: tool.name, args: argsFor(tool, action) })))
  );
  assert.equal(served.length, AUTHORITATIVE.capsid.tools, "listTools did not return the pinned surface");
  let writes = 0;
  let reads = 0;
  for (const tool of served) {
    for (const action of actionsOf(tool)) {
      const label = action === undefined ? tool.name : `${tool.name}.${action}`;
      const result = results.get(label);
      assert.ok(result, `${label} was not called`);
      if (isReadCall(tool.name, action)) {
        reads += 1;
        assert.doesNotMatch(result.text, /unauthorized|denied|requires the write grant/i, `${label} is a read and refused a read-only caller: ${result.text}`);
        // The handler ran. Its answer may be an error (empty store, no GitHub
        // routes), but it reached the store to give it.
        assert.ok(result.prepared + result.fetched > 0, `${label} never reached its handler, so this asserts nothing about it: ${result.text}`);
      } else {
        writes += 1;
        assert.equal(result.isError, true, `${label} answered a read-only caller: ${result.text}`);
        assert.match(result.text, new RegExp(`'${tool.name}' requires the write grant`), `${label} was not refused by checkScope: ${result.text}`);
        assert.equal(result.prepared, 0, `${label} reached D1 before refusing`);
        assert.equal(result.fetched, 0, `${label} reached the network before refusing`);
      }
    }
  }
  // Not vacuous in either direction: every write tool has at least one write call,
  // and every read tool one read call.
  const writeTools = Object.values(TOOL_GRANTS).filter((r) => r !== "read").length;
  const readTools = Object.values(TOOL_GRANTS).filter((r) => r === "read").length;
  assert.ok(writes >= writeTools, `only ${writes} write calls for ${writeTools} write tools`);
  assert.ok(reads >= readTools, `only ${reads} read calls for ${readTools} read tools`);
});
