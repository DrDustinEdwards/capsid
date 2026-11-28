import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildAdminServer } from "../src/server.ts";
import { checkScope } from "../src/scope.ts";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import { noFlags, type AgentScopes } from "../src/agents-schema.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// The driver refusal itself is test/admin-only.test.ts.

function agentWith(scopes: Partial<AgentScopes>): Agent {
  return {
    id: "ag_test",
    name: "test",
    kind: "driver",
    actor: "agent:test",
    scopes: {
      namespaces: ["capsid"],
      repos: ["DrDustinEdwards/capsid"],
      tools: "*",
      grants: ["read", "write"],
      flags: noFlags(),
      ...scopes,
    },
    admin: false,
    row: null,
  } as Agent;
}

test("the admin refusal comes BEFORE the namespace refusal", () => {
  // Reporting the namespace first would leak which namespaces exist.
  const refusal = checkScope(agentWith({}), {
    tool: "capsid_admin_manage_namespaces",
    action: "update",
    namespace: "foxhound",
    grant: "write",
    admin: true,
  });
  assert.ok(refusal);
  assert.match(refusal, /admin only/);
  assert.doesNotMatch(refusal, /not scoped to the 'foxhound' namespace/);
});

interface ToolResult {
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function callAs(
  caller: Agent,
  action: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const server = buildAdminServer(fakeEnv({ DB: fakeD1().db, APP_KV: fakeKv().kv }), caller);
  const client = new Client({ name: "namespace-remap", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = (await client.callTool({
    name: "capsid_admin_manage_namespaces",
    arguments: { action, ...args },
  })) as ToolResult;
  await client.close();
  await server.close();
  return result;
}

test("END TO END: the admin still maps namespaces", async () => {
  const result = await callAs(adminAgentForEmail("admin@example.com"), "update", {
    namespace: "capsid",
    repos: JSON.stringify([{ repo: "DrDustinEdwards/capsid", label: "primary" }]),
  });
  const text = result.content.map((c) => c.text).join("");
  assert.doesNotMatch(text, /admin only/, `the admin was refused its own tool: ${text}`);
  assert.notEqual(result.isError, true, `the admin's update failed: ${text}`);
  const out = JSON.parse(text) as {
    namespace: string;
    action: string;
    repos: Array<{ repo: string; label: string }>;
  };
  assert.equal(out.namespace, "capsid");
  assert.equal(out.action, "updated");
  assert.deepEqual(out.repos, [{ repo: "DrDustinEdwards/capsid", label: "primary" }]);
});
