import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultScopes, serializeScopes } from "../src/agents-schema";
import { ADMIN_MCP_ROUTE } from "../src/mcp-handler";
import { CAPSID_ADMIN_TOOLS, CAPSID_TOOLS } from "../src/tools/surface";
import { authorize, call, ORIGIN, REDIRECT, tokenRequest, VERIFIER } from "./oauth-flow";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";

// Which server each route builds for which caller, through the whole Worker.

const ERA = "2025-11-25";
const DRIVER_KEY = "capsid_agent_" + "a".repeat(64);

beforeEach(async () => {
  // A driver minted for one namespace with read and write: everything a driver can hold
  // except the admin identity.
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  await env.DB.prepare("DELETE FROM agents WHERE id = 'agent_adminroute01'").run();
  await env.DB.prepare(
    `INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at)
     VALUES ('agent_adminroute01', 'capsid-driver', 'driver', ?1, ?2, 'github:dustin', '2026-10-10 00:00:00')`,
  )
    .bind(await sha256Hex(DRIVER_KEY), serializeScopes(scopes))
    .run();
});

interface RpcAnswer {
  status: number;
  text: string;
  message: { result?: Record<string, unknown>; error?: { code: number; message: string } } | null;
}

function rpcMessage(text: string): RpcAnswer["message"] {
  try {
    return JSON.parse(text);
  } catch {}
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      const parsed = JSON.parse(line.slice(5).trim());
      if (parsed && typeof parsed === "object" && ("result" in parsed || "error" in parsed))
        return parsed;
    } catch {}
  }
  return null;
}

let rpcId = 0;
async function rpc(
  path: string,
  bearer: string | null,
  method: string,
  params?: Record<string, unknown>,
  notification = false,
): Promise<RpcAnswer> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params) body.params = params;
  if (!notification) body.id = ++rpcId;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (method !== "initialize") headers["mcp-protocol-version"] = ERA;
  const response = await call(
    new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
  );
  const text = await response.text();
  return { status: response.status, text, message: rpcMessage(text) };
}

async function listTools(
  path: string,
  bearer: string,
): Promise<{ server: string; tools: string[] }> {
  const init = await rpc(path, bearer, "initialize", {
    protocolVersion: ERA,
    capabilities: {},
    clientInfo: { name: "admin-route", version: "1.0.0" },
  });
  expect(init.status, init.text.slice(0, 300)).toBe(200);
  expect(init.message?.error, init.text.slice(0, 300)).toBeUndefined();
  const server = String((init.message?.result?.serverInfo as { name?: string } | undefined)?.name);
  const ack = await rpc(path, bearer, "notifications/initialized", undefined, true);
  expect(ack.status, ack.text.slice(0, 300)).toBeGreaterThanOrEqual(200);
  expect(ack.status, ack.text.slice(0, 300)).toBeLessThan(300);
  const list = await rpc(path, bearer, "tools/list", {});
  expect(list.status, list.text.slice(0, 300)).toBe(200);
  expect(list.message?.error, list.text.slice(0, 300)).toBeUndefined();
  const tools = ((list.message?.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name);
  return { server, tools };
}

const sorted = (names: readonly string[]) => [...names].sort();

describe("/ops/mcp serves Capsid and no Capsid Admin tool", () => {
  it("PLANT: lists exactly Capsid's tools to a key", async () => {
    const { server, tools } = await listTools("/ops/mcp", DRIVER_KEY);
    expect(server).toBe("capsid");
    expect(sorted(tools)).toEqual(sorted(CAPSID_TOOLS));
  });
});

async function adminToken(): Promise<string> {
  const { clientId, code } = await authorize(env.ADMIN_EMAIL!);
  expect(code, "the callback sent no code back").toBeTruthy();
  const exchanged = await tokenRequest({
    grant_type: "authorization_code",
    code: code!,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: VERIFIER,
  });
  expect(exchanged.status, await exchanged.clone().text()).toBe(200);
  return ((await exchanged.json()) as { access_token: string }).access_token;
}

describe(`${ADMIN_MCP_ROUTE}, for the administrator's OAuth session`, () => {
  it("the admin's token lists exactly the Capsid Admin tools on /mcp/admin, and Capsid's on /mcp", async () => {
    const token = await adminToken();
    const admin = await listTools(ADMIN_MCP_ROUTE, token);
    expect(admin.server).toBe("capsid-admin");
    expect(sorted(admin.tools)).toEqual(sorted(CAPSID_ADMIN_TOOLS));
    const capsid = await listTools("/mcp", token);
    expect(capsid.server).toBe("capsid");
    expect(sorted(capsid.tools)).toEqual(sorted(CAPSID_TOOLS));
  });
});
