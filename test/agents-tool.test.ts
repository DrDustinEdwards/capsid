import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildAdminServer } from "../src/server.ts";

import { defaultScopes, serializeScopes } from "../src/agents-schema.ts";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import { fakeD1, fakeEnv, type FakeD1 } from "./fakes.ts";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";

// Who may call the tool at all is test/admin-only.test.ts.

interface ToolResult {
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function connect(caller: Agent, rows: Array<Record<string, unknown>> = []) {
  const d1: FakeD1 = fakeD1({ agents: rows });
  const server = buildAdminServer(fakeEnv({ DB: d1.db }), caller);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    d1,
    call: (args: Record<string, unknown>) =>
      client.callTool({
        name: "capsid_admin_manage_agents",
        arguments: args,
      }) as Promise<ToolResult>,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const parse = (result: ToolResult) => JSON.parse(result.content[0].text) as Record<string, unknown>;

// A domain refusal (name taken, no such agent) is an ordinary result with ok:false, not an MCP error.
const refusalOf = (result: ToolResult) => String(parse(result).refusal ?? "");
const statements = (d1: FakeD1) => [...d1.reads, ...d1.recorded];

async function liveRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent_0123456789ab",
    name: "capsid-driver",
    kind: "driver",
    key_hash: await sha256Hex("a-minted-key"),
    scopes: serializeScopes(defaultScopes(["capsid"])),
    created_by: "github:dustin",
    created_at: "2026-09-11 00:00:00",
    revoked_at: null,
    last_seen: null,
    ...overrides,
  };
}

test("mint returns the key ONCE and stores only its hash", async () => {
  const { d1, call, close } = await connect(adminAgentForEmail("admin@example.com"));
  const result = await call({
    action: "mint",
    name: "capsid-driver",
    kind: "driver",
    namespaces: ["capsid"],
  });
  await close();
  assert.notEqual(result.isError, true, result.content[0].text);
  const body = parse(result);
  const key = String(body.key);
  assert.match(key, /^capsid_agent_[0-9a-f]{64}$/);
  assert.match(
    String(body.note ?? ""),
    /once/i,
    "the response has to say the key is not recoverable",
  );

  const insert = statements(d1).find((r) => /INSERT INTO agents/i.test(r.sql));
  assert.ok(insert, "mint did not insert the row");
  const stored = insert.params.map(String);
  assert.ok(!stored.includes(key), "THE PLAINTEXT KEY REACHED THE DATABASE");
  assert.ok(stored.includes(await sha256Hex(key)), "the row does not carry the key's sha256");
  assert.match(insert.sql, /pending\)\s*VALUES \([^)]*, 1\)/i, "a minted key was born active");
  assert.equal((body.agent as { pending: boolean }).pending, true);
  assert.match(String(body.note), /Activate/);

  const audit = statements(d1).find((r) => /INSERT INTO audit_log/i.test(r.sql));
  assert.ok(audit, "mint was not audit-logged");
  const params = JSON.stringify(audit.params);
  assert.ok(!params.includes(key), "THE PLAINTEXT KEY REACHED THE AUDIT LOG");
  assert.match(
    params,
    /namespaces/,
    "the audit row does not record the scopes the agent was minted with",
  );
});

test("PLANT: a mint that names no repos gets the namespace's mapping, not the wildcard; a named list is kept as asked; an unmapped namespace is refused", async () => {
  const { call, close } = await connect(adminAgentForEmail("admin@example.com"));
  const mint = (name: string, extra: Record<string, unknown>) =>
    call({ action: "mint", name, kind: "driver", namespaces: ["capsid"], ...extra }).then(parse);
  const derived = await mint("capsid-driver", {});
  const narrow = await mint("one-repo", { repos: ["o/other"] });
  const wide = await mint("every-repo", { repos: ["*"] });
  const ghost = await call({
    action: "mint",
    name: "ghost-driver",
    kind: "driver",
    namespaces: ["not-registered"],
  });
  await close();
  assert.deepEqual((derived.scopes as { repos: string[] }).repos, ["owner/repo"]);
  assert.deepEqual((narrow.scopes as { repos: string[] }).repos, ["o/other"]);
  assert.equal((wide.scopes as { repos: string }).repos, "*");
  assert.match(refusalOf(ghost), /not registered/);
});

test("list shows the inventory and last_seen, and never the verifier", async () => {
  const { call, close } = await connect(adminAgentForEmail("admin@example.com"), [
    await liveRow({ last_seen: "2026-09-11 01:30:00" }),
    await liveRow({
      id: "agent_ffffffffffff",
      name: "retired",
      key_hash: await sha256Hex("other"),
      revoked_at: "2026-09-10 00:00:00",
    }),
  ]);
  const body = parse(await call({ action: "list" }));
  await close();
  const agents = body.agents as Array<Record<string, unknown>>;
  assert.equal(
    agents.length,
    2,
    "list hides revoked agents, which is how a revoked credential becomes invisible instead of accounted for",
  );
  const live = agents.find((a) => a.name === "capsid-driver");
  assert.ok(live);
  assert.equal(live.last_seen, "2026-09-11 01:30:00");
  assert.equal(live.revoked_at, null);
  assert.ok(!("key_hash" in live), "list handed out the stored verifier");
  assert.match(
    String(live.fingerprint),
    /^[0-9a-f]{12}$/,
    "an agent needs a short handle to match against an audit row",
  );
});

test("revoke is a timestamp, not a delete, so the audit rows it wrote still resolve", async () => {
  const { d1, call, close } = await connect(adminAgentForEmail("admin@example.com"), [
    await liveRow(),
  ]);
  const result = await call({ action: "revoke", name: "capsid-driver" });
  await close();
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(parse(result).ok, true, refusalOf(result));
  const update = statements(d1).find((r) => /UPDATE agents SET revoked_at/i.test(r.sql));
  assert.ok(update, "revoke did not set revoked_at");
  assert.ok(
    !statements(d1).some((r) => /DELETE FROM agents/i.test(r.sql)),
    "revoke deleted the row",
  );
});

test("revoking or re-scoping an agent that is not there is a refusal, not a silent success", async () => {
  const { call, close } = await connect(adminAgentForEmail("admin@example.com"));
  for (const action of ["revoke", "update_scopes"]) {
    const result = await call({ action, name: "nobody", grants: ["read"] });
    assert.equal(parse(result).ok, false, `${action} reported success over a missing row`);
    assert.match(refusalOf(result), /no live agent named 'nobody'/);
  }
  await close();
});

test("update_scopes replaces the scopes and records both sides in the audit row", async () => {
  const { d1, call, close } = await connect(adminAgentForEmail("admin@example.com"), [
    await liveRow(),
  ]);
  const result = await call({
    action: "update_scopes",
    name: "capsid-driver",
    grants: ["read", "write"],
    flags: { can_touch_protected: true },
  });
  await close();
  assert.notEqual(result.isError, true, result.content[0].text);
  const body = parse(result);
  assert.equal(body.ok, true, refusalOf(result));
  const scopes = body.scopes as { grants: string[]; flags: Record<string, boolean> };
  assert.deepEqual(scopes.grants, ["read", "write"]);
  assert.equal(scopes.flags.can_touch_protected, true);
  assert.equal(
    scopes.flags.can_merge,
    false,
    "an unnamed flag must not be turned on by a call that did not name it",
  );
  const audit = statements(d1).find((r) => /INSERT INTO audit_log/i.test(r.sql));
  assert.ok(audit, "update_scopes was not audit-logged");
  assert.match(
    JSON.stringify(audit.params),
    /before/,
    "the audit row does not record what the scopes were before",
  );
});

test("mint refuses a kind the table does not have, and a name that is already taken", async () => {
  const { call, close } = await connect(adminAgentForEmail("admin@example.com"), [await liveRow()]);
  const badKind = await call({
    action: "mint",
    name: "new-one",
    kind: "superuser",
    namespaces: ["capsid"],
  });
  assert.equal(parse(badKind).ok, false);
  assert.match(refusalOf(badKind), /session, driver, seat, cron/);
  const taken = await call({
    action: "mint",
    name: "capsid-driver",
    kind: "driver",
    namespaces: ["capsid"],
  });
  assert.equal(parse(taken).ok, false);
  assert.match(refusalOf(taken), /already/i);
  await close();
});
