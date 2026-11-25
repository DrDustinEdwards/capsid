import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildAdminServer } from "../src/server.ts";
import { checkScope } from "../src/scope.ts";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import { defaultScopes, noFlags, type AgentScopes } from "../src/agents-schema.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// A write-grant driver must not call capsid_admin_manage_namespaces "update" on its own namespace, add any repo the App
// reaches and read it. Both halves are tested: either alone leaves a hole (a forgotten admin call, or a boundary editable by the party it binds).

function agentWith(scopes: Partial<AgentScopes>, admin = false): Agent {
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
    admin,
    row: null,
  } as Agent;
}

const tool = "capsid_admin_manage_namespaces";
test(`${tool}.update refuses a minted agent and names why, and admits the admin`, () => {
  // The driver is scoped to the namespace it is asking about and holds write, so
  // every other axis passes. Only the admin check can refuse this call.
  const need = {
    tool,
    action: "update",
    namespace: "capsid",
    grant: "write",
    admin: true,
  } as const;
  const refusal = checkScope(agentWith({}), need);
  assert.ok(refusal, `${tool}.update admitted a minted agent`);
  assert.match(refusal, /admin only/, "the refusal does not say it is an admin tool");
  assert.match(refusal, /authorization boundary/, "the refusal does not say why");
  assert.equal(checkScope(agentWith({ namespaces: "*", repos: "*" }, true), need), null);
});

test("the admin refusal comes BEFORE the namespace refusal", () => {
  // A driver asking about someone else's namespace must still be told the tool is
  // admin only. Reporting the namespace first would send it to ask for a namespace
  // it does not need, and it would leak which namespaces exist.
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

// The assertions above call checkScope with `admin: true`; this proves the registrar turns a TOOL_GRANTS entry of "admin"
// into that need.

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

function realDriver(namespace = "capsid"): Agent {
  const scopes = defaultScopes([namespace]);
  scopes.grants = ["read", "write"];
  return {
    id: "agent_0123456789ab",
    name: `${namespace}-driver`,
    kind: "driver",
    actor: `agent:${namespace}-driver`,
    scopes,
    admin: false,
    row: null,
  };
}

test("END TO END: a driver is refused capsid_admin_manage_namespaces update through a real connection", async () => {
  const result = await callAs(realDriver(), "update", {
    namespace: "capsid",
    repos: JSON.stringify([
      { repo: "DrDustinEdwards/capsid", label: "primary" },
      { repo: "DrDustinEdwards/capsid-backups", label: "backups" },
    ]),
  });
  assert.equal(result.isError, true, "a driver remapped its own namespace");
  const text = result.content.map((c) => c.text).join("");
  assert.match(text, /admin only/);
  assert.match(text, /widen itself/);
});

test("END TO END: a driver is refused capsid_admin_manage_namespaces register through a real connection", async () => {
  const result = await callAs(realDriver(), "register", {
    namespace: "brand-new",
    repos: JSON.stringify([{ repo: "DrDustinEdwards/anything", label: "primary" }]),
  });
  assert.equal(result.isError, true, "a driver registered a namespace onto a repo of its choosing");
  assert.match(result.content.map((c) => c.text).join(""), /admin only/);
});

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

test("PLANT: a driver narrowed to its own repos is refused on another, remap or not", () => {
  const driver = agentWith({ repos: ["DrDustinEdwards/capsid"] });
  assert.equal(
    checkScope(driver, {
      tool: "capsid_read_repo",
      action: "files",
      namespace: "capsid",
      repo: "DrDustinEdwards/capsid",
      grant: "read",
    }),
    null,
  );
  const refusal = checkScope(driver, {
    tool: "capsid_read_repo",
    action: "files",
    namespace: "capsid",
    repo: "DrDustinEdwards/capsid-backups",
    grant: "read",
  });
  assert.ok(refusal, "a narrowed driver reached a repo outside its axis");
  assert.match(refusal, /not scoped to the 'DrDustinEdwards\/capsid-backups' repo/);
});
