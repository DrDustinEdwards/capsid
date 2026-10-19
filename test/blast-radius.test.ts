import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server.ts";
import { SCOPE_FLAGS, defaultScopes, type ScopeFlag } from "../src/agents-schema.ts";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import { IMPROVE_OVERRIDE_FLAGS, TOOL_ACTION_GRANTS, TOOL_GRANTS, repoWriteFlags } from "../src/scope.ts";
import { fakeD1, fakeEnv, fakeKv, withFetch } from "./fakes.ts";
import { operationBlocks, sourceFile, sourceFiles, toolBlocks, type SourceFile } from "./source-files.ts";
import { servedOperations } from "./served.ts";

// The blast-radius suite. One plant per flag, driven through a real MCP connection
// against a scoped caller, in both directions: the agent without the flag is refused,
// and the admin holding it is not. A refusal test alone passes against a tool that is
// broken for everybody.
//
// Every refusing plant also asserts the GitHub call count is zero: a repo write that
// refuses after committing to GitHub has already happened.

const REPOS = [{ repo: "o/r", label: "primary" }];

function env() {
  return fakeEnv({
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => ({ repos: JSON.stringify(REPOS) }) }) }),
    },
    APP_KV: fakeKv({ seedToken: true }).kv,
  });
}

// A project driver as docs/bootstrap.md says to mint one: write on its own
// namespace, and not one flag.
function driver(namespace = "capsid", grant: ScopeFlag[] = []): Agent {
  const scopes = defaultScopes([namespace]);
  scopes.grants = ["read", "write"];
  for (const flag of grant) scopes.flags[flag] = true;
  return { id: "agent_0123456789ab", name: `${namespace}-driver`, kind: "driver", actor: `agent:${namespace}-driver`, scopes, admin: false, row: null };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function callAs(caller: Agent, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const server = buildServer(env(), caller);
  const client = new Client({ name: "blast-radius", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
  await client.close();
  await server.close();
  return result;
}

// Every path that needs a flag, one row each: the tool, the arguments that make the
// call need it, and the flag it needs.
const PLANTS: Array<{ flag: ScopeFlag; tool: string; args: Record<string, unknown>; what: string }> = [
  {
    flag: "can_direct_write",
    tool: "capsid_change_repo",
    args: { action: "write_file", namespace: "capsid", path: "src/thing.ts", content: "x", message: "m", mode: "direct" },
    what: "a direct-mode commit, which lands on the default branch with no review",
  },
  {
    flag: "can_direct_write",
    tool: "capsid_change_repo",
    args: { action: "delete_file", namespace: "capsid", path: "src/thing.ts", message: "m", mode: "direct" },
    what: "a direct-mode delete, same branch and same absence of review",
  },
  {
    flag: "can_write_workflows",
    tool: "capsid_change_repo",
    args: { action: "write_file", namespace: "capsid", path: ".github/workflows/ci.yml", content: "x", message: "m", allow_workflow_write: true },
    what: "a workflow write, which edits what MEASURES the code",
  },
  {
    flag: "can_merge",
    tool: "capsid_close_pr",
    args: { action: "merge", namespace: "capsid", number: 7 },
    what: "a merge, which can trigger a deploy on a repo that deploys on push",
  },
  {
    flag: "can_merge",
    tool: "capsid_close_pr",
    args: { action: "close", namespace: "capsid", number: 7 },
    what: "a pull request close, which deletes the head branch the way a merge does",
  },
  {
    flag: "can_merge",
    tool: "capsid_close_pr",
    args: { action: "tag", namespace: "capsid", tag: "v1.0.0" },
    what: "a tag, which can start a deploy the way a merge does",
  },
  {
    flag: "can_merge",
    tool: "capsid_close_pr",
    args: { action: "release", namespace: "capsid", tag: "v1.0.0" },
    what: "a published release, which can start a deploy the way a merge does",
  },
  {
    flag: "can_merge",
    tool: "capsid_close_pr",
    args: { action: "delete_branch", namespace: "capsid", branch: "feature/other-agent", force: true },
    what: "a forced branch delete, which lifts the open-PR refusal and so can delete another agent's PR head",
  },
  {
    flag: "can_comment_pr",
    tool: "capsid_open_pr",
    args: { action: "comment", namespace: "capsid", number: 7, comment: "REVIEW: looks fine. APPROVE" },
    what: "a comment on a pull request, which is the one write a reviewer makes and is not a merge",
  },
  {
    flag: "can_dispatch",
    tool: "capsid_run_ci",
    args: { namespace: "capsid", workflow: "verify.yml", ref: "master" },
    what: "a workflow dispatch, which spends CI minutes and runs code with the repo's secrets in scope",
  },
  {
    flag: "can_touch_protected",
    tool: "capsid_change_repo",
    args: { action: "write_file", namespace: "capsid", path: "package.json", content: "{}", message: "m" },
    what: "a write to a protected path, which is what the improve loop may never touch at all",
  },
  {
    flag: "can_touch_protected",
    tool: "capsid_change_repo",
    args: { action: "write_file", namespace: "capsid", path: "test/thing.test.ts", content: "x", message: "m" },
    what: "a write to a test, which is the measurement rather than the code",
  },
  {
    flag: "money_paths",
    tool: "capsid_change_repo",
    args: { action: "write_file", namespace: "foxhound", path: "app/billing/charge.server.ts", content: "x", message: "m" },
    what: "a write to a billing path in foxhound, which is where a mistake costs real money",
  },
];

for (const plant of PLANTS) {
  test(`PLANT: without ${plant.flag}, a driver is refused ${plant.what}`, async () => {
    await withFetch({}, async (calls) => {
      // The driver is scoped to the namespace the call names, so the refusal is about
      // the flag and not about the namespace.
      const caller = driver(String(plant.args.namespace));
      const result = await callAs(caller, plant.tool, plant.args);
      assert.equal(result.isError, true, `${plant.tool} was not refused without ${plant.flag}`);
      assert.match(result.content[0].text, new RegExp(`needs the ${plant.flag} flag`), `the refusal does not name ${plant.flag}: ${result.content[0].text}`);
      assert.equal(calls.length, 0, `${plant.tool} reached GitHub before refusing, so the refusal describes something that already happened`);
    });
  });

  test(`PLANT: the same call is NOT refused for a caller holding ${plant.flag}`, async () => {
    // The call may fail afterwards for its own reasons (the fetch harness has no
    // routes), so this asserts that the scope refusal text is absent, not success.
    await withFetch({}, async (calls) => {
      const result = await callAs(adminAgentForEmail("admin@example.com"), plant.tool, plant.args);
      const text = result.content[0]?.text ?? "";
      assert.ok(text.length > 0, "the call returned no text, so an absent refusal proves nothing");
      assert.doesNotMatch(text, /needs the .* flag/, `the admin was refused a flag it holds: ${text}`);
      assert.doesNotMatch(text, /unauthorized:/, `the admin was refused: ${text}`);
      // Past the scope check means GitHub was asked.
      assert.ok(calls.length > 0, `${plant.tool} never reached GitHub for a caller holding ${plant.flag}: ${text}`);
    });
  });
}

test("PLANT: a driver IS allowed the pull-request path, which is the whole point of scoping it this way", async () => {
  // The shape docs/bootstrap.md prescribes has to work. A pr-mode write needs no flag.
  await withFetch({}, async (calls) => {
    const result = await callAs(driver(), "capsid_change_repo", {
      action: "write_file",
      namespace: "capsid",
      path: "src/thing.ts",
      content: "x",
      message: "m",
      mode: "pr",
    });
    const text = result.content[0]?.text ?? "";
    assert.doesNotMatch(text, /unauthorized:/, `a pr-mode write was refused for a driver: ${text}`);
    assert.ok(calls.length > 0, "the call never reached GitHub, so this asserts nothing about the guard");
  });
});

test("PLANT: a driver IS allowed a branch delete without force, which still refuses an open PR's head", async () => {
  // The unforced delete keeps its own open-PR refusal in src/github/refs.ts, so it
  // needs no flag. Holding it to can_merge would take branch cleanup away from every
  // driver.
  await withFetch({}, async (calls) => {
    const result = await callAs(driver(), "capsid_close_pr", { action: "delete_branch", namespace: "capsid", branch: "feature/mine" });
    const text = result.content[0]?.text ?? "";
    assert.doesNotMatch(text, /needs the .* flag/, `an unforced capsid_close_pr delete_branch was refused a flag for a driver: ${text}`);
    assert.doesNotMatch(text, /unauthorized:/, `an unforced capsid_close_pr delete_branch was refused for a driver: ${text}`);
    assert.ok(calls.length > 0, "the call never reached GitHub, so this asserts nothing about the guard");
  });
});

test("PLANT: a driver cannot reach a namespace it was not minted for", async () => {
  await withFetch({}, async (calls) => {
    const result = await callAs(driver("capsid"), "capsid_change_repo", {
      action: "write_file",
      namespace: "foxing",
      path: "src/thing.ts",
      content: "x",
      message: "m",
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not scoped to the 'foxing' namespace/);
    assert.equal(calls.length, 0, "the refused call still reached GitHub");
  });
});

test("PLANT: a namespace-scoped caller that omits the namespace is refused, not silently given all of them", async () => {
  // capsid_find_docs (list, search) treats an omitted namespace as every namespace, so a narrowed
  // caller that left it out would read the whole store.
  const result = await callAs(driver(), "capsid_find_docs", {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /must name a namespace/);

  // Naming one it holds still works. This needs a store that can answer a multi-row
  // read, so it uses the shared fake rather than the one-row repo stub.
  const d1 = fakeD1({ documents: [{ namespace: "capsid", path: "core.md", title: "core" }] });
  const server = buildServer(fakeEnv({ DB: d1.db }), driver());
  const client = new Client({ name: "blast-radius", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const allowed = (await client.callTool({ name: "capsid_find_docs", arguments: { namespace: "capsid" } })) as ToolResult;
  await client.close();
  await server.close();
  assert.notEqual(allowed.isError, true, allowed.content[0]?.text);
  assert.match(allowed.content[0].text, /core\.md/, "the allowed read came back empty, so it proves nothing about the guard");
});

test("PLANT: an unscoped tool is refused even when the grant and the namespace are fine", async () => {
  const narrow = driver();
  narrow.scopes.tools = ["capsid_read_doc", "capsid_find_docs", "capsid_write_doc"];
  const result = await callAs(narrow, "capsid_close_pr", { action: "close", namespace: "capsid", number: 7 });
  assert.equal(result.isError, true);
  // The refusal names the action, which shows the registrar populates need.action.
  assert.match(result.content[0].text, /not scoped to the 'capsid_close_pr\.close' tool/);
});

// The derived half.

// scanner-rule: CLAUDE.md, one enforcement point rule: no new tool bypasses checkScope. Derived over every
// registration, including tools added later.
test("DERIVED: every write tool is on the enforcement point's path", () => {
  // The registrations are walked, and each write tool must be covered by the
  // registrar (its requirement is stated) or carry its own check. A served tool is a
  // one-line registration that dispatches to operations (src/tools/surface.ts), so a
  // tool's own check lives in the operation blocks it runs, and every one of them must
  // carry it.
  const ops = new Map(operationBlocks().map((b) => [b.name, b.body]));
  const served = servedOperations();
  const ownCheck = (tool: string): boolean => {
    const bodies = served.filter((s) => s.tool === tool).map((s) => ops.get(s.op));
    return bodies.length > 0 && bodies.every((body) => body !== undefined && /ctx\.scope\(/.test(body));
  };
  const uncovered = toolBlocks()
    .filter((b) => TOOL_GRANTS[b.name] !== "read")
    .filter(
      (b) =>
        !Object.hasOwn(TOOL_GRANTS, b.name) ||
        (TOOL_GRANTS[b.name] === "action" && !Object.hasOwn(TOOL_ACTION_GRANTS, b.name) && !ownCheck(b.name))
    )
    .map((b) => b.name);
  assert.deepEqual(uncovered, [], `these write tools are not covered by checkScope: ${uncovered.join(", ")}`);
  // Vacuity: the walk found a real surface, and the operations it dispatches to.
  assert.ok(toolBlocks().length >= 20, "the tool walk collapsed");
  assert.ok(ops.size >= 30, "the operation walk collapsed");
});

// scanner-rule: CLAUDE.md, one enforcement point rule: a repo mutation carries its flags through guardedWrite.
// Derived over every GitHub mutation helper and every call site in src/.

// The GitHub mutation helpers, derived from src/github/: every top-level function that
// sends a POST, PUT, PATCH or DELETE through ghFetch, and every function that calls one,
// to a fixed point. The exported ones are what the rest of src/ can call.
const MUTATING_METHOD = /method:\s*"(?:POST|PUT|PATCH|DELETE)"/;
function githubMutationHelpers(files: SourceFile[]): string[] {
  const blocks: Array<{ name: string; exported: boolean; body: string }> = [];
  for (const file of files.filter((f) => f.name.startsWith("github/"))) {
    const heads = [...file.text.matchAll(/^(export )?(?:async )?function (\w+)/gm)];
    heads.forEach((m, i) => {
      const body = file.text.slice(m.index, i + 1 < heads.length ? heads[i + 1].index : file.text.length);
      blocks.push({ name: m[2], exported: Boolean(m[1]), body });
    });
  }
  const mutating = new Set(blocks.filter((b) => /ghFetch\(/.test(b.body) && MUTATING_METHOD.test(b.body)).map((b) => b.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const b of blocks) {
      if (mutating.has(b.name)) continue;
      if ([...mutating].some((name) => new RegExp(`\\b${name}\\(`).test(b.body.slice(b.body.indexOf("{"))))) {
        mutating.add(b.name);
        grew = true;
      }
    }
  }
  return blocks.filter((b) => b.exported && mutating.has(b.name)).map((b) => b.name).sort();
}

// Import lists and comment lines are blanked (same length, so offsets hold): they name
// a helper without calling it.
function codeOnly(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return text.replace(/^import[\s\S]*?from\s+"[^"]+";/gm, blank).replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, blank);
}

// Every call to a mutation helper outside src/github/ that is not inside a guardedWrite
// callback (guardedWrite( within the 800 characters before it), and every ghFetch outside
// src/github/ that sends a mutating method itself, as "file: helper".
function unguardedMutations(files: SourceFile[], helpers: string[]): string[] {
  const found: string[] = [];
  for (const file of files.filter((f) => !f.name.startsWith("github/"))) {
    const code = codeOnly(file.text);
    for (const helper of helpers) {
      for (const m of code.matchAll(new RegExp(`(?<![\\w.])${helper}\\(`, "g"))) {
        if (/function\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
        if (/guardedWrite\(/.test(code.slice(Math.max(0, m.index - 800), m.index))) continue;
        found.push(`${file.name}: ${helper}`);
      }
    }
    for (const m of code.matchAll(/\bghFetch\(/g)) {
      let depth = 0;
      let at = m.index + "ghFetch".length;
      for (; at < code.length; at++) {
        if (code[at] === "(") depth += 1;
        else if (code[at] === ")" && --depth === 0) break;
      }
      if (MUTATING_METHOD.test(code.slice(m.index, at)) || /method:\s*\w/.test(code.slice(m.index, at))) {
        found.push(`${file.name}: ghFetch`);
      }
    }
  }
  return found.sort();
}

// The call sites that reach GitHub outside guardedWrite, each named with why. guardedWrite
// is checkScope over a caller's grant and flags (src/tools/repo-guards.ts), and none of
// these has a caller to check: building an all-allowing agent for them would be a check
// that cannot refuse. Each writes its own audit row. Adding a site is a test edit a
// reviewer sees; a second call in a listed file fails too, because the count is exact.
const UNGUARDED_EXCEPTIONS: Array<{ site: string; why: string }> = [
  {
    site: "approval-executor.ts: managePr",
    why: "the tick merging on a human's recorded approval (pr_approvals), pinned to the approved sha; no caller, audited by close()",
  },
  {
    site: "auto-merge-tick.ts: managePr",
    why: "the signed auto-merge policy's own merge on the cron tick, pinned to the judged sha; no caller, audited by systemAudit",
  },
  {
    site: "controls.ts: managePr",
    why: "the portal's pr_close control: the owner's signed control token (Access login, no MCP grant); writes its pr-closed audit row",
  },
  {
    site: "maintenance-branches.ts: deletePruneCandidates",
    why: "the maintenance pass's branch prune, a system action behind its KV switch; audited per branch",
  },
  {
    site: "maintenance-releases.ts: createTag",
    why: "the maintenance pass's release tagging, a system action behind its KV switch; audited per tag",
  },
  {
    site: "maintenance-releases.ts: publishRelease",
    why: "the same pass publishing the tag's release notes; audited with the tag",
  },
];

test("DERIVED: every repo mutation goes through the one wrapper that computes the flags", () => {
  // The repo write tools reach GitHub through guardedWrite, where repoWriteFlags
  // runs. Code calling a github/ mutation directly would skip the flag check while
  // still being write-gated at the registrar. All of src/ is scanned, not only the
  // repo tools: a cron or control reaching GitHub is a mutation too.
  const files = sourceFiles();
  const helpers = githubMutationHelpers(files);
  // Vacuity and drift: the derivation finds every helper the repo tools are known to
  // call. A helper missing here means the derivation stopped seeing it.
  for (const known of ["writeRepoFile", "deleteRepoFile", "createBranch", "openPr", "managePr", "deleteBranch", "pruneMergedBranches", "ciDispatch", "tagRelease"]) {
    assert.ok(helpers.includes(known), `the derivation did not find ${known} as a mutation helper; it found ${helpers.join(", ")}`);
  }
  const repo = codeOnly(sourceFile("tools/repo.ts"));
  for (const known of ["writeRepoFile(", "managePr(", "ciDispatch("]) {
    assert.ok(repo.includes(known), `the scan found no call to ${known} in tools/repo.ts; it is reading nothing`);
  }
  assert.deepEqual(
    unguardedMutations(files, helpers),
    UNGUARDED_EXCEPTIONS.map((e) => e.site).sort(),
    "a GitHub mutation is called outside guardedWrite, so no flag is checked for it. Route it through guardedWrite, " +
      "or, where there is no caller to check, add it to UNGUARDED_EXCEPTIONS with the reason"
  );
});

test("PLANT: the mutation scan catches a helper called outside guardedWrite, and a raw mutating ghFetch", () => {
  const helpers = githubMutationHelpers(sourceFiles());
  const planted: SourceFile[] = [
    { name: "tools/guarded.ts", text: 'return guardedWrite("manage_pr", ns, null, () => managePr(env, ns, 1, "merge"));\n' },
    { name: "rogue.ts", text: 'import { managePr } from "./github/refs";\n// managePr( in a comment is not a call\nawait managePr(env, ns, 1, "merge");\n' },
    { name: "raw.ts", text: 'await ghFetch(env, o, r, `/repos/${o}/${r}/pulls/1/merge`, { method: "PUT" });\nawait ghFetch(env, o, r, "/repos/x");\n' },
  ];
  assert.deepEqual(unguardedMutations(planted, helpers), ["raw.ts: ghFetch", "rogue.ts: managePr"]);
});

test("every flag is required by some path, so none of them is decoration", () => {
  // A flag nothing asks for protects nothing. Each one has to be produced by
  // repoWriteFlags for some call, or be named by the document-side override.
  const produced = new Set<ScopeFlag>();
  for (const plant of PLANTS) {
    const action = typeof plant.args.action === "string" ? plant.args.action : undefined;
    for (const flag of repoWriteFlags(plant.tool, action, plant.args as { path?: string; mode?: string; allow_workflow_write?: boolean; force?: boolean })) {
      produced.add(flag);
    }
  }
  // That the override is required on write, restore, delete and move is proven in
  // test/improve-protected-paths.test.ts.
  for (const flag of IMPROVE_OVERRIDE_FLAGS) produced.add(flag);
  // The loops over SCOPE_FLAGS in the agents-* tests rely on this list being non-empty.
  assert.ok(SCOPE_FLAGS.length > 0, "SCOPE_FLAGS is empty, so no flag was checked here or in the agents tests");
  for (const flag of SCOPE_FLAGS) {
    assert.ok(produced.has(flag), `${flag} is required by no path, so holding it or not changes nothing`);
  }
});
