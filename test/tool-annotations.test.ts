import assert from "node:assert/strict";
import { test } from "node:test";
import { hintsFor, TOOL_HINTS } from "../src/tool-annotations.ts";
import { requiredGrant } from "../src/scope.ts";
import { toolBlocks } from "./source-files.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { adminAgent } from "../src/agents.ts";
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
  const server = buildServer(fakeEnv({ APP_KV: fakeKv({}).kv }), adminAgent("DrDustinEdwards"));
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
  // A name on the prototype chain must not resolve to an entry.
  const constructorLookup = hintsFor("constructor");
  assert.equal(typeof constructorLookup, "object");
  assert.equal(constructorLookup.readOnlyHint, false);
  assert.equal(constructorLookup.destructiveHint, true);
});
