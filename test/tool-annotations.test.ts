import assert from "node:assert/strict";
import { test } from "node:test";
import { hintsFor, TOOL_HINTS } from "../src/tool-annotations.ts";
import { requiredGrant } from "../src/scope.ts";
import { sourceFile, sourceFiles, toolBlocks } from "./source-files.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { adminAgentForEmail } from "../src/agents.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// Tool annotations are derived, not declared.
//
// An annotation is a hint a client acts on, so a wrong one is worse than a missing
// one: `readOnlyHint: true` on a tool that writes tells a client it need not ask.
// src/tool-annotations.ts is a cache of two facts that live in the handlers, and
// this file checks it against them.
//
// Every scan below fails in both directions and carries a count guard, because
// "0 tools disagreed" and "0 tools were read" are otherwise indistinguishable.

// A tool is write-gated iff src/scope.ts says a call needs the write grant.
// TOOL_GRANTS is what the registrar enforces at runtime, and test/invariants.test.ts
// separately proves TOOL_GRANTS against the handlers (every mutating tool is
// write-gated, and nothing marked read contains mutating SQL).
const isWriteGated = (tool: string) => requiredGrant(tool) !== "read";

// A write-gated handler is destructive iff it can overwrite or remove state that
// already exists. Matched by what the handler does, never by its name, so the next
// tool that learns to delete something is caught here.
const DESTRUCTIVE = [
  /INSERT INTO documents/i, // an overwrite goes through the same insert as a create
  /\bdocumentUpsert\(/,
  /\bpathMutation\(/,
  /UPDATE namespaces/i,
  /\bdeleteRepoFile\(/,
  /\bdeleteBranch\(/,
  /\bmanagePr\(/,
  /\bwriteRepoFile\(/,
  // The improve loop's two mutating entry points (mode, pause and budget; advancing
  // a run reverts attempts). Named because the writes happen in another module.
  /\bimproveControl\(/,
  /\bimproveRunManual\(/,
  // The work queue's mutating entry points; the writes happen in src/jobs.ts.
  /\bclaimJob\(/,
  /\bcompleteJob\(/,
  /\bfailJob\(/,
  /\bblockJob\(/,
  // The credential control plane's two overwriting entry points (revoke,
  // update_scopes); the statements live in src/agents-admin.ts.
  /\brevokeAgent\(/,
  /\bupdateAgentScopes\(/,
];

const matches = (body: string, res: RegExp[]) => res.some((re) => re.test(body));

// The annotations a client receives, read from tools/list rather than from the
// registration source.
async function servedAnnotations(): Promise<Map<string, Record<string, unknown> | undefined>> {
  const server = buildServer(fakeEnv({ APP_KV: fakeKv({}).kv }), adminAgentForEmail("admin@example.com"));
  const client = new Client({ name: "tool-annotations", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return new Map(tools.map((t) => [t.name, t.annotations as Record<string, unknown> | undefined]));
}

test("PLANT: every served tool carries exactly its hint table entry, and the table names only served tools", async () => {
  const served = await servedAnnotations();
  assert.ok(served.size > 0, "the server served no tools");
  assert.deepEqual([...served.keys()].sort(), Object.keys(TOOL_HINTS).sort(), "a tool without an entry, or an entry without a tool, fails here");
  const differs = [...served].filter(([name, hints]) => JSON.stringify(hints) !== JSON.stringify(TOOL_HINTS[name])).map(([name]) => name);
  assert.deepEqual(differs, [], `these tools serve annotations that are not their table entry: ${differs.join(", ")}`);
});

test("PLANT: the served readOnlyHint is exactly the negation of the write gate", async () => {
  const served = await servedAnnotations();
  const gated = [...served.keys()].filter(isWriteGated);
  // Vacuity: both sides of the rule are populated, or it is comparing nothing.
  assert.ok(gated.length > 0 && gated.length < served.size, `the write gate splits ${served.size} tools into ${gated.length} gated`);
  const wrong = [...served]
    .filter(([name, hints]) => hints?.readOnlyHint !== !isWriteGated(name))
    .map(([name, hints]) => `${name}: write-gated=${isWriteGated(name)} but readOnlyHint=${hints?.readOnlyHint}`);
  assert.deepEqual(wrong, [], wrong.join("; "));
});

// The destructive classification comes from the handler source, because the repo,
// queue, improve and agent tools overwrite through modules this file cannot observe
// without their own fakes. The hints compared are the served ones. The five document
// mutators test/write-invariants.test.ts drives are also checked by name below.
test("PLANT: every mutating tool is served with destructiveHint true", async () => {
  const served = await servedAnnotations();
  const mutating = toolBlocks().filter((b) => isWriteGated(b.name) && matches(b.body, DESTRUCTIVE));
  assert.ok(mutating.length >= 10, `the destructive scan found only ${mutating.length} mutating tools; it is broken`);
  const understated = mutating.filter((b) => served.get(b.name)?.destructiveHint !== true).map((b) => b.name);
  assert.deepEqual(understated, [], `these tools can overwrite or remove and do not say so: ${understated.join(", ")}`);
  for (const tool of ["write", "delete", "restore", "move", "lint"]) {
    assert.equal(served.get(tool)?.destructiveHint, true, `${tool} overwrites or removes a document and is not served as destructive`);
  }
});

test("PLANT: no read-only tool is served as destructive, and no additive tool overstates", async () => {
  // The negative direction: a tool that mutates nothing must not claim to be destructive.
  const served = await servedAnnotations();
  const overstated = toolBlocks()
    .filter((b) => !matches(b.body, DESTRUCTIVE))
    .filter((b) => served.get(b.name)?.destructiveHint === true)
    .map((b) => b.name);
  assert.deepEqual(overstated, [], `these tools claim to be destructive and mutate nothing: ${overstated.join(", ")}`);
  for (const [name, hints] of served) {
    if (hints?.readOnlyHint) assert.equal(hints.destructiveHint, false, `${name} is read-only and cannot be destructive`);
  }
});

test("an unknown tool fails CLOSED rather than claiming to be safe", () => {
  const unknown = hintsFor("a_tool_that_does_not_exist");
  assert.equal(unknown.readOnlyHint, false, "a tool with no entry must not be advertised as read-only");
  assert.equal(unknown.destructiveHint, true);
  // The protocol's own defaults, stated: repeatable effects, an open world.
  assert.equal(unknown.idempotentHint, false, "a tool with no entry must not be advertised as safe to repeat");
  assert.equal(unknown.openWorldHint, true, "a tool with no entry must not be advertised as closed world");
  // A name on the prototype chain must not resolve to an entry.
  const constructorLookup = hintsFor("constructor");
  assert.equal(typeof constructorLookup, "object");
  assert.equal(constructorLookup.readOnlyHint, false);
  assert.equal(constructorLookup.destructiveHint, true);
  assert.equal(constructorLookup.idempotentHint, false);
  assert.equal(constructorLookup.openWorldHint, true);
});

// idempotentHint and openWorldHint.
//
// The protocol reads an omitted idempotentHint as false and an omitted openWorldHint
// as true, and the constructors in src/tool-annotations.ts default to the same so an
// entry written the old way still compiles. A default is not a decision, so every
// entry must state both.

test("PLANT: every hint table entry states idempotent and openWorld explicitly", () => {
  const text = sourceFile("tool-annotations.ts");
  const start = text.indexOf("export const TOOL_HINTS");
  assert.ok(start !== -1, "TOOL_HINTS was not found in src/tool-annotations.ts");
  const table = text.slice(start, text.indexOf("\n};", start));
  const entries = [...table.matchAll(/^\s+([a-z_]+): (read|additive|destructive)\(([^)]*)\),$/gm)];
  // Vacuity: the parse found every entry, or an unparsed entry would pass unread.
  assert.equal(entries.length, Object.keys(TOOL_HINTS).length, `parsed ${entries.length} entries from the source, the table has ${Object.keys(TOOL_HINTS).length}`);
  const unstated = entries
    .filter(([, , , args]) => !/\bidempotent: (true|false)\b/.test(args) || !/\bopenWorld: (true|false)\b/.test(args))
    .map(([, name]) => name);
  assert.deepEqual(unstated, [], `these entries leave idempotent or openWorld to a default: ${unstated.join(", ")}`);
});

test("PLANT: every read-only tool is served as idempotent", async () => {
  const served = await servedAnnotations();
  const readOnly = [...served].filter(([, hints]) => hints?.readOnlyHint === true);
  assert.ok(readOnly.length >= 10, `only ${readOnly.length} read-only tools served; the split is broken`);
  const wrong = readOnly.filter(([, hints]) => hints?.idempotentHint !== true).map(([name]) => name);
  assert.deepEqual(wrong, [], `these read-only tools are not served as idempotent: ${wrong.join(", ")}`);
});

// openWorldHint: true iff the handler reaches GitHub or Cloudflare.
//
// DIRECT, not transitive: a block is open world when it calls a name its own file
// imports from src/github* or src/ops-cloudflare.ts. A transitive scan disagreed with
// the table twice, so a call made through another module is named below with its
// reason instead of inferred.

const OUTSIDE_MODULE = /^(?:\.\.?\/)+(?:github(?:\/[\w-]+)?|ops-cloudflare)$/;

// Exports of those modules that never leave the Worker. Each is checked below to
// be defined there and to contain no fetch, so an entry cannot outlive its reason.
const NOT_NETWORK: Record<string, string> = {
  parseReposList: "parses the repos argument register_namespace and update_namespace take",
  requireSinglePrimary: "checks a parsed repos list for exactly one primary",
  resolveRepo: "reads the namespaces table in D1",
};

// Tools that reach GitHub through another module. `via` is the call the block makes,
// and `evidence` is where that module reaches GitHub, so a stale entry fails.
const OPEN_WORLD_THROUGH: Record<string, { reason: string; via: RegExp; evidence: Array<{ file: string; pattern: RegExp }> }> = {
  jobs: {
    reason: "complete and fail check their evidence against GitHub, and start_seat sends a repository dispatch",
    via: /\b(?:completeJob|startSeatSession)\(/,
    evidence: [
      { file: "jobs-holder.ts", pattern: /\bverifyEvidence\(/ },
      { file: "job-outcomes.ts", pattern: /\bghFetch\(/ },
      { file: "seat-start.ts", pattern: /\bghFetch\(/ },
    ],
  },
  improve_run: {
    reason: "run advances open runs, which dispatches workflows and opens pull requests",
    via: /\bimproveRunManual\(/,
    evidence: [
      { file: "improve-run.ts", pattern: /\btickRuns\(/ },
      { file: "improve/tick.ts", pattern: /\bdispatchWorkflow\(/ },
    ],
  },
};

// The names a file imports, as values, from src/github* or src/ops-cloudflare.ts.
function outsideImports(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    if (m[1] || !OUTSIDE_MODULE.test(m[3])) continue;
    for (const spec of m[2].split(",")) {
      const s = spec.trim();
      if (!s || s.startsWith("type ")) continue;
      const local = s.split(/\s+as\s+/).pop() ?? s;
      if (!Object.hasOwn(NOT_NETWORK, local)) names.add(local);
    }
  }
  return names;
}

function callsOutsideDirectly(block: { body: string; file: string }): boolean {
  const names = outsideImports(sourceFile(block.file));
  return [...names].some((n) => new RegExp(`\\b${n}\\(`).test(block.body));
}

test("PLANT: openWorldHint is served true exactly for the tools that reach GitHub or Cloudflare", async () => {
  const served = await servedAnnotations();
  const blocks = toolBlocks();
  const direct = blocks.filter(callsOutsideDirectly).map((b) => b.name);
  // Vacuity: the thirteen repo tools and lint call GitHub directly.
  assert.ok(direct.length >= 14, `the direct scan found only ${direct.length} open-world tools; it is broken`);
  const expected = new Set([...direct, ...Object.keys(OPEN_WORLD_THROUGH)]);
  const understated = [...served].filter(([name, h]) => expected.has(name) && h?.openWorldHint !== true).map(([n]) => n);
  const overstated = [...served].filter(([name, h]) => !expected.has(name) && h?.openWorldHint !== false).map(([n]) => n);
  assert.deepEqual(understated, [], `these tools reach GitHub or Cloudflare and are not served as open world: ${understated.join(", ")}`);
  assert.deepEqual(overstated, [], `these tools reach neither and are not served as closed world: ${overstated.join(", ")}`);
  // Both sides populated, or the equality above compared nothing.
  assert.ok(expected.size < served.size, "every tool is open world, so the closed side of the rule is untested");
});

test("PLANT: each open-world override is still needed and still true", () => {
  const blocks = new Map(toolBlocks().map((b) => [b.name, b]));
  for (const [tool, { reason, via, evidence }] of Object.entries(OPEN_WORLD_THROUGH)) {
    const block = blocks.get(tool);
    assert.ok(block, `${tool} is an override with no registration`);
    assert.equal(callsOutsideDirectly(block), false, `${tool} now calls GitHub directly; drop its override (${reason})`);
    assert.match(block.body, via, `${tool} no longer makes the call its override names (${reason})`);
    for (const { file, pattern } of evidence) {
      assert.match(sourceFile(file), pattern, `src/${file} no longer shows ${pattern}, so the ${tool} override's reason is stale (${reason})`);
    }
  }
});

test("PLANT: every name exempted as not network is defined in an outside module and makes no fetch", () => {
  const files = sourceFiles().filter((f) => /^(?:github(?:\/[\w-]+)?|ops-cloudflare)\.ts$/.test(f.name));
  assert.ok(files.length >= 2, `found ${files.length} github or ops-cloudflare modules; the walk is broken`);
  for (const [name, reason] of Object.entries(NOT_NETWORK)) {
    const home = files.find((f) => new RegExp(`^export (?:async )?function ${name}\\(`, "m").test(f.text));
    assert.ok(home, `${name} is exempted (${reason}) but no github or ops-cloudflare module defines it`);
    const start = home.text.search(new RegExp(`^export (?:async )?function ${name}\\(`, "m"));
    const end = home.text.indexOf("\n}\n", start);
    const body = home.text.slice(start, end === -1 ? undefined : end);
    assert.doesNotMatch(body, /\b(?:fetch|ghFetch|cfGet)\(/, `${name} is exempted as not network (${reason}) and now makes a request`);
  }
});

// idempotentHint for writes: a table, one reason per tool. A read-only tool is
// idempotent by the test above; every tool behind the write gate is here, and the
// served hint must match.
const WRITE_IDEMPOTENCE: Record<string, { idempotent: boolean; reason: string }> = {
  write: { idempotent: false, reason: "append adds again, and every overwrite snapshots a new version" },
  delete: { idempotent: true, reason: "a repeat finds nothing to delete and is refused" },
  move: { idempotent: true, reason: "a repeat finds nothing at the source path and is refused" },
  restore: { idempotent: false, reason: "each restore snapshots the live body first, adding a version" },
  lint: { idempotent: false, reason: "a second report the same day snapshots the first" },
  register_namespace: { idempotent: false, reason: "a repeat is refused, but the create is an INSERT the scan below cannot tell from a repeating one" },
  update_namespace: { idempotent: true, reason: "sets the mapping to the value given; a repeat sets the same mapping" },
  write_repo_file: { idempotent: false, reason: "every call is a new commit, or a new pull request in pr mode" },
  create_branch: { idempotent: true, reason: "GitHub refuses a branch that exists" },
  open_pr: { idempotent: false, reason: "after the first is closed or merged, a repeat opens another" },
  delete_repo_file: { idempotent: true, reason: "a repeat finds the file gone and is refused" },
  manage_pr: { idempotent: false, reason: "comment posts a new comment on every call" },
  delete_branch: { idempotent: true, reason: "a repeat finds the branch gone and is refused" },
  ci_dispatch: { idempotent: false, reason: "every call starts a new workflow run" },
  improve_run: { idempotent: false, reason: "run advances runs a step; mint_operator_key issues a new key" },
  jobs: { idempotent: false, reason: "post creates a job on every call" },
  agents: { idempotent: false, reason: "mint issues a new credential on every call" },
  claims: { idempotent: true, reason: "the handler only reads" },
  ops_snapshot: { idempotent: true, reason: "the handler only reads one KV value" },
};

// What creates something new on every call, matched in the block by what it does. An
// audit_log row records a call and is not state the tool acts on, so it is left out:
// delete writes one and a repeat is refused before it does.
const NEW_EACH_CALL = [
  /\bciDispatch\(/,
  /\bopenPr\(/,
  /\bwriteRepoFile\(/,
  /\bmanagePr\(/,
  /\bmintAgent\(/,
  /\bpostJob\(/,
  /\bimproveRunManual\(/,
];

// An INSERT into anything but audit_log with no ON CONFLICT, read up to the end of
// its SQL string literal.
const insertsFresh = (body: string) =>
  [...body.matchAll(/INSERT INTO\s+(\w+)[^`"]*/g)].some((m) => m[1] !== "audit_log" && !/ON CONFLICT/i.test(m[0]));

test("PLANT: every write-gated tool has an idempotence entry with a reason, and is served with it", async () => {
  const served = await servedAnnotations();
  const gated = [...served.keys()].filter(isWriteGated).sort();
  assert.deepEqual(Object.keys(WRITE_IDEMPOTENCE).sort(), gated, "a write-gated tool without an entry, or an entry for a tool that is not write-gated, fails here");
  const wrong = gated
    .filter((name) => served.get(name)?.idempotentHint !== WRITE_IDEMPOTENCE[name].idempotent)
    .map((name) => `${name}: served ${served.get(name)?.idempotentHint}, table ${WRITE_IDEMPOTENCE[name].idempotent} (${WRITE_IDEMPOTENCE[name].reason})`);
  assert.deepEqual(wrong, [], wrong.join("; "));
  for (const [name, { reason }] of Object.entries(WRITE_IDEMPOTENCE)) assert.ok(reason.trim().length > 0, `${name} has no reason`);
});

test("PLANT: no tool that creates something new on every call is served as idempotent", async () => {
  const served = await servedAnnotations();
  const creators = toolBlocks().filter((b) => matches(b.body, NEW_EACH_CALL) || insertsFresh(b.body));
  assert.ok(creators.length >= 8, `the scan found only ${creators.length} tools that create on every call; it is broken`);
  const overstated = creators.filter((b) => served.get(b.name)?.idempotentHint !== false).map((b) => b.name);
  assert.deepEqual(overstated, [], `these tools create something on every call and claim to be idempotent: ${overstated.join(", ")}`);
});
