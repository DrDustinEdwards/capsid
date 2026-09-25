import assert from "node:assert/strict";
import { test } from "node:test";
import { workflowWriteRefusal, writeRepoFile, deleteRepoFile } from "../src/github.ts";
import { improveWriteRefusal } from "../src/improve-scores.ts";
import { RUN_TASK_PREFIX } from "../src/improve-schema.ts";
import { fakeEnv, fakeKv, withFetch } from "./fakes.ts";
import { sourceFile, toolBlocks } from "./source-files.ts";

// ENUMERATE EVERY SITE, audit 2026-09-07 (Opus MAJOR 5.4 and NOTE 6.1).
//
// Two guards, one failure mode. `improveWriteRefusal` shipped with exactly ONE
// call site, the `write` tool, so `move` and `restore` walked straight past it;
// nothing asserted which handlers called it, so nothing went red. That is the
// class capsid/conventions.md names: "A fix that lands in all but one affected
// site is not a fix", and "Where the sites are enumerable in source, add a test
// that fails when a NEW one appears".
//
// test/path-mutation.test.ts already does this for pathMutation. This file does
// it for the two guards that did not have it, and it is DERIVED: it finds the
// mutation entry points by scanning for what makes a handler a mutation, not by
// listing the four that exist today. A sixth tool that writes `documents` is a
// build failure the day it is added, whether or not anyone remembers this file.

// A handler mutates the document store if it inserts a documents row or calls the
// one path-mutation helper. Matched by SHAPE rather than by tool name, so the
// next mutation is caught by what it does.
const MUTATION_MARKERS = [/INSERT INTO documents/i, /\bdocumentUpsert\(/, /\bpathMutation\(/];

function mutationTools() {
  return toolBlocks().filter((t) => MUTATION_MARKERS.some((re) => re.test(t.body)));
}

// write, restore, delete and move reach both guards through one helper in
// src/tools/docs.ts (audit 2026-09-25, E1-21). A tool body calling it counts as
// calling both, and the helper itself is checked to call both.
const HELPER_CALL = /\bimprovePathsRefusal\(/;
function helperBody(): string {
  const docs = sourceFile("tools/docs.ts");
  const start = docs.indexOf("async function improvePathsRefusal(");
  assert.ok(start >= 0, "improvePathsRefusal is gone from src/tools/docs.ts; update this file");
  return docs.slice(start, docs.indexOf("\n}\n", start));
}

// scanner-rule: audit 2026-09-13 finding C1, every opt-in is scoped to can_touch_protected (the helper the four tools share)
test("the helper asks for can_touch_protected and runs the control-surface guard", () => {
  const body = helperBody();
  assert.match(body, /flags: IMPROVE_OVERRIDE_FLAGS/);
  assert.match(body, /improveWriteRefusal\(/);
  assert.match(body, /allowImprovePaths === true/, "the helper must read the caller's opt-in, not a literal");
});

// scanner-rule: conventions-verification, enumerate every site (audit 2026-09-07) (count guard)
test("the scan finds the mutation entry points at all, so this file cannot pass by reading nothing", () => {
  const found = mutationTools().map((t) => t.name).sort();
  assert.ok(found.length >= 4, `the mutation scan found ${found.length} tools; the walk is broken`);
  // Named so a tool DISAPPEARING from the mutation set is also visible: that
  // would mean it stopped mutating, or the marker stopped matching it.
  assert.deepEqual(found, ["delete", "lint", "move", "restore", "write"]);
});

// scanner-rule: conventions-verification, enumerate every site (audit 2026-09-07)
test("PLANT: every document mutation entry point calls improveWriteRefusal", () => {
  const unguarded = mutationTools()
    .filter((t) => !/improveWriteRefusal\(/.test(t.body) && !HELPER_CALL.test(t.body))
    .map((t) => t.name);
  assert.deepEqual(
    unguarded,
    [],
    "a tool can change the document store without consulting the improve control-surface guard. " +
      "That is how move and restore let a caller install a run prompt or a skill with no flag and no marked audit row."
  );
});

// scanner-rule: conventions-verification, enumerate every site (audit 2026-09-07)
test("every guarded mutation reads its opt-in from the caller, except the one that has none", () => {
  // The flag has to be plumbed, not just referenced: a handler that calls the
  // guard with a hardcoded `true` would pass the test above and guard nothing.
  for (const tool of mutationTools()) {
    if (tool.name === "lint") {
      // finalize deliberately has NO opt-in: archiving the loop's control surface
      // is never right, so it passes `false` and cannot be talked out of it.
      assert.match(tool.body, /improveWriteRefusal\([\s\S]{0,200}?false\)/, "lint finalize must pass false");
      assert.ok(!/allow_improve_paths/.test(tool.body), "lint must not grow an opt-in");
      continue;
    }
    assert.match(
      tool.body,
      /allow_improve_paths: z\.boolean\(\)\.optional\(\)/,
      `${tool.name} calls the guard but does not accept allow_improve_paths`
    );
    assert.match(
      tool.body,
      new RegExp(`improvePathsRefusal\\(ctx, "${tool.name}", namespace, allow_improve_paths,`),
      `${tool.name} must pass the caller's opt-in and its own tool name through the helper, not a literal`
    );
  }
});

// scanner-rule: audit 2026-09-13 finding C1, every opt-in is scoped to can_touch_protected
test("PLANT: every mutation that accepts the opt-in scopes it to can_touch_protected", () => {
  // AUDIT 2026-09-13, FINDING C1, and the same class as the test above it. The
  // override shipped on write, then restore; delete and move accepted
  // allow_improve_paths and honoured it without ever asking ctx.scope for the flag
  // that is supposed to bound it. The opt-in is the CALLER's to pass, so a boolean
  // the caller sets is not a permission: the flag is.
  //
  // Derived, not listed: any tool that grows an opt-in has to scope it the day it
  // is added, whether or not anyone remembers this file.
  const unscoped = mutationTools()
    .filter((t) => t.body.includes("allow_improve_paths: z.boolean().optional()"))
    .filter((t) => !t.body.includes("flags: IMPROVE_OVERRIDE_FLAGS") && !HELPER_CALL.test(t.body))
    .map((t) => t.name);
  assert.deepEqual(
    unscoped,
    [],
    "a tool honours allow_improve_paths without asking for can_touch_protected. " +
      "That is how a driver holding write and not one flag could delete or move the loop's own run prompt."
  );
});

// scanner-rule: conventions-verification, enumerate every site (audit 2026-09-07) (count guard)
test("the opt-in scan sees the tools it claims to, so it cannot pass by reading nothing", () => {
  const withOptIn = mutationTools()
    .filter((t) => t.body.includes("allow_improve_paths: z.boolean().optional()"))
    .map((t) => t.name)
    .sort();
  // lint is absent on purpose: finalize has no opt-in and must never grow one.
  assert.deepEqual(withOptIn, ["delete", "move", "restore", "write"]);
});

// ---- the guard itself, at both ends of a move ------------------------------

test("PLANT: a move INTO the improve control surface is refused", async () => {
  // Installing a skill this way was the live bypass: skills are re-injected into
  // other namespaces' runs.
  assert.ok(await improveWriteRefusal("capsid", "improve/skills/planted.md", null, "body", false));
  assert.ok(await improveWriteRefusal("capsid", "improve/prompts/run.md", null, "body", false));
  assert.ok(await improveWriteRefusal("capsid", `${RUN_TASK_PREFIX}2026-09-08.md`, null, "body", false));
});

test("PLANT: a move OUT of the improve control surface is refused", async () => {
  // The source path ends up empty, which for scores.md is an anchor block going
  // from something to nothing, and for the prefixes is a prefix match.
  assert.ok(await improveWriteRefusal("capsid", "improve/prompts/run.md", "the prompt", "", false));
  assert.ok(
    await improveWriteRefusal("capsid", "improve/scores.md", "## Anchors\n\n- build_passes: required\n", "", false),
    "emptying scores.md changes its anchor block and must be refused"
  );
});

test("an ordinary move is untouched at both ends", async () => {
  assert.equal(await improveWriteRefusal("capsid", "notes/a.md", "x", "", false), null);
  assert.equal(await improveWriteRefusal("capsid", "notes/b.md", null, "x", false), null);
  assert.equal(await improveWriteRefusal("capsid", "improve/archive/r1/a1.md", null, "x", false), null);
});

// ---- .github/workflows/ ----------------------------------------------------

test("PLANT: a write-grant key cannot author a workflow without the flag", async () => {
  const env = fakeEnv({
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => ({ repos: JSON.stringify([{ repo: "owner/repo", label: "primary" }]) }) }),
      }),
    },
    APP_KV: fakeKv({ seedToken: true }).kv,
  });
  await withFetch({}, async (calls) => {
    await assert.rejects(
      () => writeRepoFile(env, "ns", ".github/workflows/evil.yml", "on: push", "m", "direct", "main"),
      /allow_workflow_write/,
      "a workflow is code CI executes with the repo's secrets in scope"
    );
    await assert.rejects(
      () => deleteRepoFile(env, "ns", ".github/workflows/ci.yml", "m", "direct", "main"),
      /allow_workflow_write/,
      "deleting a workflow is a CI change too"
    );
    assert.equal(calls.length, 0, "the refusal must cost no GitHub round trip");
  });
});

test("the workflow refusal cannot be walked around by path spelling", () => {
  for (const path of [
    ".github/workflows/x.yml",
    ".github/workflows/nested/x.yml",
    "./.github/workflows/x.yml",
    ".github//workflows/x.yml",
  ]) {
    assert.ok(workflowWriteRefusal(path, false), `${path} must be refused`);
    assert.ok(workflowWriteRefusal(path, undefined), `${path} must be refused when the flag is absent`);
  }
});

test("the flag opens it, and ordinary paths were never closed", () => {
  assert.equal(workflowWriteRefusal(".github/workflows/x.yml", true), null);
  for (const path of ["src/index.ts", ".github/dependabot.yml", ".github/ISSUE_TEMPLATE/bug.md", "workflows/x.yml"]) {
    assert.equal(workflowWriteRefusal(path, false), null, `${path} is not a workflow and must stay writable`);
  }
});

test("the opt-in is returned, so guardedWrite files it into audit_log", async () => {
  // guardedWrite writes the whole result into audit_log.params, so a workflow authored
  // or removed through the repo tools is greppable afterwards only if the flag is on
  // the result. An ordinary write carries no flag.
  const env = fakeEnv({
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => ({ repos: JSON.stringify([{ repo: "owner/repo", label: "primary" }]) }) }),
      }),
    },
    APP_KV: fakeKv({ seedToken: true }).kv,
  });
  const file = (path: string) => ({
    [`GET /repos/owner/repo/contents/${path}`]: { body: { sha: "old" } },
    [`PUT /repos/owner/repo/contents/${path}`]: { body: { content: { sha: "new" }, commit: { sha: "c1" } } },
    [`DELETE /repos/owner/repo/contents/${path}`]: { body: { commit: { sha: "c2" } } },
  });
  await withFetch(
    { "GET /repos/owner/repo": { body: { default_branch: "main" } }, ...file(".github/workflows/x.yml"), ...file("src/x.ts") },
    async () => {
      const wrote = await writeRepoFile(env, "ns", ".github/workflows/x.yml", "on: push", "m", "direct", "main", undefined, true);
      const removed = await deleteRepoFile(env, "ns", ".github/workflows/x.yml", "m", "direct", "main", undefined, true);
      const ordinary = await writeRepoFile(env, "ns", "src/x.ts", "x", "m", "direct", "main");
      assert.equal((wrote as { allow_workflow_write?: boolean }).allow_workflow_write, true, "a workflow write does not report its flag");
      assert.equal((removed as { allow_workflow_write?: boolean }).allow_workflow_write, true, "a workflow delete does not report its flag");
      assert.equal(Object.hasOwn(ordinary, "allow_workflow_write"), false, "an ordinary write reports a flag it did not use");
    }
  );
});
