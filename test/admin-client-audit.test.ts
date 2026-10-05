import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ADMIN_CLIENT_AUDIT_UNTIL_MS,
  adminWriteObserver,
  initializeClient,
  recordAdminInitialize,
  type AdminWriteObserver,
} from "../src/admin-client-audit.ts";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import { guardRegistrations } from "../src/scope.ts";

// job_e1973c5bcb69, DECIDE 2: record the client behind every admin call that is not a
// plain read, for 30 days, and never refuse on what the client says.

interface Row {
  sql: string;
  binds: unknown[];
}

// A D1 whose inserts are recorded, or refused.
function fakeDb(fail = false) {
  const rows: Row[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        run: async () => {
          if (fail) throw new Error("D1_ERROR: unavailable");
          rows.push({ sql, binds });
          return {};
        },
      }),
    }),
  } as unknown as D1Database;
  return { db, rows };
}

const params = (row: Row) => JSON.parse(String(row.binds[4])) as Record<string, unknown>;
const BEFORE = ADMIN_CLIENT_AUDIT_UNTIL_MS - 1000;
const AFTER = ADMIN_CLIENT_AUDIT_UNTIL_MS;

const admin = adminAgentForEmail("admin@example.com");
const minted: Agent = { ...admin, id: "agent_1", name: "capsid-driver", kind: "driver", actor: "agent:capsid-driver", admin: false };

// The real registrar, with tools named like the real ones (the registrar reads the name):
// read is a read, write needs the write grant.
async function connect(agent: Agent, observe: AdminWriteObserver | undefined, ran: string[]) {
  const server = new McpServer({ name: "capsid", version: "1.0.0" });
  guardRegistrations(server, agent, observe);
  for (const name of ["read", "write"]) {
    server.registerTool(name, { inputSchema: { namespace: z.string() } }, async () => {
      ran.push(name);
      return { content: [{ type: "text" as const, text: "ok" }] };
    });
  }
  const client = new Client({ name: "claude-code", version: "2.1.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  return {
    call: (name: string) => client.callTool({ name, arguments: { namespace: "sample" } }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test("an admin write records one admin-client row with the tool, the User-Agent and the client name", async () => {
  const { db, rows } = fakeDb();
  const ran: string[] = [];
  const t = await connect(admin, adminWriteObserver(db, admin.actor, "Claude-User", () => BEFORE), ran);
  const result = await t.call("write");
  await t.close();

  assert.equal(result.isError, undefined);
  assert.deepEqual(ran, ["write"]);
  assert.equal(rows.length, 1, "exactly one row for one admin write");
  assert.match(rows[0].sql, /INSERT INTO audit_log/);
  assert.equal(rows[0].binds[0], "access:admin@example.com");
  assert.equal(rows[0].binds[1], "admin-client");
  assert.equal(rows[0].binds[2], "sample");
  assert.deepEqual(params(rows[0]), { tool: "write", action: null, user_agent: "Claude-User", client_name: "claude-code" });
});

test("an admin read records nothing", async () => {
  const { db, rows } = fakeDb();
  const ran: string[] = [];
  const t = await connect(admin, adminWriteObserver(db, admin.actor, "ua", () => BEFORE), ran);
  await t.call("read");
  await t.close();
  assert.deepEqual(ran, ["read"]);
  assert.equal(rows.length, 0);
});

test("a caller that is not the admin is not observed, so a driver's writes add no row", async () => {
  const { db, rows } = fakeDb();
  const ran: string[] = [];
  const t = await connect(minted, adminWriteObserver(db, minted.actor, "ua", () => BEFORE), ran);
  await t.call("write");
  await t.close();
  assert.deepEqual(ran, ["write"]);
  assert.equal(rows.length, 0);
});

test("after the 30-day window the call runs and no row is written", async () => {
  const { db, rows } = fakeDb();
  const ran: string[] = [];
  const t = await connect(admin, adminWriteObserver(db, admin.actor, "ua", () => AFTER), ran);
  await t.call("write");
  await t.close();
  assert.deepEqual(ran, ["write"]);
  assert.equal(rows.length, 0);
});

test("a row that cannot be written refuses the call and says why, instead of running it unrecorded", async () => {
  const { db } = fakeDb(true);
  const ran: string[] = [];
  const t = await connect(admin, adminWriteObserver(db, admin.actor, "ua", () => BEFORE), ran);
  const result = await t.call("write");
  await t.close();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /admin client audit row could not be written \(D1_ERROR: unavailable\), so write was not run/);
  assert.deepEqual(ran, [], "the handler ran although the audit row was not written");
});

test("the observer never refuses on what the client says", async () => {
  for (const ua of [null, "", "curl/8", "Mozilla/5.0 claude.ai", "x".repeat(5000)]) {
    const { db, rows } = fakeDb();
    const refusal = await adminWriteObserver(db, admin.actor, ua, () => BEFORE)({ tool: "write", action: undefined, namespace: "sample" }, ua);
    assert.equal(refusal, null);
    assert.ok(String(params(rows[0]).user_agent ?? "").length <= 200, "a field was stored unbounded");
  }
});

// initialize

test("initializeClient reads the clientInfo name from an initialize, alone or in a batch", () => {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-ai", version: "0.1.0" } } };
  assert.deepEqual(initializeClient(init), { client_name: "claude-ai", protocol_version: "2025-06-18" });
  assert.deepEqual(initializeClient([{ jsonrpc: "2.0", method: "ping" }, init]), { client_name: "claude-ai", protocol_version: "2025-06-18" });
  assert.equal(initializeClient({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} }), null);
  assert.equal(initializeClient(null), null);
  assert.deepEqual(initializeClient({ method: "initialize", params: { clientInfo: { name: 7 } } }), { client_name: null, protocol_version: null });
});

function post(body: string, headers: Record<string, string> = {}) {
  return new Request("https://mcp.example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(body).length), "user-agent": "Claude-User", ...headers },
    body,
  });
}
const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "2" } } });

test("an initialize is recorded with its client name and User-Agent, and the request body is still readable after", async () => {
  const { db, rows } = fakeDb();
  const request = post(INIT);
  assert.equal(await recordAdminInitialize(db, admin.actor, request, () => BEFORE), true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].binds[1], "admin-initialize");
  assert.deepEqual(params(rows[0]), { client_name: "claude-code", protocol_version: "2025-06-18", user_agent: "Claude-User" });
  assert.equal(await request.text(), INIT, "the clone consumed the handler's body");
});

test("a tools/call, a GET, a malformed body, an oversize body and the closed window record no initialize", async () => {
  const { db, rows } = fakeDb();
  const call = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "write" } });
  assert.equal(await recordAdminInitialize(db, admin.actor, post(call), () => BEFORE), false);
  assert.equal(await recordAdminInitialize(db, admin.actor, new Request("https://mcp.example.com/mcp"), () => BEFORE), false);
  assert.equal(await recordAdminInitialize(db, admin.actor, post("not json"), () => BEFORE), false);
  assert.equal(await recordAdminInitialize(db, admin.actor, post(INIT, { "content-length": "99999" }), () => BEFORE), false);
  assert.equal(await recordAdminInitialize(db, admin.actor, post(INIT), () => AFTER), false);
  assert.equal(rows.length, 0);
});

test("an initialize whose row cannot be written throws, so the admin's connect fails loudly", async () => {
  const { db } = fakeDb(true);
  await assert.rejects(recordAdminInitialize(db, admin.actor, post(INIT), () => BEFORE), /D1_ERROR: unavailable/);
});

// wiring: the only admin /mcp route passes the observer, and the registrar is given it

test("src/index.ts builds the admin server with the observer, and buildServer hands it to the registrar", () => {
  const index = readFileSync(join(import.meta.dirname, "..", "src", "index.ts"), "utf8");
  assert.match(index, /recordAdminInitialize\(env\.DB, admin\.actor, request\)/);
  assert.match(index, /buildServer\(env, admin, "", observe\)/);
  const server = readFileSync(join(import.meta.dirname, "..", "src", "server.ts"), "utf8");
  assert.match(server, /guardRegistrations\(server, agent, observeAdminWrite\)/);
});
