import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import { SCOPE_FLAGS, defaultScopes } from "../src/agents-schema.ts";
import { TOOL_GRANTS } from "../src/scope.ts";
import { buildAdminServer } from "../src/server.ts";
import { CAPSID_ADMIN_TOOLS } from "../src/tools/surface.ts";
import { fakeD1, fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// A driver holding every other axis: write, every namespace, repo and tool, every flag. Only the admin check can refuse it.
function driver(): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.namespaces = "*";
  scopes.grants = ["read", "write"];
  for (const flag of SCOPE_FLAGS) scopes.flags[flag] = true;
  return {
    id: "agent_0123456789ab",
    name: "capsid-driver",
    kind: "driver",
    actor: "agent:capsid-driver",
    scopes,
    admin: false,
    row: null,
  };
}

async function callEvery(caller: Agent) {
  const d1 = fakeD1();
  const kv = fakeKv({ seedToken: true });
  const server = buildAdminServer(fakeEnv({ DB: d1.db, APP_KV: kv.kv }), caller);
  const client = new Client({ name: "admin-only", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const results: Array<{ label: string; isError: boolean; text: string }> = [];
  let fetched = 0;
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), [...CAPSID_ADMIN_TOOLS].sort());
    for (const tool of tools) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;
      for (const action of props.action?.enum ?? [undefined]) {
        const args: Record<string, unknown> = {};
        if (action !== undefined) args.action = action;
        if (props.namespace) args.namespace = "capsid";
        await withFetch({}, async (calls) => {
          const result = (await client.callTool({ name: tool.name, arguments: args })) as {
            isError?: boolean;
            content: Array<{ text: string }>;
          };
          fetched += calls.length;
          results.push({
            label: action === undefined ? tool.name : `${tool.name}.${action}`,
            isError: result.isError === true,
            text: result.content[0]?.text ?? "",
          });
        });
      }
    }
  } finally {
    await client.close();
    await server.close();
  }
  return { results, touched: d1.reads.length + d1.recorded.length + kv.puts.length + fetched };
}

test("PLANT: every admin tool and action refuses a write driver as admin only, before any store or network, and admits the admin", async () => {
  for (const tool of CAPSID_ADMIN_TOOLS) assert.match(TOOL_GRANTS[tool], /^admin/);

  const refused = await callEvery(driver());
  assert.ok(refused.results.length > CAPSID_ADMIN_TOOLS.length);
  for (const r of refused.results) {
    assert.equal(r.isError, true, `${r.label} answered a driver: ${r.text}`);
    assert.match(r.text, new RegExp(`'${r.label.replace(".", "\\.")}' is admin only`));
  }
  assert.equal(refused.touched, 0, "a refused call reached D1, KV or the network");

  const admitted = await callEvery(adminAgentForEmail("admin@example.com"));
  for (const r of admitted.results) assert.doesNotMatch(r.text, /admin only/, r.label);
});
