import assert from "node:assert/strict";
import { test } from "node:test";
import { hintsFor, TOOL_HINTS } from "../src/tool-annotations.ts";
import { servedOperations } from "./served.ts";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildAdminServer, buildServer } from "../src/server.ts";
import { adminAgentForEmail, grantAgent, type Agent } from "../src/agents.ts";
import { toolListProblems } from "@dustinedwards/site-runtime/mcp-server";
import { fakeEnv, fakeKv } from "./fakes.ts";

// A tool is write-gated iff some action needs more than the read grant.
const SERVED = servedOperations();
const READ_ONLY = ["read", "admin_read"];
const isWriteGated = (tool: string) =>
  SERVED.some((s) => s.tool === tool && !READ_ONLY.includes(s.requirement));

type ServedTool = { name: string; annotations?: Record<string, unknown>; [field: string]: unknown };
async function servedTools(
  caller: Agent = adminAgentForEmail("admin@example.com"),
  builds = [buildServer, buildAdminServer],
): Promise<ServedTool[]> {
  const out: ServedTool[] = [];
  for (const build of builds) {
    const server = build(fakeEnv({ APP_KV: fakeKv({}).kv }), caller);
    const client = new Client({ name: "tool-annotations", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    await client.close();
    out.push(...tools);
  }
  return out;
}

async function servedAnnotations(): Promise<Map<string, Record<string, unknown> | undefined>> {
  return new Map(
    (await servedTools()).map((t) => [
      t.name,
      t.annotations as Record<string, unknown> | undefined,
    ]),
  );
}

// The live check wants every input object closed and every tool a read grant lists to be read-only.
test("PLANT: the served tool lists pass the family's tools/list check, and a read grant lists only read-only tools", async () => {
  const errors = toolListProblems(await servedTools()).filter((p) => p.severity === "error");
  assert.deepEqual(
    errors.map((p) => `${p.item} ${p.tool}: ${p.detail}`),
    [],
  );
  const read = await servedTools(grantAgent("read", "opkey:readonly0000"), [buildServer]);
  assert.ok(
    read.some((t) => t.name === "capsid_lint_namespace"),
    "a read grant is no longer served capsid_lint_namespace, so this checks less than it says",
  );
  assert.deepEqual(
    toolListProblems(read)
      .filter((p) => p.severity === "error")
      .map((p) => `${p.item} ${p.tool}: ${p.detail}`),
    [],
  );
  assert.deepEqual(
    read.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name),
    [],
    "a read grant lists a tool that is not read-only (T7)",
  );
});

test("PLANT: every served tool carries exactly its hint table entry, and the table names only served tools", async () => {
  const served = await servedAnnotations();
  assert.ok(served.size > 0, "the server served no tools");
  assert.deepEqual(
    [...served.keys()].sort(),
    Object.keys(TOOL_HINTS).sort(),
    "a tool without an entry, or an entry without a tool, fails here",
  );
  const differs = [...served]
    .filter(([name, hints]) => JSON.stringify(hints) !== JSON.stringify(TOOL_HINTS[name]))
    .map(([name]) => name);
  assert.deepEqual(
    differs,
    [],
    `these tools serve annotations that are not their table entry: ${differs.join(", ")}`,
  );
});

test("PLANT: the served readOnlyHint is exactly the negation of the write gate", async () => {
  const served = await servedAnnotations();
  const gated = [...served.keys()].filter(isWriteGated);
  // Vacuity: both sides of the rule are populated, or it is comparing nothing.
  assert.ok(
    gated.length > 0 && gated.length < served.size,
    `the write gate splits ${served.size} tools into ${gated.length} gated`,
  );
  const wrong = [...served]
    .filter(([name, hints]) => hints?.readOnlyHint !== !isWriteGated(name))
    .map(
      ([name, hints]) =>
        `${name}: write-gated=${isWriteGated(name)} but readOnlyHint=${hints?.readOnlyHint}`,
    );
  assert.deepEqual(wrong, [], wrong.join("; "));
});

test("an unknown tool fails CLOSED rather than claiming to be safe", () => {
  const unknown = hintsFor("a_tool_that_does_not_exist");
  assert.equal(
    unknown.readOnlyHint,
    false,
    "a tool with no entry must not be advertised as read-only",
  );
  assert.equal(unknown.destructiveHint, true);
  assert.equal(
    unknown.idempotentHint,
    false,
    "a tool with no entry must not be advertised as safe to repeat",
  );
  assert.equal(
    unknown.openWorldHint,
    true,
    "a tool with no entry must not be advertised as closed world",
  );
  // A name on the prototype chain must not resolve to an entry.
  const constructorLookup = hintsFor("constructor");
  assert.equal(typeof constructorLookup, "object");
  assert.equal(constructorLookup.readOnlyHint, false);
  assert.equal(constructorLookup.destructiveHint, true);
  assert.equal(constructorLookup.idempotentHint, false);
  assert.equal(constructorLookup.openWorldHint, true);
});
