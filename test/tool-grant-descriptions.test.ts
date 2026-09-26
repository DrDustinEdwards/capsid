import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { adminAgent } from "../src/agents.ts";
import { TOOL_GRANTS, TOOL_ACTION_GRANTS, repoWriteFlags } from "../src/scope.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// The grant sentence in each tool description is derived from TOOL_GRANTS, the table
// the registrar enforces, and checked against the descriptions the server serves, so
// a change to either side fails this file.

async function servedDescriptions(): Promise<Map<string, string>> {
  const server = buildServer(fakeEnv({ APP_KV: fakeKv({}).kv }), adminAgent("DrDustinEdwards"));
  const client = new Client({ name: "tool-grant-descriptions", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return new Map(tools.map((t) => [t.name, t.description ?? ""]));
}

// The sentence a tool's description must contain, or null when the requirement is
// not stated as one sentence (a read tool, or an action tool whose handler decides
// per action and whose description marks each action instead).
function grantSentence(tool: string): string | null {
  const requirement = TOOL_GRANTS[tool];
  if (requirement === "write") {
    // Flags a repo mutation needs whatever the arguments are. Flags that depend on
    // the arguments (mode, path, action) are described beside those arguments.
    const flags = repoWriteFlags(tool, {});
    if (flags.length === 0) return "needs the write grant";
    return `needs the write grant and the ${flags.join(" and the ")} flag`;
  }
  if (requirement === "admin") return "admin only";
  if (requirement === "action" && Object.hasOwn(TOOL_ACTION_GRANTS, tool)) {
    const spec = TOOL_ACTION_GRANTS[tool];
    assert.equal(spec.default, "admin", `${tool}: the sentence below assumes unlisted actions are admin; rewrite it`);
    const writeActions = Object.entries(spec.actions)
      .filter(([, req]) => req === "write")
      .map(([action]) => action);
    assert.equal(writeActions.length, Object.keys(spec.actions).length, `${tool}: an action is neither write nor admin`);
    return `${writeActions.join(" and ")} need the write grant; every other action is admin only`;
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
  }
  // Count stated so a derivation that matched nothing does not pass: 11 write tools,
  // 3 admin tools and improve_run.
  assert.equal(stated, 15, `expected 15 tools with a grant sentence, found ${stated}`);
});
