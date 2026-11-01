import assert from "node:assert/strict";
import { test } from "node:test";
import { SCOPE_FLAGS, defaultScopes, type ScopeFlag } from "../src/agents-schema.ts";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { adminAgentForEmail, legacyAgent, type Agent } from "../src/agents.ts";
import { AUTHORITATIVE } from "../src/counts.ts";
import { buildAdminServer, buildServer } from "../src/server.ts";
import { CAPSID_ADMIN_TOOLS, CAPSID_TOOLS } from "../src/tools/surface.ts";
import { TOOL_GRANTS, TOOL_ACTION_GRANTS, actionArgFor, checkScope, isMoneyPath, repoWriteFlags, requiredForAction, requiredGrant, toolListed } from "../src/scope.ts";
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
  assert.equal(checkScope(agent, { tool: "capsid_write_doc", action: "write", namespace: "capsid", grant: "write" }), null);
  assert.equal(checkScope(agent, { tool: "capsid_read_doc", action: "read", namespace: "capsid", grant: "read" }), null);
  assert.equal(checkScope(adminAgentForEmail("admin@example.com"), { tool: "capsid_close_pr", action: "merge", namespace: "sample", grant: "write", flags: SCOPE_FLAGS }), null);
});

test("the refusal names the axis that failed, and names the scope the caller actually has", () => {
  const agent = scopedAgent();
  const namespace = checkScope(agent, { tool: "capsid_write_doc", namespace: "sample", grant: "write" });
  assert.match(String(namespace), /not scoped to the 'sample' namespace/);
  assert.match(String(namespace), /namespace scope is capsid/, "a refusal that does not say what the scope IS costs a round trip");

  const readOnly = scopedAgent((s) => {
    s.grants = ["read"];
  });
  assert.match(String(checkScope(readOnly, { tool: "capsid_write_doc", namespace: "capsid", grant: "write" })), /requires the write grant/);

  const narrowTools = scopedAgent((s) => {
    s.tools = ["capsid_read_doc", "capsid_find_docs"];
  });
  assert.match(String(checkScope(narrowTools, { tool: "capsid_write_doc", namespace: "capsid", grant: "write" })), /not scoped to the 'capsid_write_doc' tool/);

  const narrowRepos = scopedAgent((s) => {
    s.repos = ["primary"];
  });
  assert.match(String(checkScope(narrowRepos, { tool: "capsid_read_repo", action: "files", namespace: "capsid", repo: "legacy", grant: "read" })), /not scoped to the 'legacy' repo/);
});

test("a missing flag is refused by name, and the refusal says why the flag exists", () => {
  const agent = scopedAgent();
  for (const flag of SCOPE_FLAGS) {
    const refusal = checkScope(agent, { tool: "capsid_close_pr", action: "merge", namespace: "capsid", grant: "write", flags: [flag] });
    assert.match(String(refusal), new RegExp(`needs the ${flag} flag`), `${flag} was not refused by name`);
    assert.match(String(refusal), /because /, `the ${flag} refusal does not say why the flag exists`);
  }
});

test("the tool check comes before the namespace check, so a refusal does not leak which namespaces exist", () => {
  const agent = scopedAgent((s) => {
    s.tools = ["capsid_read_doc"];
  });
  const refusal = checkScope(agent, { tool: "capsid_write_doc", namespace: "a-namespace-this-caller-cannot-see", grant: "write" });
  assert.match(String(refusal), /not scoped to the 'capsid_write_doc' tool/);
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
  assert.match(String(checkScope(empty, { tool: "capsid_read_doc", namespace: "capsid", grant: "read" })), /not scoped to the 'capsid_read_doc' tool/);
  assert.match(String(checkScope(empty, { tool: "capsid_find_docs" })), /not scoped to the 'capsid_find_docs' tool/);
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

test("repoWriteFlags derives the flags from the CALL, not from the tool name alone", () => {
  assert.deepEqual(repoWriteFlags("capsid_close_pr", "merge", {}), ["can_merge"]);
  // close carries can_merge too: closing deletes the head branch, as merging does.
  assert.deepEqual(repoWriteFlags("capsid_close_pr", "close", {}), ["can_merge"]);
  // A tag or a release can start a deploy as a merge can.
  assert.deepEqual(repoWriteFlags("capsid_close_pr", "tag", {}), ["can_merge"]);
  assert.deepEqual(repoWriteFlags("capsid_close_pr", "release", {}), ["can_merge"]);
  // A branch delete needs can_merge only when forced past an open pull request.
  assert.deepEqual(repoWriteFlags("capsid_close_pr", "delete_branch", {}), []);
  assert.deepEqual(repoWriteFlags("capsid_close_pr", "delete_branch", { force: true }), ["can_merge"]);
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
  // KV reads: an operation that keeps its state in KV (the watcher's snapshot) reaches
  // the store there, not in D1.
  kvReads: number;
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
  if (action !== undefined && Object.hasOwn(ACTION_ARGS, `${tool.name}.${action}`)) Object.assign(args, ACTION_ARGS[`${tool.name}.${action}`]);
  return args;
}

// Arguments an action needs that no schema marks required, because its handler checks
// them itself. Without one the handler answers before it reaches the store, and the
// read half below would assert nothing about that action.
const ACTION_ARGS: Record<string, Record<string, unknown>> = {
  "capsid_admin_read_claims.job": { id: "x" },
  "capsid_admin_read_claims.export": { table: "job_claims" },
  "capsid_admin_read_ops.build_logs": { build_uuid: "00000000-0000-4000-8000-000000000000" },
};

// The action values a tool's schema offers, or [undefined] for a tool with none.
function actionsOf(tool: ServedTool): Array<string | undefined> {
  const key = actionArgFor(tool.name);
  const values = key ? tool.inputSchema.properties?.[key]?.enum : undefined;
  return values && values.length > 0 ? values.map(String) : [undefined];
}

type Surface = "capsid" | "admin";

// Both servers: Capsid (buildServer) and Capsid Admin (buildAdminServer). A sweep of one
// would let a tool registered on the other around the guard pass unseen.
const SURFACES: Record<Surface, { build: typeof buildServer; tools: readonly string[] }> = {
  capsid: { build: buildServer, tools: CAPSID_TOOLS },
  admin: { build: buildAdminServer, tools: CAPSID_ADMIN_TOOLS },
};

async function sweep(caller: Agent, surface: Surface, calls: (tools: ServedTool[]) => Array<{ tool: string; args: Record<string, unknown> }>) {
  let prepared = 0;
  const d1 = fakeD1();
  const db = {
    prepare: (sql: string) => {
      prepared += 1;
      return d1.db.prepare(sql);
    },
    batch: (statements: unknown[]) => d1.db.batch(statements as never),
  };
  let kvReads = 0;
  const kv = fakeKv({ seedToken: true }).kv as unknown as Record<string, (...a: unknown[]) => unknown>;
  const countedKv = {
    ...kv,
    get: (...a: unknown[]) => {
      kvReads += 1;
      return kv.get(...a);
    },
    list: (...a: unknown[]) => {
      kvReads += 1;
      return kv.list(...a);
    },
  } as unknown as KVNamespace;
  // Fake Cloudflare credentials, so capsid_admin_read_ops's Cloudflare actions reach the
  // (faked) network rather than stopping at a missing setting.
  const server = SURFACES[surface].build(fakeEnv({ DB: db, APP_KV: countedKv, CF_OPS_TOKEN: "sample-token", CF_ACCOUNT_ID: "sample-account" }), caller);
  const client = new Client({ name: "scope-sweep", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const results = new Map<string, SweepResult>();
  let served: ServedTool[] = [];
  try {
    served = (await client.listTools()).tools as ServedTool[];
    for (const { tool, args } of calls(served)) {
      const key = actionArgFor(tool);
      const label = key && typeof args[key] === "string" ? `${tool}.${args[key]}` : tool;
      const props = served.find((t) => t.name === tool)?.inputSchema.properties ?? {};
      // A composite tool's schema marks optional what only some of its actions need, so
      // an action's own required argument can be missing from argsFor. The operation
      // names it in its refusal, which comes after the registrar admitted the call; fill
      // it and call again, so the result recorded is the handler's, not a parse error.
      // The registrar's refusal is never retried: it names no missing argument.
      for (let attempt = 0; ; attempt += 1) {
        let missing: string[] = [];
        await withFetch({}, async (fetches) => {
          const before = prepared;
          const kvBefore = kvReads;
          // A tool the caller's grant can never call is not served to it (src/scope.ts
          // toolListed), so the protocol refuses the call; that refusal is recorded as the result.
          const result = (await client
            .callTool({ name: tool, arguments: args })
            .catch((error: unknown) => ({ isError: true, content: [{ text: `protocol: ${error instanceof Error ? error.message : String(error)}` }] }))) as { isError?: boolean; content: Array<{ text?: string }> };
          const text = result.content[0]?.text ?? "";
          results.set(label, { text, isError: result.isError === true, prepared: prepared - before, fetched: fetches.length, kvReads: kvReads - kvBefore });
          const parse = /^invalid arguments for [^:]+: (.*)$/s.exec(text);
          if (!parse) return;
          missing = parse[1]
            .split("; ")
            .filter((issue) => /received undefined/.test(issue))
            .map((issue) => issue.slice(0, issue.indexOf(":")))
            .filter((name) => Object.hasOwn(props, name) && !Object.hasOwn(args, name));
        });
        if (missing.length === 0 || attempt >= 3) break;
        for (const name of missing) args[name] = valueFor(name, props[name]);
      }
    }
  } finally {
    await client.close();
    await server.close();
  }
  return { served, results };
}

// Each server serves exactly its own list, and the two lists are TOOL_GRANTS between them.
function assertServedAll(surface: Surface, served: ServedTool[]) {
  assert.deepEqual(
    served.map((t) => t.name).sort(),
    [...SURFACES[surface].tools].sort(),
    `${surface}: listTools did not return the server's whole surface`
  );
}

test("the two servers' surfaces are every tool in TOOL_GRANTS, so a sweep of both sweeps all of them", () => {
  const both = [...CAPSID_TOOLS, ...CAPSID_ADMIN_TOOLS];
  assert.equal(new Set(both).size, both.length, "a tool is on both servers");
  assert.deepEqual([...both].sort(), Object.keys(TOOL_GRANTS).sort());
  assert.equal(both.length, AUTHORITATIVE.capsid.tools);
});

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
test("SWEEP: every served tool on both servers refuses a caller whose tools axis is empty, by name, before its handler runs", async () => {
  let called = 0;
  for (const surface of Object.keys(SURFACES) as Surface[]) {
    const { served, results } = await sweep(noToolsAgent(), surface, (tools) => tools.map((tool) => ({ tool: tool.name, args: argsFor(tool) })));
    // Not vacuous: the sweep called every tool this server serves.
    assertServedAll(surface, served);
    assert.equal(results.size, served.length, `${surface}: the sweep did not call every tool`);
    called += results.size;
    for (const tool of served) {
      const key = [...results.keys()].find((label) => label === tool.name || label.startsWith(`${tool.name}.`));
      assert.ok(key, `${tool.name} was not called`);
      const result = results.get(key)!;
      assert.equal(result.isError, true, `${tool.name} answered a caller with no tools: ${result.text}`);
      assert.match(result.text, new RegExp(`not scoped to the '${tool.name}(\\.[a-z_]+)?' tool`), `${tool.name} was not refused by name: ${result.text}`);
      assert.equal(result.prepared, 0, `${tool.name} reached D1 before refusing, so its handler ran`);
      assert.equal(result.fetched, 0, `${tool.name} reached the network before refusing, so its handler ran`);
      assert.equal(result.kvReads, 0, `${tool.name} reached KV before refusing, so its handler ran`);
    }
  }
  assert.equal(called, AUTHORITATIVE.capsid.tools, "the sweep did not call every tool in TOOL_GRANTS");
});

// The read actions of the two tools whose handler decides the grant per action (see
// TOOL_GRANTS "action", outside TOOL_ACTION_GRANTS). Every other action is expected to
// refuse a read-only caller, so an action added to either tool is expected to refuse
// until it is listed here.
const READ_ACTIONS: Record<string, string[]> = { capsid_work_jobs: ["list"], capsid_lint_namespace: ["gather"] };

// A read is a "read" or "admin_read" requirement for this action (TOOL_ACTION_GRANTS
// decides capsid_run_improve's per action), or a READ_ACTIONS entry.
function isReadCall(tool: string, action: string | undefined): boolean {
  const requirement = requiredForAction(tool, action);
  if (requirement === "read" || requirement === "admin_read") return true;
  return action !== undefined && Object.hasOwn(READ_ACTIONS, tool) && READ_ACTIONS[tool].includes(action);
}

// The read-only caller each server is for. On Capsid, a read key. On Capsid Admin, the
// admin identity holding only the read grant: a non-admin is refused there as not the
// admin before any grant question arises, which would prove nothing about the grant.
function readOnlyCaller(surface: Surface): Agent {
  const reader = legacyAgent("read", "opkey:readonly0000");
  return surface === "admin" ? { ...reader, admin: true } : reader;
}

// A handler that decides a grant for itself is observable only where it disagrees
// with checkScope, and it can only disagree by refusing, because the registrar runs
// first. The write half proves every write refuses with checkScope's own sentence and
// touches nothing; the read half proves no read is refused, which a private gate on a
// read tool would do.
test("SWEEP: a read-only caller is refused every write by checkScope on both servers, and no read", async () => {
  let writes = 0;
  let reads = 0;
  const writeTools = new Set<string>();
  const readTools = new Set<string>();
  for (const surface of Object.keys(SURFACES) as Surface[]) {
    const caller = readOnlyCaller(surface);
    const unserved = SURFACES[surface].tools.filter((tool) => !toolListed(caller, tool));
    const { served, results } = await sweep(caller, surface, (tools) => [
      ...tools.flatMap((tool) => actionsOf(tool).map((action) => ({ tool: tool.name, args: argsFor(tool, action) }))),
      ...unserved.map((tool) => ({ tool, args: {} as Record<string, unknown> })),
    ]);
    // A read grant is served every tool but those that need write in whole (area 11, T7).
    assert.deepEqual(served.map((t) => t.name).sort(), SURFACES[surface].tools.filter((tool) => !unserved.includes(tool)).sort());
    for (const tool of unserved) {
      const result = results.get(tool);
      assert.ok(result, `${tool} was not called`);
      writes += 1;
      writeTools.add(tool);
      assert.match(result.text, /not found/i, `${tool} answered a read-only caller: ${result.text}`);
      assert.equal(result.prepared + result.fetched + result.kvReads, 0, `${tool} reached a store or the network before refusing`);
    }
    for (const tool of served) {
      for (const action of actionsOf(tool)) {
        const label = action === undefined ? tool.name : `${tool.name}.${action}`;
        const result = results.get(label);
        assert.ok(result, `${label} was not called`);
        if (isReadCall(tool.name, action)) {
          reads += 1;
          readTools.add(tool.name);
          assert.doesNotMatch(result.text, /unauthorized|denied|requires the write grant/i, `${label} is a read and refused a read-only caller: ${result.text}`);
          // The handler ran. Its answer may be an error (empty store, no GitHub
          // routes), but it reached the store to give it.
          assert.ok(result.prepared + result.fetched + result.kvReads > 0, `${label} never reached its handler, so this asserts nothing about it: ${result.text}`);
        } else {
          writes += 1;
          writeTools.add(tool.name);
          assert.equal(result.isError, true, `${label} answered a read-only caller: ${result.text}`);
          assert.match(result.text, new RegExp(`'${tool.name}' requires the write grant`), `${label} was not refused by checkScope: ${result.text}`);
          assert.equal(result.prepared, 0, `${label} reached D1 before refusing`);
          assert.equal(result.fetched, 0, `${label} reached the network before refusing`);
          assert.equal(result.kvReads, 0, `${label} reached KV before refusing`);
        }
      }
    }
  }
  // Not vacuous in either direction: every tool that is not wholly a read has at least
  // one write call, and every tool that is wholly a read one read call.
  const wholeRead = (r: string) => r === "read" || r === "admin_read";
  for (const [tool, r] of Object.entries(TOOL_GRANTS)) {
    if (!wholeRead(r)) assert.ok(writeTools.has(tool), `${tool} needs more than read and had no write call`);
    if (wholeRead(r)) assert.ok(readTools.has(tool), `${tool} is a read tool and had no read call`);
  }
  // The per-action table is swept too: each of its read actions was called as a read.
  for (const [tool, spec] of Object.entries(TOOL_ACTION_GRANTS)) {
    for (const [action, r] of Object.entries(spec.actions)) {
      if (r === "read") assert.ok(isReadCall(tool, action) && readTools.has(tool), `${tool}.${action} is a read and was not swept as one`);
    }
  }
  assert.ok(writes >= writeTools.size && reads >= readTools.size);
});
