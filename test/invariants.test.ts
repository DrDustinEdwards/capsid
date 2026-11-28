import assert from "node:assert/strict";
import { test } from "node:test";
import { operationBlocks, sourceFiles, toolBlocks, type ToolBlock } from "./source-files.ts";
import { servedAs } from "./served.ts";
import { TOOL_GRANTS } from "../src/scope.ts";

// Guards two write-path invariants whose failures are silent: every overwrite and delete snapshots
// the prior row into document_versions and audits, and every mutating tool is gated on the write grant.
//
// Source-guard half; the behavioral half is test/write-invariants.test.ts. Scans all of src/ because these
// are properties of a tool wherever registered; each served operation is judged by every action that runs it.

// The namespace register and update moved to src/namespace-admin.ts so the Portal's controls
// share them; a call of either is the same write the SQL was, so it is matched by name.
const MUTATING_SQL =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b|\b(registerNamespace|updateNamespace)\(/i;
// Coverage is asserted rather than a spelling. A write tool is gated by the registrar (`write` in
// TOOL_GRANTS) or by an inline ctx.scope write call, for the two tools whose requirement depends on their action.
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
  assert.ok(
    REGISTRATIONS.length >= 15,
    `expected the full tool surface, parsed ${REGISTRATIONS.length} registrations`,
  );
  assert.ok(BLOCKS.length >= 37, `expected every operation, parsed ${BLOCKS.length} blocks`);
  for (const name of ["write", "delete", "move", "lint", "restore", "read", "search"]) {
    assert.ok(
      BLOCKS.some((b) => b.name === name),
      `did not parse a block for the ${name} operation`,
    );
  }
  for (const b of BLOCKS)
    assert.ok(
      servedAs(b.name).length > 0,
      `operation ${b.name} (src/${b.file}) is defined but no served tool runs it`,
    );
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
      : [],
  );
  assert.deepEqual(
    ungated,
    [],
    `these tool actions run INSERT/UPDATE/DELETE and are neither write-gated at the registrar (TOOL_GRANTS, TOOL_ACTION_GRANTS) nor carrying their own ctx.scope grant check, so a read-only caller can reach them: ${ungated.join(", ")}`,
  );
});

// scanner-rule: one enforcement point invariant, derived over every registration
test("EVERY registered tool has a stated requirement, in both directions", () => {
  // A tool missing from TOOL_GRANTS falls back to `write` (safe, but drift); an entry with no tool
  // is a renamed or removed tool's leftover.
  const registered = REGISTRATIONS.map((b) => b.name).sort();
  assert.deepEqual(Object.keys(TOOL_GRANTS).sort(), registered);
});

// scanner-rule: one enforcement point invariant, derived over every registration
test("a tool action marked read does not mutate, which is the claim it would be dangerous to get wrong", () => {
  // A write wrongly marked read is admitted for a read-only caller by the registrar and
  // then writes.
  const lying = BLOCKS.flatMap((b) =>
    MUTATING_SQL.test(b.body)
      ? servedAs(b.name)
          .filter((s) => READ_ONLY.includes(s.requirement))
          .map((s) => `${s.tool}${s.action ? `.${s.action}` : ""} (${b.name})`)
      : [],
  );
  assert.deepEqual(
    lying,
    [],
    `these tool actions are marked read in TOOL_GRANTS and run mutating SQL: ${lying.join(", ")}`,
  );
  const reads = BLOCKS.filter((b) =>
    servedAs(b.name).some((s) => READ_ONLY.includes(s.requirement)),
  ).length;
  assert.ok(reads >= 8, `only ${reads} operations classify as read; the derivation is broken`);
});

// scanner-rule: one enforcement point invariant (count guard for the scans in this file)
test("the gate check is not vacuous: several operations are found to be mutating", () => {
  // If a refactor moved every statement into a helper, the test above would pass
  // by matching nothing. This asserts it is still looking at real mutations.
  const mutating = BLOCKS.filter((b) => MUTATING_SQL.test(b.body)).map((b) => b.name);
  assert.ok(
    mutating.length >= 6,
    `only ${mutating.length} operations contain mutating SQL: ${mutating.join(", ")}`,
  );
  for (const name of ["write", "delete", "move", "restore"]) {
    assert.ok(
      mutating.includes(name),
      `${name} no longer contains mutating SQL; has it moved to a helper?`,
    );
  }
});
