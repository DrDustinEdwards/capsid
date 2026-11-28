import assert from "node:assert/strict";
import { test } from "node:test";
import { RENAMED, rewriteProse, SIMPLE, SPLIT } from "../scripts/tool-names-lib.ts";
import { COMPOSITES, SINGLE_TOOLS } from "../src/tools/surface.ts";

const served = new Map<string, Set<string> | null>();
for (const spec of COMPOSITES) served.set(spec.name, new Set(Object.keys(spec.actions)));
for (const name of Object.keys(SINGLE_TOOLS)) served.set(name, null);

// Removed after the regroup; the map keeps them so prose naming them still reads as stale.
const RETIRED = new Set(["capsid_read_status.run", "capsid_read_status.claim"]);
const RETIRED_TOOLS = new Set([
  "capsid_change_repo",
  "capsid_open_pr",
  "capsid_run_ci",
  "capsid_work_jobs",
  "capsid_admin_read_claims",
  "capsid_admin_manage_switches",
]);

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
  assert.deepEqual(
    r.fenced.map((f) => f.line),
    [5],
    "a call in a code block is reported for the seat",
  );
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
  assert.deepEqual(
    r.ambiguous.map((a) => a.text),
    ["`agents`", "`open_pr`", "`namespaces`", "`list`"],
  );
  assert.equal(rewriteProse("the `agents` tool").text, "the `capsid_admin_manage_agents` tool");
  assert.equal(rewriteProse("call `open_pr`").text, "call `capsid_open_pr` action `open`");
  assert.equal(rewriteProse("see `agents.ts`").text, "see `agents.ts`");
});

test("PLANT: a column is not an action, and a split tool named bare is all of it, so it is reported", () => {
  for (const text of [
    "copied from `jobs.claimed_by`.",
    "(`agents.job_id`, migrations/0021)",
    "`list.limit`",
  ])
    assert.equal(rewriteProse(text).text, text);
  for (const text of ["the others `improve_run` writes", "Use `manage_pr` here."]) {
    const r = rewriteProse(text);
    assert.equal(r.text, text);
    assert.equal(r.unmapped.length, 1, text);
  }
});
