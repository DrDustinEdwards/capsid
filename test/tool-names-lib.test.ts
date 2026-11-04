import assert from "node:assert/strict";
import { test } from "node:test";
import { RENAMED_ACTIONS, RENAMED, rewriteProse, SIMPLE, SPLIT } from "../scripts/tool-names-lib.ts";
import { COMPOSITES, SINGLE_TOOLS } from "../src/tools/surface.ts";

// The MCP 4 regroup's name mapping and prose reading (scripts/tool-names-lib.ts), which
// the rule docs lint uses.

const served = new Map<string, Set<string> | null>();
for (const spec of COMPOSITES) served.set(spec.name, new Set(Object.keys(spec.actions)));
for (const name of Object.keys(SINGLE_TOOLS)) served.set(name, null);

// Targets whose actions were removed after the regroup; the map keeps them so prose
// naming the old tool still reads as stale.
const RETIRED = new Set([
  "capsid_run_improve.run",
  "capsid_run_improve.claim",
  "capsid_admin_control_improve.mode",
  "capsid_admin_control_improve.pause",
  "capsid_admin_control_improve.unpause",
  "capsid_admin_control_improve.budget",
  "capsid_admin_control_improve.register_skill",
]);
// Whole tools removed after the regroup (Dustin, 2026-10-31), kept for the same reason.
const RETIRED_TOOLS = new Set(["capsid_change_repo", "capsid_open_pr", "capsid_run_ci"]);

test("every mapping target is a served tool and action, so no migrated entry names nothing", () => {
  const targets: Array<[string, string | null]> = [
    ...Object.values(SIMPLE),
    ...Object.values(SPLIT).flatMap((actions) => Object.values(actions)),
    ...Object.values(RENAMED).map((tool): [string, null] => [tool, null]),
  ];
  assert.ok(targets.length >= 40, `only ${targets.length} targets`);
  for (const [tool, action] of targets) {
    if (RETIRED_TOOLS.has(tool)) continue;
    assert.ok(served.has(tool), `${tool} is not served`);
    if (action === null || RETIRED.has(`${tool}.${action}`)) continue;
    const actions = served.get(tool);
    assert.ok(actions, `${tool} takes no action, and the mapping names ${action}`);
    assert.ok(actions.has(action), `${tool} does not serve action ${action}`);
  }
});

test("prose: tool-call contexts are rewritten", () => {
  const r = rewriteProse(
    [
      "Call `read` on capsid/core.md, then `list_repo_tree` for the layout.",
      "Post it with `jobs.post`, or merge with `manage_pr action merge`.",
      "Then call improve_status(namespace) and `write(namespace, path)`.",
      "Then `improve_run()` runs one.",
    ].join("\n")
  );
  assert.deepEqual(r.text.split("\n"), [
    "Call `capsid_read_doc` on capsid/core.md, then `capsid_read_repo` action `tree` for the layout.",
    "Post it with `capsid_work_jobs.post`, or merge with `capsid_close_pr` action `merge`.",
    "Then call capsid_run_improve(namespace) and `capsid_write_doc(namespace, path)`.",
    "Then `capsid_run_improve(action: \"run\")` runs one.",
  ]);
  assert.equal(r.changes.length, 4);
});

test("PLANT: prose that is not a tool call is left alone", () => {
  const text = [
    "A read-only caller holds the `read` grant, and the `write` grant writes.",
    "The `jobs` table holds the queue. We read the list and search it.",
    "items.list(x) and list.map(f) are code, not tools.",
    "```",
    "read(namespace, path)",
    "```",
  ].join("\n");
  const r = rewriteProse(text);
  assert.equal(r.text, text);
  assert.deepEqual(r.fenced.map((f) => f.line), [5], "a call in a code block is reported for the seat");
});

test("PLANT: a name that is also a word is rewritten only where the text says it is the tool", () => {
  const text = [
    "through `@modelcontextprotocol/server` 2.0.0 and `agents` 0.24.0.",
    "The gate classes are (`push_branch`, `open_pr`, `additive_migration`).",
    "Scopes have five axes: `namespaces`, `repos`, `tools`.",
    "the replaced version is kept and shown by `list` for that job.",
  ].join("\n");
  const r = rewriteProse(text);
  assert.equal(r.text, text);
  assert.deepEqual(r.ambiguous.map((a) => a.text), ["`agents`", "`open_pr`", "`namespaces`", "`list`"]);
  // The same names where the text says they are tools.
  assert.equal(rewriteProse("the `agents` tool").text, "the `capsid_admin_manage_agents` tool");
  assert.equal(rewriteProse("call `open_pr`").text, "call `capsid_open_pr` action `open`");
  assert.equal(rewriteProse("see `agents.ts`").text, "see `agents.ts`");
});

test("an action named after the span is kept, not doubled", () => {
  assert.equal(rewriteProse("set by `improve_run` action `mode`.").text, "set by `capsid_admin_control_improve` action `mode`.");
  assert.equal(rewriteProse("signed with `improve_run` action `sign_policy`, admin only").text, "signed with `capsid_admin_control_improve` action `sign_policy`, admin only");
  assert.equal(rewriteProse("`jobs` action `post`").text, "`capsid_work_jobs` action `post`");
  assert.equal(rewriteProse("`manage_pr` action \"merge\"").text, "`capsid_close_pr` action `merge`");
});

test("PLANT: an old split tool named with no action it can map is reported, never guessed", () => {
  const r = rewriteProse("Use `manage_pr` here.");
  assert.equal(r.text, "Use `manage_pr` here.");
  assert.equal(r.unmapped.length, 1);
});

test("a split tool whose actions all moved to one new tool is renamed bare; a file name is not a tool", () => {
  assert.equal(rewriteProse("Use `delete_namespace` with preview first.").text, "Use `capsid_admin_manage_namespaces` with preview first.");
  const r = rewriteProse(["```", "node scripts/deploy.mjs --apply", "```"].join("\n"));
  assert.deepEqual(r.fenced, []);
});

test("PLANT: a column is not an action, and a split tool named bare is all of it, so it is reported", () => {
  for (const text of ["copied from `jobs.claimed_by`.", "(`agents.job_id`, migrations/0021)", "`list.limit`"]) assert.equal(rewriteProse(text).text, text);
  const r = rewriteProse("the others `improve_run` writes");
  assert.equal(r.text, "the others `improve_run` writes");
  assert.equal(r.unmapped.length, 1);
});

test("the renamed tools' action lists are the ones src serves", async () => {
  const { JOB_ACTIONS } = await import("../src/jobs-schema.ts");
  assert.deepEqual([...RENAMED_ACTIONS.jobs].sort(), [...JOB_ACTIONS].sort());
});

test("PLANT: rewriting is idempotent: a second run over rewritten text changes nothing", () => {
  assert.equal(rewriteProse("So does `capsid_close_pr` action `delete_branch` with force.").changes.length, 0);
  assert.equal(rewriteProse("then `capsid_change_repo` action `create_branch`").changes.length, 0);
  assert.equal(rewriteProse("- **Write**: `capsid_change_repo` (actions `write_file`, `delete_file` and `create_branch`), `capsid_close_pr` (actions `merge` and `delete_branch`)").changes.length, 0);
  const once = rewriteProse("Call `read`, then `list_repo_tree`, `delete_branch`, `jobs.post` and `manage_pr` action `merge`.").text;
  assert.equal(rewriteProse(once).changes.length, 0, once);
});
