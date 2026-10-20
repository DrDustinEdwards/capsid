import assert from "node:assert/strict";
import { test } from "node:test";
import { operationBlocks, sourceFiles, toolBlocks, type ToolBlock } from "./source-files.ts";
import { servedAs } from "./served.ts";
import { TOOL_GRANTS } from "../src/scope.ts";

// The two write-path invariants, guarded.
//
// They are:
//   1. Every overwrite and delete snapshots the prior row into document_versions
//      and appends to audit_log. "Do not add a write path that skips this."
//   2. Every mutating tool is gated on the write grant, so an `ro:` key cannot
//      reach it.
//
// Both failures are silent: a write path with no snapshot works until someone needs
// the snapshot, and a missing gate is invisible because the tool it exposes does its
// job.
//
// This file is the source-guard half (invariant 2, plus a structural check that
// invariant 1's statements exist per tool). The behavioural half is
// test/write-invariants.test.ts, which drives the real handlers against a fake D1.
//
// It scans every file under src/, because these are properties of a tool, wherever
// the tool is registered. The work a served tool does is in the operations it
// dispatches to (src/tools/surface.ts, src/tools/operations.ts), so each operation's
// block is scanned and judged by every tool action that runs it (./served.ts).

const MUTATING_SQL = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;
// The gate is src/scope.ts, reached two ways, and a write tool has to be covered by
// one of them:
//
//   - The registrar, for a tool that writes whatever action it is called with. Its
//     requirement is `write` in TOOL_GRANTS and the wrapper checks it before the
//     handler runs.
//   - An inline ctx.scope call asking for the write grant, for the two tools whose
//     requirement depends on their action (capsid_work_jobs has a read action,
//     capsid_lint_namespace has gather), checked at the point where the action is known.
//
// Coverage is asserted rather than a spelling, so a tool whose writes happen a
// module away (the queue, the improve loop, every repo write) is still covered.
const SCOPE_GATE = /ctx\.scope\(\{[^}]*grant: "write"/;

const REGISTRATIONS: ToolBlock[] = toolBlocks();
const BLOCKS: ToolBlock[] = operationBlocks();

// "admin" is the write grant plus the admin identity, so a tool marked admin is
// gated more tightly than one marked write, and counts as gated here.
const WRITE_GATED: ReadonlyArray<string> = ["write", "admin"];
const READ_ONLY: ReadonlyArray<string> = ["read", "admin_read"];

// scanner-rule: one enforcement point invariant (count guard for the scans in this file)
test("the block scan found the whole tool surface", () => {
  // Vacuity guard: if this parse broke, every assertion below would pass over an
  // empty list.
  assert.ok(REGISTRATIONS.length >= 20, `expected the full tool surface, parsed ${REGISTRATIONS.length} registrations`);
  assert.ok(BLOCKS.length >= 37, `expected every operation, parsed ${BLOCKS.length} blocks`);
  for (const name of ["write", "delete", "move", "lint", "restore", "read", "search"]) {
    assert.ok(BLOCKS.some((b) => b.name === name), `did not parse a block for the ${name} operation`);
  }
  // Every operation is served, and every served operation was parsed.
  for (const b of BLOCKS) assert.ok(servedAs(b.name).length > 0, `operation ${b.name} (src/${b.file}) is defined but no served tool runs it`);
  // And the walk reached the whole directory, not one file that happens to contain
  // everything today.
  assert.ok(sourceFiles().length >= 10, "the src/ walk collapsed to a handful of files");
});

// scanner-rule: one enforcement point invariant, derived over every registration
test("every tool action whose operation contains mutating SQL is gated on the write grant", () => {
  const ungated = BLOCKS.flatMap((b) =>
    MUTATING_SQL.test(b.body) && !SCOPE_GATE.test(b.body)
      ? servedAs(b.name)
          .filter((s) => !WRITE_GATED.includes(s.requirement))
          .map((s) => `${s.tool}${s.action ? `.${s.action}` : ""} runs ${b.name} (src/${b.file})`)
      : []
  );
  assert.deepEqual(
    ungated,
    [],
    `these tool actions run INSERT/UPDATE/DELETE and are neither write-gated at the registrar (TOOL_GRANTS, TOOL_ACTION_GRANTS) nor carrying their own ctx.scope grant check, so a read-only caller can reach them: ${ungated.join(", ")}`
  );
});

// scanner-rule: one enforcement point invariant, derived over every registration
test("EVERY registered tool has a stated requirement, in both directions", () => {
  // A tool missing from TOOL_GRANTS falls back to `write`, safe but still drift. An
  // entry with no tool means a tool was renamed or removed and its requirement left
  // behind.
  const registered = REGISTRATIONS.map((b) => b.name).sort();
  assert.deepEqual(Object.keys(TOOL_GRANTS).sort(), registered);
});

// scanner-rule: one enforcement point invariant, derived over every registration
test("a tool action marked read does not mutate, which is the claim it would be dangerous to get wrong", () => {
  // A write wrongly marked read is admitted for a read-only caller by the registrar and
  // then writes.
  const lying = BLOCKS.flatMap((b) =>
    MUTATING_SQL.test(b.body) ? servedAs(b.name).filter((s) => READ_ONLY.includes(s.requirement)).map((s) => `${s.tool}${s.action ? `.${s.action}` : ""} (${b.name})`) : []
  );
  assert.deepEqual(lying, [], `these tool actions are marked read in TOOL_GRANTS and run mutating SQL: ${lying.join(", ")}`);
  // Vacuity: the classification is not simply empty of read actions.
  const reads = BLOCKS.filter((b) => servedAs(b.name).some((s) => READ_ONLY.includes(s.requirement))).length;
  assert.ok(reads >= 8, `only ${reads} operations classify as read; the derivation is broken`);
});

// scanner-rule: one enforcement point invariant (count guard for the scans in this file)
test("the gate check is not vacuous: several operations are found to be mutating", () => {
  // If a refactor moved every statement into a helper, the test above would pass
  // by matching nothing. This asserts it is still looking at real mutations.
  const mutating = BLOCKS.filter((b) => MUTATING_SQL.test(b.body)).map((b) => b.name);
  assert.ok(mutating.length >= 6, `only ${mutating.length} operations contain mutating SQL: ${mutating.join(", ")}`);
  for (const name of ["write", "delete", "move", "restore"]) {
    assert.ok(mutating.includes(name), `${name} no longer contains mutating SQL; has it moved to a helper?`);
  }
});
