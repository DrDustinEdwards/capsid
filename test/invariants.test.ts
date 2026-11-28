import assert from "node:assert/strict";
import { test } from "node:test";
import { operationBlocks, toolBlocks } from "./source-files.ts";
import { servedAs } from "./served.ts";
import { TOOL_GRANTS } from "../src/scope.ts";

// Every mutating operation is gated on the write grant, read off the source; the behavioral half is test/write-invariants.test.ts.

// registerNamespace and updateNamespace (src/namespace-admin.ts) are the same write the SQL was, so they are matched by name.
const MUTATING_SQL =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b|\b(registerNamespace|updateNamespace)\(/i;
// The tools whose requirement depends on their action gate inline with a ctx.scope write call.
const SCOPE_GATE = /ctx\.scope\(\{[^}]*grant: "write"/;
const BLOCKS = operationBlocks();

test("an operation with mutating SQL is never marked read, and is write-gated by the registrar or its own scope call", () => {
  const ungated = BLOCKS.flatMap((b) =>
    MUTATING_SQL.test(b.body)
      ? servedAs(b.name)
          .filter(
            (s) =>
              ["read", "admin_read"].includes(s.requirement) ||
              (!["write", "admin"].includes(s.requirement) && !SCOPE_GATE.test(b.body)),
          )
          .map((s) => `${s.tool}${s.action ? `.${s.action}` : ""} runs ${b.name} (src/${b.file})`)
      : [],
  );
  assert.deepEqual(ungated, []);
});

test("every registered tool has a stated requirement, every entry a tool, and every operation a served tool", () => {
  assert.deepEqual(
    Object.keys(TOOL_GRANTS).sort(),
    toolBlocks()
      .map((b) => b.name)
      .sort(),
  );
  for (const b of BLOCKS)
    assert.ok(
      servedAs(b.name).length > 0,
      `operation ${b.name} (src/${b.file}) is served by no tool`,
    );
});
