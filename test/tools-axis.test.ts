import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { defaultScopes, allowsToolAction } from "../src/agents-schema.ts";
import { adminAgent, type Agent } from "../src/agents.ts";
import { actionArgFor } from "../src/scope.ts";
import { fakeD1, fakeEnv, fakeKv, withFetch } from "./fakes.ts";
import { toolBlocks } from "./source-files.ts";

// The schemas the server actually serves, as the admin sees them.
async function listedTools() {
  const server = buildServer(fakeEnv({ APP_KV: fakeKv({}).kv }), adminAgent("DrDustinEdwards"));
  const client = new Client({ name: "tools-axis-list", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

// THE TOOLS AXIS, DRIVEN THROUGH THE PATH A REAL CALLER USES.
//
// The qualifier (`manage_pr.comment`, `jobs.post`) was a working pure function with
// three green tests over it, and it never fired for any tool but jobs, because
// nothing on the call path passed an action: the registrar read none, and
// guardedWrite put none on the scope check. A minted reviewer holding
// ["manage_pr", "manage_pr.comment"] could close a pull request, and closing deletes
// the head branch. Audit 2026-09-13, critical 1.
//
// So every plant here goes through a REAL MCP client against a REAL server, which is
// the distinction that matters: test/roles.test.ts calls allowsToolAction with the
// action already set, which is the one thing the call path did not do.

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
  serverEnv: ReturnType<typeof env> = env(repos)
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

// GitHub routes for a pr-mode write of src/thing.ts to `full`, so an innocent-direction
// call can be asserted to SUCCEED. With no routes the call fails on GitHub's side, and
// a check that only looks for the absence of one refusal passes on that failure.
function prWriteRoutes(full: string) {
  return {
    [`GET /repos/${full}`]: { body: { default_branch: "main" } },
    [`GET /repos/${full}/git/ref/heads/main`]: { body: { object: { sha: "head-sha" } } },
    [`POST /repos/${full}/git/refs`]: { status: 201, body: {} },
    [`GET /repos/${full}/contents/src/thing.ts`]: { status: 404, body: { message: "Not Found" } },
    [`PUT /repos/${full}/contents/src/thing.ts`]: { body: { commit: { sha: "commit-sha" }, content: { sha: "file-sha" } } },
    [`POST /repos/${full}/pulls`]: { status: 201, body: { number: 9, html_url: "https://pr" } },
  };
}

function succeeded(result: ToolResult): Record<string, unknown> {
  const text = result.content[0]?.text ?? "";
  assert.notEqual(result.isError, true, `the call failed: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

// The reviewer as scripts/mint-agents.mjs mints it: write grant, can_comment_pr and
// nothing else, and a tools axis narrowed to manage_pr's comment action.
function reviewer(): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  scopes.tools = ["manage_pr", "manage_pr.comment"];
  scopes.flags.can_comment_pr = true;
  return { id: "agent_reviewer01", name: "reviewer", kind: "session", actor: "agent:reviewer", scopes, admin: false, row: null };
}

// ---- critical 1: the reviewer cannot close ----------------------------------------

test("PLANT: a reviewer scoped to manage_pr.comment is REFUSED action close", async () => {
  // The finding, exactly: close needed no flag at all when this was written, so the
  // tools axis was the only thing standing between a reviewer and a closed pull
  // request with its head branch deleted. close has carried can_merge since
  // 2026-09-16, and this still asserts the AXIS refusal rather than the flag one,
  // because checkScope names the tool before it names a missing flag.
  await withFetch({}, async (calls) => {
    const result = await callAs(reviewer(), "manage_pr", { namespace: "capsid", number: 7, action: "close" });
    assert.equal(result.isError, true, "a reviewer closed a pull request");
    assert.match(result.content[0].text, /not scoped to the 'manage_pr\.close' tool/, result.content[0].text);
    assert.equal(calls.length, 0, "the close reached GitHub before refusing, so the refusal describes something that already happened");
  });
});

test("PLANT: the same reviewer is REFUSED action merge, for the axis and not only for the flag", async () => {
  // can_merge already stopped this one. It is planted anyway because a refusal that
  // names the flag and a refusal that names the axis are different guards, and the
  // axis is the one that was not running.
  await withFetch({}, async (calls) => {
    const result = await callAs(reviewer(), "manage_pr", { namespace: "capsid", number: 7, action: "merge" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not scoped to the 'manage_pr\.merge' tool/, result.content[0].text);
    assert.equal(calls.length, 0);
  });
});

test("THE INNOCENT DIRECTION: the reviewer IS allowed action comment", async () => {
  // Without this, a manage_pr broken for everybody passes both plants above, and the
  // reviewer role would be a credential that cannot do the one thing it exists for.
  const routes = { "POST /repos/o/r/issues/7/comments": { status: 201, body: { id: 55, html_url: "https://comment" } } };
  await withFetch(routes, async (calls) => {
    const result = await callAs(reviewer(), "manage_pr", { namespace: "capsid", number: 7, action: "comment", comment: "REVIEW: fine. APPROVE" });
    const text = result.content[0]?.text ?? "";
    assert.doesNotMatch(text, /unauthorized:/, `the reviewer was refused its own action: ${text}`);
    const out = succeeded(result);
    assert.equal(out.action, "comment");
    assert.equal(out.comment_id, 55);
    assert.equal(calls.filter((c) => c.method === "POST" && c.path === "/repos/o/r/issues/7/comments").length, 1);
  });
});

test("A BARE TOOL NAME STILL MEANS THE WHOLE TOOL, so no agent minted before the qualifier changed", async () => {
  // Narrowing is opted into. An agent whose list names manage_pr and no qualified
  // sibling keeps every action, which is what it has always meant.
  const caller = reviewer();
  caller.scopes.tools = ["manage_pr"];
  caller.scopes.flags.can_merge = true;
  const routes = { "PATCH /repos/o/r/pulls/7": { body: { number: 7, state: "closed", html_url: "https://pr" } } };
  await withFetch(routes, async (calls) => {
    const result = await callAs(caller, "manage_pr", { namespace: "capsid", number: 7, action: "close" });
    const text = result.content[0]?.text ?? "";
    assert.doesNotMatch(text, /not scoped to/, `an unqualified list was narrowed anyway: ${text}`);
    const out = succeeded(result);
    assert.equal(out.action, "close");
    assert.equal(out.state, "closed");
    assert.ok(calls.some((c) => c.method === "PATCH" && c.path === "/repos/o/r/pulls/7"), "the close never reached GitHub");
  });
});

// ---- finding 5: lint's action is its mode -----------------------------------------

test("PLANT: an agent scoped to lint.gather is REFUSED mode finalize", async () => {
  // lint spells its action `mode`, so a registrar that only ever read `action` left
  // this narrowing unreachable: gather is a read and finalize archives documents.
  const caller = reviewer();
  caller.scopes.tools = ["lint", "lint.gather"];
  const result = await callAs(caller, "lint", { namespace: "capsid", mode: "finalize" });
  assert.equal(result.isError, true, "a gather-only caller ran finalize");
  assert.match(result.content[0].text, /not scoped to the 'lint\.finalize' tool/, result.content[0].text);
});

test("THE INNOCENT DIRECTION: the same caller IS allowed mode gather", async () => {
  const caller = reviewer();
  caller.scopes.tools = ["lint", "lint.gather"];
  const d1 = fakeD1({ documents: [{ namespace: "capsid", path: "core.md", title: "core", body: "the core", type: "core" }] });
  const result = await callAs(caller, "lint", { namespace: "capsid", mode: "gather" }, REPOS, fakeEnv({ DB: d1.db, APP_KV: fakeKv({}).kv }));
  const text = result.content[0]?.text ?? "";
  assert.doesNotMatch(text, /not scoped to/, `the gather-only caller was refused gather: ${text}`);
  const out = succeeded(result) as { core?: { body?: string } };
  assert.equal(out.core?.body, "the core", "gather did not return the namespace's core document");
});

// ---- the rule itself ---------------------------------------------------------------

test("AN UNKNOWN ACTION ON A NARROWED TOOL IS REFUSED, rather than read as the whole tool", () => {
  // The change that makes every wiring above fail closed instead of silently open. A
  // future call path that forgets to pass the action is refused, not waved through.
  assert.equal(allowsToolAction(["manage_pr", "manage_pr.comment"], "manage_pr", undefined), false);
  assert.equal(allowsToolAction(["manage_pr", "manage_pr.comment"], "manage_pr", "comment"), true);
  assert.equal(allowsToolAction(["manage_pr", "manage_pr.comment"], "manage_pr", "close"), false);
  // Unqualified is untouched in both directions.
  assert.equal(allowsToolAction(["manage_pr"], "manage_pr", undefined), true);
  assert.equal(allowsToolAction(["manage_pr"], "manage_pr", "close"), true);
  // The narrowing reaches only the tool it names.
  assert.equal(allowsToolAction(["manage_pr", "manage_pr.comment", "lint"], "lint", "finalize"), true);
});

// ---- DERIVED: a new action tool cannot be added without wiring its action ----------

// scanner-rule: CLAUDE.md, one enforcement point rule
test("DERIVED: every tool that declares an action-shaped argument is in ACTION_ARG", () => {
  // The guard against the finding recurring. A tool added with an `action` or `mode`
  // enum whose name is not in the enforcement point's table would be unnarrowable in
  // exactly the way manage_pr was, and nothing else in the suite would notice.
  //
  // The exclusions are reviewed, not incidental: `mode` on the three write tools
  // already decides a FLAG (can_direct_write for a direct commit), and on `write` it
  // chooses how a body is edited rather than what authority the call needs. Giving one
  // setting two authorities to disagree about is worse than leaving it out.
  const REVIEWED_EXCLUSIONS = new Set(["write", "write_repo_file", "delete_repo_file"]);
  const found = toolBlocks()
    .filter((block) => /\n\s+action: z\./.test(block.body) || /\n\s+mode: z\.enum/.test(block.body))
    .map((block) => block.name);
  assert.ok(found.length >= 5, `the scan found ${found.length} action-shaped tools, so it is passing by reading nothing`);
  const unwired = found.filter((name) => !REVIEWED_EXCLUSIONS.has(name) && actionArgFor(name) === undefined);
  assert.deepEqual(unwired, [], `these tools declare an action-shaped argument the enforcement point cannot see: ${unwired.join(", ")}`);
});

test("every tool named in ACTION_ARG serves an argument by that name", async () => {
  // The other direction. A table entry naming an argument the tool does not have is a
  // narrowing that silently never applies, which is the same defect wearing the other
  // hat: allowsToolAction would see undefined and, since 2026-09-13, refuse the tool
  // outright rather than quietly allowing everything. Both are wrong; this catches it.
  const wired = ["agents", "improve_run", "jobs", "lint", "manage_pr"];
  const tools = await listedTools();
  for (const tool of wired) {
    const key = actionArgFor(tool);
    assert.ok(key, `${tool} is expected in ACTION_ARG and is not there`);
    const listed = tools.find((t) => t.name === tool);
    assert.ok(listed, `${tool} is not served`);
    assert.ok(
      Object.hasOwn(listed.inputSchema.properties ?? {}, key),
      `${tool}'s action argument is not spelled '${key}', so its narrowing can never apply`
    );
  }
});

// ---- finding 4: the repos axis binds the DEFAULT call -------------------------------

test("PLANT: a driver scoped to one repo is refused a write to the namespace primary when they differ", async () => {
  // The remap escalation. The axis held owner/name entries and the registrar compared
  // it to the `repo` ARGUMENT, which is a selector and is usually absent; omit it and
  // resolveRepo picked the namespace primary with nothing asked. An admin remap of the
  // mapping was therefore enough to redirect a narrowed driver.
  const caller = reviewer();
  caller.scopes.tools = "*";
  caller.scopes.repos = ["DrDustinEdwards/capsid"];
  await withFetch({}, async (calls) => {
    const result = await callAs(
      caller,
      "write_repo_file",
      { namespace: "capsid", path: "src/thing.ts", content: "x", message: "m" },
      [{ repo: "DrDustinEdwards/somewhere-else", label: "primary" }]
    );
    assert.equal(result.isError, true, "a driver wrote to a repo outside its axis by omitting the selector");
    assert.match(result.content[0].text, /not scoped to the 'DrDustinEdwards\/somewhere-else' repo/, result.content[0].text);
    assert.equal(calls.length, 0, "the write reached GitHub before refusing");
  });
});

test("PLANT: the same driver is refused a READ of a repo outside its axis", async () => {
  // Reads resolve the same mapping and were not checked at all.
  const caller = reviewer();
  caller.scopes.tools = "*";
  caller.scopes.repos = ["DrDustinEdwards/capsid"];
  const result = await callAs(caller, "list_repo_tree", { namespace: "capsid" }, [{ repo: "DrDustinEdwards/somewhere-else", label: "primary" }]);
  assert.equal(result.isError, true, "a driver read a repo outside its axis");
  assert.match(result.content[0].text, /not scoped to the 'DrDustinEdwards\/somewhere-else' repo/, result.content[0].text);
});

test("THE LABEL 'primary' IS A SELECTOR, NOT A SCOPE VALUE, so passing it is not refused", async () => {
  // The other half of the same defect, and the reason it stayed hidden: comparing the
  // argument to the axis refused the legitimate label, which pushed every caller back
  // onto omitting it, which was the unchecked path.
  const caller = reviewer();
  caller.scopes.tools = "*";
  caller.scopes.repos = ["DrDustinEdwards/capsid"];
  await withFetch(prWriteRoutes("DrDustinEdwards/capsid"), async () => {
    const result = await callAs(
      caller,
      "write_repo_file",
      { namespace: "capsid", path: "src/thing.ts", content: "x", message: "m", repo: "primary" },
      [{ repo: "DrDustinEdwards/capsid", label: "primary" }]
    );
    const text = result.content[0]?.text ?? "";
    assert.doesNotMatch(text, /not scoped to the 'primary' repo/, `a legitimate label was compared to the axis: ${text}`);
    assert.doesNotMatch(text, /unauthorized:/, `the driver was refused its own repo: ${text}`);
    const out = succeeded(result) as { pr?: { number?: number } };
    assert.equal(out.pr?.number, 9, "the write did not open its pull request");
  });
});

test("THE INNOCENT DIRECTION: the driver IS allowed the repo its axis names, with no selector", async () => {
  const caller = reviewer();
  caller.scopes.tools = "*";
  caller.scopes.repos = ["DrDustinEdwards/capsid"];
  await withFetch(prWriteRoutes("DrDustinEdwards/capsid"), async () => {
    const result = await callAs(
      caller,
      "write_repo_file",
      { namespace: "capsid", path: "src/thing.ts", content: "x", message: "m" },
      [{ repo: "DrDustinEdwards/capsid", label: "primary" }]
    );
    const text = result.content[0]?.text ?? "";
    assert.doesNotMatch(text, /unauthorized:/, `the driver was refused the repo it is scoped to: ${text}`);
    const out = succeeded(result) as { pr?: { number?: number } };
    assert.equal(out.pr?.number, 9, "the write did not open its pull request");
  });
});

test("AN AGENT WITH repos '*' IS UNTOUCHED, which is every agent minted before the axis was wired", async () => {
  const caller = reviewer();
  caller.scopes.tools = "*";
  const routes = {
    "GET /repos/DrDustinEdwards/anything/contents/": { body: [{ name: "README.md", path: "README.md", type: "file", size: 3 }] },
  };
  await withFetch(routes, async () => {
    const result = await callAs(caller, "list_repo_tree", { namespace: "capsid" }, [{ repo: "DrDustinEdwards/anything", label: "primary" }]);
    const text = result.content[0]?.text ?? "";
    assert.doesNotMatch(text, /not scoped to the .* repo/, `a wildcard axis refused a repo: ${text}`);
    assert.notEqual(result.isError, true, `the listing failed: ${text}`);
    assert.ok(text.includes("README.md"), "the listing did not come back");
  });
});
