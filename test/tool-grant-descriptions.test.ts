import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildAdminServer, buildServer } from "../src/server.ts";
import { adminAgentForEmail } from "../src/agents.ts";
import { TOOL_GRANTS, TOOL_ACTION_GRANTS, repoWriteFlags } from "../src/scope.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// The grant sentence in each tool description is derived from TOOL_GRANTS, the table
// the registrar enforces, and checked against the descriptions the server serves, so
// a change to either side fails this file.

// Both servers: Capsid and Capsid Admin.
async function servedDescriptions(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const build of [buildServer, buildAdminServer]) {
    const server = build(fakeEnv({ APP_KV: fakeKv({}).kv }), adminAgentForEmail("admin@example.com"));
    const client = new Client({ name: "tool-grant-descriptions", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    await client.close();
    for (const tool of tools) out.set(tool.name, tool.description ?? "");
  }
  return out;
}

// The sentence a tool's description must contain, or null when the requirement is
// not stated as one sentence (a read tool, or an action tool whose handler decides
// per action and whose description marks each action instead).
function grantSentence(tool: string): string | null {
  const requirement = TOOL_GRANTS[tool];
  if (requirement === "write") {
    // Flags a repo mutation needs whatever the arguments are. Flags that depend on
    // the arguments (mode, path, action) are described beside those arguments.
    const flags = repoWriteFlags(tool, undefined, {});
    if (flags.length === 0) return "needs the write grant";
    return `needs the write grant and the ${flags.join(" and the ")} flag`;
  }
  if (requirement === "admin" || requirement === "admin_read") return "admin only";
  if (requirement === "action" && Object.hasOwn(TOOL_ACTION_GRANTS, tool)) {
    const spec = TOOL_ACTION_GRANTS[tool];
    assert.equal(spec.default, "admin", `${tool}: the sentence below assumes unlisted actions are admin; rewrite it`);
    const readActions = Object.entries(spec.actions)
      .filter(([, req]) => req === "read")
      .map(([action]) => action);
    const writeActions = Object.entries(spec.actions)
      .filter(([, req]) => req === "write")
      .map(([action]) => action);
    assert.equal(readActions.length + writeActions.length, Object.keys(spec.actions).length, `${tool}: an action is neither read nor write`);
    return `${readActions.join(" and ")} needs the read grant; ${writeActions.join(" and ")} need the write grant`;
  }
  return null;
}

const OPERATOR_KEY_CLAIM = /requires (an )?operator key/i;

test("the served tools and TOOL_GRANTS name the same set", async () => {
  const served = await servedDescriptions();
  assert.deepEqual([...served.keys()].sort(), Object.keys(TOOL_GRANTS).sort());
});

test("DERIVED: every tool's description states the requirement TOOL_GRANTS gives it", async () => {
  const served = await servedDescriptions();
  let stated = 0;
  for (const [tool, description] of served) {
    const text = description.toLowerCase();
    assert.doesNotMatch(description, OPERATOR_KEY_CLAIM, `${tool}: the description still says an operator key is required`);
    const sentence = grantSentence(tool);
    if (sentence) {
      stated++;
      assert.ok(text.includes(sentence), `${tool}: the description does not say "${sentence}", which is what TOOL_GRANTS requires`);
    }
    if (TOOL_GRANTS[tool] === "read") {
      assert.ok(!text.includes("needs the write grant"), `${tool} is read, and its description says it needs the write grant`);
      assert.ok(!text.includes("admin only"), `${tool} is read, and its description says admin only`);
    }
    if (TOOL_GRANTS[tool] === "write") {
      assert.ok(!text.includes("admin only"), `${tool} takes the write grant, and its description says admin only`);
    }
    if (TOOL_GRANTS[tool] === "admin_read") {
      assert.ok(!text.includes("needs the write grant"), `${tool} only reads, and its description says it needs the write grant`);
    }
  }
  // Count stated so a derivation that matched nothing does not pass: six write tools
  // (write_doc, delete_doc, change_repo, open_pr, close_pr, run_ci) and the eight admin
  // tools.
  assert.equal(stated, 14, `expected 14 tools with a grant sentence, found ${stated}`);
});

test("PLANT: every served tool's description fits the 4,096 characters Claude Code shows", async () => {
  // Claude Code cuts a tool description at 4,096 characters, so anything past it is
  // never read (capsid_work_jobs ran to 8,001 until 2026-10-15). Detail belongs in the
  // parameter descriptions and docs/.
  const served = await servedDescriptions();
  assert.ok(served.size > 0, "the server served no tools");
  const over = [...served].filter(([, d]) => d.length > 4096).map(([name, d]) => `${name} (${d.length})`);
  assert.deepEqual(over, [], `these descriptions are cut off: ${over.join(", ")}`);
});
