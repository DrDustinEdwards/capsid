import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { RENAMED_ACTIONS, addedToolsAxis, newToolsAxis, OLD_ACTIONS_OF, OLD_TOOLS, prunedToolsAxis, RENAMED, rewriteProse, SIMPLE, SPLIT, unsignedBody } from "../scripts/tool-names-lib.mjs";
import { migrateAxes, migrateProse, parseArgs } from "../scripts/migrate-tool-names.mjs";
import { COMPOSITES, SINGLE_TOOLS, CAPSID_TOOLS, CAPSID_ADMIN_TOOLS } from "../src/tools/surface.ts";
import { TOOL_GRANTS } from "../src/scope.ts";

// The MCP 4 data migration's rules (scripts/tool-names-lib.mjs) and its script
// (scripts/migrate-tool-names.mjs), with a fake Worker. Nothing here reaches a network.

const served = new Map<string, Set<string> | null>();
for (const spec of COMPOSITES) served.set(spec.name, new Set(Object.keys(spec.actions)));
for (const name of Object.keys(SINGLE_TOOLS)) served.set(name, null);

test("every mapping target is a served tool and action, so no migrated entry names nothing", () => {
  const targets: Array<[string, string | null]> = [
    ...Object.values(SIMPLE),
    ...Object.values(SPLIT).flatMap((actions) => Object.values(actions)),
    ...Object.values(RENAMED).map((tool): [string, null] => [tool, null]),
  ];
  assert.ok(targets.length >= 40, `only ${targets.length} targets`);
  for (const [tool, action] of targets) {
    assert.ok(served.has(tool), `${tool} is not served`);
    if (action === null) continue;
    const actions = served.get(tool);
    assert.ok(actions, `${tool} takes no action, and the mapping names ${action}`);
    assert.ok(actions.has(action), `${tool} does not serve action ${action}`);
  }
});

test("every served tool is reached from some old tool, except the two this regroup added", () => {
  const reached = new Set(Object.keys(OLD_ACTIONS_OF));
  const added = [...served.keys()].filter((t) => !reached.has(t)).sort();
  assert.deepEqual(added, ["capsid_admin_set_site_key", "capsid_admin_whats_next"]);
  assert.equal(CAPSID_TOOLS.length + CAPSID_ADMIN_TOOLS.length, Object.keys(TOOL_GRANTS).length);
  assert.equal(new Set(OLD_TOOLS).size, OLD_TOOLS.length, "an old tool is mapped twice");
  assert.equal(OLD_TOOLS.length, 37, "the old surface served 37 tools");
});

test("the three role lists mint-agents used come out as the new roles name them", () => {
  assert.deepEqual(newToolsAxis(["jobs", "jobs.post"]), ["capsid_work_jobs", "capsid_work_jobs.post"]);
  // The reviewer may comment; merge and close were never its, and close_pr is not granted.
  assert.deepEqual(newToolsAxis(["manage_pr", "manage_pr.comment"]), ["capsid_open_pr", "capsid_open_pr.comment"]);
  // The live probe's read is the read action, not the versions or links it never had.
  assert.deepEqual(newToolsAxis(["read"]), ["capsid_read_doc", "capsid_read_doc.read"]);
});

test("PLANT: a narrowed old tool stays narrowed; no migration widens an agent", () => {
  assert.deepEqual(newToolsAxis(["improve_run", "improve_run.claim"]), ["capsid_run_improve", "capsid_run_improve.claim"]);
  // A qualified entry without its bare tool granted nothing before, and grants nothing now.
  assert.deepEqual(newToolsAxis(["jobs.post"]), []);
  // improve_run bare never included improve_status.
  assert.deepEqual((newToolsAxis(["improve_run"]) as string[]).filter((e) => e.startsWith("capsid_run_improve")), ["capsid_run_improve", "capsid_run_improve.claim", "capsid_run_improve.run"]);
});

test("THE INNOCENT DIRECTION: every old action of a new tool granted is the whole tool", () => {
  assert.deepEqual(newToolsAxis(["list", "find", "search", "namespaces"]), ["capsid_find_docs"]);
  assert.deepEqual(newToolsAxis(["repo_refs", "repo_history", "ci_status"]), ["capsid_inspect_repo"]);
  assert.deepEqual(newToolsAxis(["manage_pr", "delete_branch", "open_pr"]), ["capsid_open_pr", "capsid_close_pr"]);
  assert.equal(newToolsAxis("*"), "*");
});

test("add keeps the old names beside the new, prune removes them, and prune refuses before add", () => {
  const old = ["read", "jobs", "jobs.post"];
  const added = addedToolsAxis(old);
  assert.deepEqual(added, ["read", "jobs", "jobs.post", "capsid_read_doc", "capsid_read_doc.read", "capsid_work_jobs", "capsid_work_jobs.post"]);
  assert.deepEqual(addedToolsAxis(added), added, "add is not idempotent");
  assert.deepEqual(prunedToolsAxis(added), ["capsid_read_doc", "capsid_read_doc.read", "capsid_work_jobs", "capsid_work_jobs.post"]);
  assert.throws(() => prunedToolsAxis(old), /the add phase has not run/);
  assert.equal(prunedToolsAxis("*"), "*");
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
  const r = rewriteProse(["```", "node scripts/mint-agents.mjs --apply", "```"].join("\n"));
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

test("a signed body loses its signature before the edit re-signs it", () => {
  assert.equal(unsignedBody(`---\ncapsid-task-signature: ${"a".repeat(64)}\n---\nCall \`read\`.`), "Call `read`.");
  assert.equal(unsignedBody("no signature"), "no signature");
});

test("parseArgs: dry run by default, add against the old surface, prose and prune only against the new", () => {
  assert.deepEqual(parseArgs(["--phase", "add"]), { apply: false, phase: "add", surface: "old" });
  assert.deepEqual(parseArgs(["--phase", "prune", "--apply"]), { apply: true, phase: "prune", surface: "new" });
  assert.throws(() => parseArgs(["--phase", "prose", "--surface", "old"]), /new Worker only/);
  assert.throws(() => parseArgs([]), /--phase/);
});

function fakeWorker(state: { agents?: unknown[]; jobs?: Array<{ id: string; status: string; body: string }>; docs?: Record<string, { title: string; body: string }> }) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tool = async (name: string, args: object) => {
    const a = args as Record<string, unknown>;
    calls.push({ name, args: a });
    if (name === "agents" || name === "capsid_admin_manage_agents") return JSON.stringify(a.action === "list" ? { agents: state.agents } : { ok: true });
    if (name === "capsid_work_jobs") {
      if (a.action === "list" && a.id) return JSON.stringify({ jobs: (state.jobs ?? []).filter((j) => j.id === a.id) });
      if (a.action === "list") return JSON.stringify({ jobs: (state.jobs ?? []).filter((j) => j.status === a.status).map(({ id, status }) => ({ id, status })) });
      return "{}";
    }
    if (name === "capsid_find_docs" && a.action === "namespaces") return JSON.stringify([{ namespace: "sample" }]);
    if (name === "capsid_find_docs") {
      const prefix = String(a.glob).split("*")[0];
      return JSON.stringify({ documents: Object.keys(state.docs ?? {}).filter((k) => k.startsWith(`${a.namespace}/${prefix}`)).map((k) => ({ path: k.slice(String(a.namespace).length + 1) })) });
    }
    if (name === "capsid_read_doc") {
      const doc = state.docs?.[`${a.namespace}/${a.path}`];
      if (!doc) throw new Error(`capsid_read_doc refused: not found: ${a.namespace}/${a.path}`);
      return JSON.stringify(doc);
    }
    return "{}";
  };
  return { tool, calls, writes: () => calls.filter((c) => c.args.action === "update_scopes" || c.args.action === "edit" || c.name === "capsid_write_doc") };
}

test("PLANT: a dry run writes nothing; --apply writes each change once, and skips revoked agents", async () => {
  const agents = [
    { name: "watcher", revoked_at: null, scopes: { tools: ["jobs", "jobs.post"] } },
    { name: "gone", revoked_at: "2026-09-01", scopes: { tools: ["read"] } },
    { name: "admin-ish", revoked_at: null, scopes: { tools: "*" } },
  ];
  const lines: string[] = [];
  const dry = fakeWorker({ agents });
  assert.equal(await migrateAxes(dry.tool, "old", "add", false, (l) => lines.push(l)), 1);
  assert.equal(dry.writes().length, 0);
  assert.equal(dry.calls[0].name, "agents");
  const wet = fakeWorker({ agents });
  await migrateAxes(wet.tool, "old", "add", true, () => {});
  assert.deepEqual(wet.writes(), [{ name: "agents", args: { action: "update_scopes", name: "watcher", tools: ["jobs", "jobs.post", "capsid_work_jobs", "capsid_work_jobs.post"] } }]);
});

test("prose: a job body is rewritten unsigned for the edit to sign, and a doc write is guarded on the body read", async () => {
  const signed = `---\ncapsid-task-signature: ${"b".repeat(64)}\n---\nCall \`brief\`.`;
  const core = "Call `read` first.";
  const w = fakeWorker({
    jobs: [{ id: "job_aaaaaaaaaaaa", status: "queued", body: signed }],
    docs: { "sample/core.md": { title: "Core", body: core }, "sample/improve/skills/s1.md": { title: "Skill", body: "Plain prose." } },
  });
  await migrateProse(w.tool, true, () => {});
  const writes = w.writes();
  assert.deepEqual(writes[0], { name: "capsid_work_jobs", args: { action: "edit", id: "job_aaaaaaaaaaaa", body: "Call `capsid_start_session`." } });
  assert.equal(writes[1].name, "capsid_write_doc");
  assert.equal(writes[1].args.body, "Call `capsid_read_doc` first.");
  assert.equal(writes[1].args.if_match, createHash("sha256").update(core).digest("hex"));
  assert.equal(writes.length, 2, "an unchanged skill was written");
});
