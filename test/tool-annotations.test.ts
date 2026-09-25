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

// TOOL ANNOTATIONS ARE DERIVED, NOT DECLARED.
//
// An annotation is a hint a client acts on, so a wrong one is worse than a missing
// one: `readOnlyHint: true` on a tool that writes tells a client it need not ask.
// src/tool-annotations.ts is a cache of two facts that live in the handlers, and
// this file is what keeps it honest, the same relationship src/counts.ts has with
// test/counts.test.ts.
//
// Every scan below fails in BOTH directions, and every one carries a vacuity guard,
// because "0 tools disagreed" and "0 tools were read" are indistinguishable
// otherwise (capsid/conventions.md: pair every content check with a count check).

// A tool is WRITE-GATED iff src/scope.ts says a call needs the write grant.
//
// This used to be read out of the handler text, matching the inline `if (!mayWrite)`
// refusal or the shared repo-write wrapper. The gate moved to one enforcement point
// (the registrar, plus an explicit check in the two action-scoped tools), so the
// handler no longer carries a spelling to match and the requirement is read from the
// artifact that decides it.
//
// It is still DERIVED rather than declared, which is the whole point of this file:
// TOOL_GRANTS is what the registrar enforces at runtime, so a tool whose requirement
// changes there changes its hint here, and test/invariants.test.ts separately proves
// TOOL_GRANTS itself against the handlers (every mutating tool is write-gated, and
// nothing marked read contains mutating SQL). The two files together close the loop
// that reading one artifact against itself would leave open.
const isWriteGated = (tool: string) => requiredGrant(tool) !== "read";

// A write-gated handler is DESTRUCTIVE iff it can overwrite or remove state that
// already exists. Matched by what the handler does, never by its name, so the next
// tool that learns to delete something is caught by this file rather than by an
// incident.
const DESTRUCTIVE = [
  /INSERT INTO documents/i, // an overwrite goes through the same insert as a create
  /\bdocumentUpsert\(/,
  /\bpathMutation\(/,
  /UPDATE namespaces/i,
  /\bdeleteRepoFile\(/,
  /\bdeleteBranch\(/,
  /\bmanagePr\(/,
  /\bwriteRepoFile\(/,
  // The improve loop's two mutating entry points. improveControl writes the mode,
  // the pause key and the budget caps; improveRunManual advances a run, which
  // reverts attempts. Named because the subsystem's writes happen a module away,
  // where an INSERT or a DELETE in this file's own text cannot see them.
  /\bimproveControl\(/,
  /\bimproveRunManual\(/,
  // The work queue's mutating entry points, named for the same reason: the row and
  // document writes happen in src/jobs.ts, a module away from this file's text.
  /\bclaimJob\(/,
  /\bcompleteJob\(/,
  /\bfailJob\(/,
  /\bblockJob\(/,
  // The credential control plane's two overwriting entry points, named for the same
  // reason: revoke ends a credential and update_scopes changes what it may do, and
  // both statements live in src/agents-admin.ts.
  /\brevokeAgent\(/,
  /\bupdateAgentScopes\(/,
];

const matches = (body: string, res: RegExp[]) => res.some((re) => re.test(body));

// THE ANNOTATIONS A CLIENT RECEIVES, read from tools/list rather than from the
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

// The destructive classification still comes from the handler source: the repo, queue,
// improve and agent tools overwrite through modules a call in this file cannot observe
// without their own fakes. The hints compared are the SERVED ones. The five document
// mutators that test/write-invariants.test.ts drives (write, delete, restore, move and
// lint finalize) are also checked by name below, so that half rests on behavior.
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
  // The innocent case. A guard that also fires on code doing nothing wrong gets
  // deleted rather than fixed, so the negative direction is asserted too.
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
  // And the prototype-chain trap that bit AUTHORITATIVE on 2026-09-06.
  const constructorLookup = hintsFor("constructor");
  assert.equal(typeof constructorLookup, "object");
  assert.equal(constructorLookup.readOnlyHint, false);
  assert.equal(constructorLookup.destructiveHint, true);
});
