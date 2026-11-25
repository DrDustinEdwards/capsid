import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildAdminServer, buildServer } from "../src/server.ts";
import { CAPSID_ADMIN_TOOLS, CAPSID_TOOLS } from "../src/tools/surface.ts";
import { defaultScopes, allowsToolAction } from "../src/agents-schema.ts";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import { actionArgFor } from "../src/scope-guard.ts";
import { fakeD1, fakeEnv, fakeKv, withFetch } from "./fakes.ts";

async function listedTools() {
  const tools = [];
  for (const build of [buildServer, buildAdminServer]) {
    const server = build(
      fakeEnv({ APP_KV: fakeKv({}).kv }),
      adminAgentForEmail("admin@example.com"),
    );
    const client = new Client({ name: "tools-axis-list", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    tools.push(...(await client.listTools()).tools);
    await client.close();
    await server.close();
  }
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [...CAPSID_TOOLS, ...CAPSID_ADMIN_TOOLS].sort(),
    "the two servers did not list their whole surface",
  );
  return tools;
}

// A qualifier such as `capsid_close_pr.delete_branch` applies only if the call path passes the action to the scope check;
// test/roles.test.ts sets the action itself, so every plant here goes through a real MCP client.

const REPOS = [{ repo: "o/r", label: "primary" }];

function env(repos = REPOS) {
  return fakeEnv({
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => ({ repos: JSON.stringify(repos) }) }) }),
    },
    APP_KV: fakeKv({ seedToken: true }).kv,
  });
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function callAs(
  caller: Agent,
  tool: string,
  args: Record<string, unknown>,
  repos = REPOS,
  serverEnv: ReturnType<typeof env> = env(repos),
): Promise<ToolResult> {
  const server = buildServer(serverEnv, caller);
  const client = new Client({ name: "tools-axis", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
  await client.close();
  await server.close();
  return result;
}

// GitHub routes for closing pull request 7, so an innocent-direction call can be asserted to SUCCEED; with none the call fails on GitHub's side and passes a check for a missing refusal.
function closeRoutes(full: string) {
  return {
    [`PATCH /repos/${full}/pulls/7`]: {
      body: { number: 7, state: "closed", html_url: "https://pr" },
    },
  };
}

function succeeded(result: ToolResult): Record<string, unknown> {
  const text = result.content[0]?.text ?? "";
  assert.notEqual(result.isError, true, `the call failed: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function brancher(): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  scopes.tools = ["capsid_close_pr", "capsid_close_pr.delete_branch"];
  return {
    id: "agent_brancher01",
    name: "brancher",
    kind: "session",
    actor: "agent:brancher",
    scopes,
    admin: false,
    row: null,
  };
}

for (const action of ["close", "merge"]) {
  test(`PLANT: an agent scoped to capsid_close_pr.delete_branch is REFUSED the same tool's action ${action}`, async () => {
    // The narrowing within one tool. close and merge also carry can_merge; this asserts the axis
    // refusal because checkScope names the tool before it names a missing flag.
    await withFetch({}, async (calls) => {
      const result = await callAs(brancher(), "capsid_close_pr", {
        namespace: "capsid",
        number: 7,
        action,
      });
      assert.equal(result.isError, true, `a delete_branch-only agent ran ${action}`);
      assert.match(
        result.content[0].text,
        new RegExp(`not scoped to the 'capsid_close_pr\\.${action}' tool`),
        result.content[0].text,
      );
      assert.equal(
        calls.length,
        0,
        "the call reached GitHub before refusing, so the refusal describes something that already happened",
      );
    });
  });
}

test("THE INNOCENT DIRECTION: the agent IS allowed action delete_branch", async () => {
  // Without this, a capsid_close_pr broken for everybody passes the plants above.
  await withFetch({}, async (calls) => {
    const result = await callAs(brancher(), "capsid_close_pr", {
      namespace: "capsid",
      action: "delete_branch",
      branch: "feature/mine",
    });
    const text = result.content[0]?.text ?? "";
    assert.doesNotMatch(text, /unauthorized:/, `the agent was refused its own action: ${text}`);
    assert.ok(
      calls.length > 0,
      "the call never reached GitHub, so this asserts nothing about the axis",
    );
  });
});

test("PLANT: an agent scoped to capsid_lint_namespace.gather is REFUSED mode finalize", async () => {
  // capsid_lint_namespace spells its action `mode`: gather is a read and finalize archives documents.
  const caller = brancher();
  caller.scopes.tools = ["capsid_lint_namespace", "capsid_lint_namespace.gather"];
  const result = await callAs(caller, "capsid_lint_namespace", {
    namespace: "capsid",
    mode: "finalize",
  });
  assert.equal(result.isError, true, "a gather-only caller ran finalize");
  assert.match(
    result.content[0].text,
    /not scoped to the 'capsid_lint_namespace\.finalize' tool/,
    result.content[0].text,
  );
});

test("THE INNOCENT DIRECTION: the same caller IS allowed mode gather", async () => {
  const caller = brancher();
  caller.scopes.tools = ["capsid_lint_namespace", "capsid_lint_namespace.gather"];
  const d1 = fakeD1({
    documents: [
      { namespace: "capsid", path: "core.md", title: "core", body: "the core", type: "core" },
    ],
  });
  const result = await callAs(
    caller,
    "capsid_lint_namespace",
    { namespace: "capsid", mode: "gather" },
    REPOS,
    fakeEnv({ DB: d1.db, APP_KV: fakeKv({}).kv }),
  );
  const text = result.content[0]?.text ?? "";
  assert.doesNotMatch(text, /not scoped to/, `the gather-only caller was refused gather: ${text}`);
  const out = succeeded(result) as { core?: { body?: string } };
  assert.equal(out.core?.body, "the core", "gather did not return the namespace's core document");
});

test("AN UNKNOWN ACTION ON A NARROWED TOOL IS REFUSED, rather than read as the whole tool", () => {
  // Fail closed: a call path that forgets to pass the action is refused.
  assert.equal(
    allowsToolAction(
      ["capsid_close_pr", "capsid_close_pr.delete_branch"],
      "capsid_close_pr",
      undefined,
    ),
    false,
  );
  assert.equal(
    allowsToolAction(
      ["capsid_close_pr", "capsid_close_pr.delete_branch"],
      "capsid_close_pr",
      "delete_branch",
    ),
    true,
  );
  assert.equal(
    allowsToolAction(
      ["capsid_close_pr", "capsid_close_pr.delete_branch"],
      "capsid_close_pr",
      "merge",
    ),
    false,
  );
  assert.equal(allowsToolAction(["capsid_inspect_repo"], "capsid_inspect_repo", undefined), true);
  assert.equal(allowsToolAction(["capsid_inspect_repo"], "capsid_inspect_repo", "ci"), true);
  assert.equal(
    allowsToolAction(
      ["capsid_close_pr", "capsid_close_pr.delete_branch", "capsid_lint_namespace"],
      "capsid_lint_namespace",
      "finalize",
    ),
    true,
  );
});

test("DERIVED: every tool that declares an action-shaped argument is in ACTION_ARG", async () => {
  // A tool with an `action` or `mode` enum missing from the enforcement point's table could not be narrowed. `mode` on
  // capsid_write_doc is how a body is edited, not authority, and the tool is narrowed by `action` instead.
  const REVIEWED_EXCLUSIONS = new Set<string>();
  const found = (await listedTools())
    .filter((tool) => {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { enum?: unknown[] }>;
      return Object.hasOwn(props, "action") || Array.isArray(props.mode?.enum);
    })
    .map((tool) => tool.name);
  assert.ok(
    found.length >= 5,
    `the scan found ${found.length} action-shaped tools, so it is passing by reading nothing`,
  );
  const unwired = found.filter(
    (name) => !REVIEWED_EXCLUSIONS.has(name) && actionArgFor(name) === undefined,
  );
  assert.deepEqual(
    unwired,
    [],
    `these tools declare an action-shaped argument the enforcement point cannot see: ${unwired.join(", ")}`,
  );
  // A tool that serves `action` is narrowed by it, never by a `mode` it also serves.
  const actionTools = (await listedTools())
    .filter((tool) => Object.hasOwn(tool.inputSchema.properties ?? {}, "action"))
    .map((tool) => tool.name);
  const misread = actionTools.filter((name) => actionArgFor(name) !== "action");
  assert.deepEqual(
    misread,
    [],
    `these tools serve 'action' and ACTION_ARG reads another argument: ${misread.join(", ")}`,
  );
});

test("every tool named in ACTION_ARG serves an argument by that name", async () => {
  // The other direction. A table entry naming an argument the tool does not have means
  // allowsToolAction sees undefined and refuses the narrowed tool outright.
  const wired = [
    "capsid_admin_manage_agents",
    "capsid_admin_read_claims",
    "capsid_admin_read_ops",
    "capsid_admin_manage_namespaces",
    "capsid_admin_manage_switches",
    "capsid_admin_run_controls",
    "capsid_read_status",
    "capsid_work_jobs",
    "capsid_lint_namespace",
    "capsid_close_pr",
    "capsid_find_docs",
    "capsid_read_doc",
    "capsid_write_doc",
    "capsid_read_repo",
    "capsid_inspect_repo",
  ];
  const tools = await listedTools();
  const named = tools.map((t) => t.name).filter((name) => actionArgFor(name) !== undefined);
  assert.deepEqual(
    named.filter((name) => !wired.includes(name)),
    [],
    "a tool in ACTION_ARG is missing from this list",
  );
  for (const tool of wired) {
    const key = actionArgFor(tool);
    assert.ok(key, `${tool} is expected in ACTION_ARG and is not there`);
    const listed = tools.find((t) => t.name === tool);
    assert.ok(listed, `${tool} is not served`);
    assert.ok(
      Object.hasOwn(listed.inputSchema.properties ?? {}, key),
      `${tool}'s action argument is not spelled '${key}', so its narrowing can never apply`,
    );
  }
});

test("PLANT: a driver scoped to one repo is refused a write and a read of the namespace primary when they differ", async () => {
  // Checked against the resolved repo, not the `repo` argument (a selector, usually absent); otherwise a remap of the mapping redirects a narrowed driver.
  const caller = brancher();
  caller.scopes.tools = "*";
  caller.scopes.repos = ["DrDustinEdwards/capsid"];
  const elsewhere = [{ repo: "DrDustinEdwards/somewhere-else", label: "primary" }];
  await withFetch({}, async (calls) => {
    for (const [tool, args] of [
      ["capsid_close_pr", { namespace: "capsid", action: "delete_branch", branch: "feature/x" }],
      ["capsid_read_repo", { namespace: "capsid", action: "tree" }],
    ] as const) {
      const result = await callAs(caller, tool, args, elsewhere);
      assert.equal(result.isError, true, `a driver used ${tool} on a repo outside its axis`);
      assert.match(
        result.content[0].text,
        /not scoped to the 'DrDustinEdwards\/somewhere-else' repo/,
        result.content[0].text,
      );
    }
    assert.equal(calls.length, 0, "the call reached GitHub before refusing");
  });
});

test("THE INNOCENT DIRECTION: the driver IS allowed the repo its axis names, with or without the label 'primary' as selector", async () => {
  // The label is a selector, not a scope value: comparing the argument to the axis would refuse it.
  for (const selector of [{}, { repo: "primary" }]) {
    const caller = brancher();
    caller.scopes.tools = "*";
    caller.scopes.repos = ["DrDustinEdwards/capsid"];
    caller.scopes.flags.can_merge = true;
    await withFetch(closeRoutes("DrDustinEdwards/capsid"), async () => {
      const result = await callAs(
        caller,
        "capsid_close_pr",
        { namespace: "capsid", action: "close", number: 7, ...selector },
        [{ repo: "DrDustinEdwards/capsid", label: "primary" }],
      );
      const text = result.content[0]?.text ?? "";
      assert.doesNotMatch(text, /not scoped to|unauthorized:/, `the driver was refused: ${text}`);
      assert.equal(succeeded(result).state, "closed", "the close did not land");
    });
  }
});

test("AN AGENT WITH repos '*' IS UNTOUCHED, which is every agent minted before the axis was wired", async () => {
  const caller = brancher();
  caller.scopes.tools = "*";
  const routes = {
    "GET /repos/DrDustinEdwards/anything/contents/": {
      body: [{ name: "README.md", path: "README.md", type: "file", size: 3 }],
    },
  };
  await withFetch(routes, async () => {
    const result = await callAs(
      caller,
      "capsid_read_repo",
      { namespace: "capsid", action: "tree" },
      [{ repo: "DrDustinEdwards/anything", label: "primary" }],
    );
    const text = result.content[0]?.text ?? "";
    assert.doesNotMatch(
      text,
      /not scoped to the .* repo/,
      `a wildcard axis refused a repo: ${text}`,
    );
    assert.notEqual(result.isError, true, `the listing failed: ${text}`);
    assert.ok(text.includes("README.md"), "the listing did not come back");
  });
});
