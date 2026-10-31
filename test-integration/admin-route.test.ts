import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { forgetKeys } from "@dustinedwards/site-runtime/access-login";

import { defaultScopes, serializeScopes } from "../src/agents-schema";
import { ADMIN_MCP_ROUTE, ADMIN_OPS_MCP_ROUTE } from "../src/mcp-handler";
import { CAPSID_ADMIN_TOOLS, CAPSID_TOOLS } from "../src/tools/surface";
import { stubAccess } from "@dustinedwards/devkit/access";
import { cimdClient, cimdResponse } from "./cimd-stub";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";

// CAPSID ADMIN ON ITS OWN ROUTES (capsid/rulings/mcp-2026-10-10.md, amendment answer 2),
// through the WHOLE Worker: the host rules, the OAuth provider, src/routes.ts
// handleOperatorAdminMcp and src/index.ts apiHandler. The unit tests prove what each
// server registers; this proves which server each route builds for which caller.
//
//   /ops/mcp/admin  a key. 401 with none, 403 for any key that is not the admin's, and
//                   both before a server is built. The admin key lists the 8 admin tools.
//   /ops/mcp        Capsid's 14 and no capsid_admin_ tool, even for the admin key.
//   /mcp/admin      the administrator's OAuth session, which lists the 8 admin tools.
//
// The calls are the ones .claude/rules/deploy.md names: initialize,
// notifications/initialized, tools/list, in the 2025-11-25 era.

const ORIGIN = "https://mcp.dustinedwards.info";
const ERA = "2025-11-25";
const DRIVER_KEY = "capsid_agent_" + "a".repeat(64);
const REDIRECT = "https://client.example.com/callback";
// RFC 7636 appendix B, as in oauth-round-trip.test.ts.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

beforeEach(async () => {
  // A driver minted for one namespace with read and write: everything a driver can hold
  // except the admin identity.
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  await env.DB.prepare("DELETE FROM agents WHERE id = 'agent_adminroute01'").run();
  await env.DB.prepare(
    `INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at)
     VALUES ('agent_adminroute01', 'capsid-driver', 'driver', ?1, ?2, 'github:dustin', '2026-10-10 00:00:00')`
  )
    .bind(await sha256Hex(DRIVER_KEY), serializeScopes(scopes))
    .run();
});

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch!(request as never, { ...env, COOKIE_ENCRYPTION_KEY: "integration-cookie-key" } as never, ctx);
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}

interface RpcAnswer {
  status: number;
  text: string;
  message: { result?: Record<string, unknown>; error?: { code: number; message: string } } | null;
}

// A JSON-RPC answer from a JSON body, or from the data: line of an event stream.
function rpcMessage(text: string): RpcAnswer["message"] {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: read it as an event stream below.
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      const parsed = JSON.parse(line.slice(5).trim());
      if (parsed && typeof parsed === "object" && ("result" in parsed || "error" in parsed)) return parsed;
    } catch {
      // A data line that is not JSON is not the answer; keep reading.
    }
  }
  return null;
}

let rpcId = 0;
async function rpc(path: string, bearer: string | null, method: string, params?: Record<string, unknown>, notification = false): Promise<RpcAnswer> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params) body.params = params;
  if (!notification) body.id = ++rpcId;
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (method !== "initialize") headers["mcp-protocol-version"] = ERA;
  const response = await call(new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
  const text = await response.text();
  return { status: response.status, text, message: rpcMessage(text) };
}

// initialize, notifications/initialized, tools/list. Returns the server's name and the
// listed tool names.
async function listTools(path: string, bearer: string): Promise<{ server: string; tools: string[] }> {
  const init = await rpc(path, bearer, "initialize", { protocolVersion: ERA, capabilities: {}, clientInfo: { name: "admin-route", version: "1.0.0" } });
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

async function callTool(path: string, bearer: string, name: string, args: Record<string, unknown>): Promise<RpcAnswer> {
  await rpc(path, bearer, "initialize", { protocolVersion: ERA, capabilities: {}, clientInfo: { name: "admin-route", version: "1.0.0" } });
  await rpc(path, bearer, "notifications/initialized", undefined, true);
  return rpc(path, bearer, "tools/call", { name, arguments: args });
}

const sorted = (names: readonly string[]) => [...names].sort();

describe(`${ADMIN_OPS_MCP_ROUTE}, for a key`, () => {
  it("PLANT: answers 401 with no key, before any server is built", async () => {
    for (const method of ["initialize", "tools/list"]) {
      const answer = await rpc(ADMIN_OPS_MCP_ROUTE, null, method, method === "initialize" ? { protocolVersion: ERA, capabilities: {}, clientInfo: { name: "admin-route", version: "1.0.0" } } : {});
      expect(answer.status, answer.text).toBe(401);
      expect(answer.text).toMatch(/an admin operator key is required/);
      // The route's own refusal, not a server's: no JSON-RPC answer came back.
      expect(answer.message, "a JSON-RPC answer came back, so a server was built").toBeNull();
    }
  });

  it("PLANT: answers 401 to a key that resolves to nobody", async () => {
    const answer = await rpc(ADMIN_OPS_MCP_ROUTE, "capsid_agent_" + "f".repeat(64), "tools/list", {});
    expect(answer.status, answer.text).toBe(401);
    expect(answer.message).toBeNull();
  });

  it("PLANT: answers 403 to a non-admin driver key, before any server is built, and serves it nothing", async () => {
    for (const method of ["initialize", "tools/list"]) {
      const answer = await rpc(ADMIN_OPS_MCP_ROUTE, DRIVER_KEY, method, method === "initialize" ? { protocolVersion: ERA, capabilities: {}, clientInfo: { name: "admin-route", version: "1.0.0" } } : {});
      expect(answer.status, answer.text).toBe(403);
      expect(answer.text).toMatch(/agent:capsid-driver is not the admin\. Capsid Admin serves the administrator alone/);
      expect(answer.message, "a JSON-RPC answer came back, so a server was built").toBeNull();
    }
    // An admin tool named outright is refused the same way, by the route.
    const called = await rpc(ADMIN_OPS_MCP_ROUTE, DRIVER_KEY, "tools/call", { name: "capsid_admin_read_claims", arguments: { namespace: "capsid" } });
    expect(called.status).toBe(403);
    expect(called.message).toBeNull();
    // The same key is good on /ops/mcp, so the 403 above was about the route.
    const capsid = await listTools("/ops/mcp", DRIVER_KEY);
    expect(capsid.tools.length).toBeGreaterThan(0);
  });

  it("PLANT: answers 403 to the read-only operator key, which is not the admin", async () => {
    const answer = await rpc(ADMIN_OPS_MCP_ROUTE, env.TEST_OPERATOR_KEYS.read, "tools/list", {});
    expect(answer.status, answer.text).toBe(403);
    expect(answer.message).toBeNull();
  });

  it("lists exactly the 8 Capsid Admin tools to the admin key", async () => {
    const { server, tools } = await listTools(ADMIN_OPS_MCP_ROUTE, env.TEST_OPERATOR_KEYS.write);
    expect(server).toBe("capsid-admin");
    expect(tools).toHaveLength(8);
    expect(sorted(tools)).toEqual(sorted(CAPSID_ADMIN_TOOLS));
    for (const name of tools) expect(name.startsWith("capsid_admin_"), name).toBe(true);
  });

  it("serves an admin tool's call to the admin key", async () => {
    const answer = await callTool(ADMIN_OPS_MCP_ROUTE, env.TEST_OPERATOR_KEYS.write, "capsid_admin_read_claims", { namespace: "sample" });
    expect(answer.status, answer.text.slice(0, 300)).toBe(200);
    expect(answer.message?.error, answer.text.slice(0, 300)).toBeUndefined();
    const result = answer.message?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError, result.content[0]?.text).not.toBe(true);
  });
});

describe("/ops/mcp serves Capsid and no Capsid Admin tool", () => {
  it("PLANT: lists exactly Capsid's 14 to the admin key, and no capsid_admin_ tool", async () => {
    const { server, tools } = await listTools("/ops/mcp", env.TEST_OPERATOR_KEYS.write);
    expect(server).toBe("capsid");
    expect(tools).toHaveLength(14);
    expect(sorted(tools)).toEqual(sorted(CAPSID_TOOLS));
    expect(tools.filter((t) => t.startsWith("capsid_admin_"))).toEqual([]);
  });

  it("PLANT: an admin tool called on /ops/mcp, even by the admin key, does not run", async () => {
    const answer = await callTool("/ops/mcp", env.TEST_OPERATOR_KEYS.write, "capsid_admin_read_claims", { namespace: "sample" });
    const result = answer.message?.result as { isError?: boolean; content?: Array<{ text: string }> } | undefined;
    const refused = answer.message?.error !== undefined || result?.isError === true;
    expect(refused, `capsid_admin_read_claims ran on /ops/mcp: ${answer.text.slice(0, 300)}`).toBe(true);
    expect(answer.text).toMatch(/capsid_admin_read_claims/);
  });
});

// The OAuth flow as test-integration/oauth-round-trip.test.ts runs it: a CIMD client,
// consent, the stubbed Access sign-in, and the code exchange with PKCE.
const cookieValues = (response: Response): string[] => response.headers.getSetCookie().map((c) => c.split(";")[0]);

function hidden(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  expect(match, `the dialog has no hidden ${name} field`).toBeTruthy();
  return match![1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

async function adminToken(): Promise<string> {
  const clientId = cimdClient([REDIRECT], "admin-route");
  const url = new URL(`${ORIGIN}/authorize`);
  for (const [k, v] of Object.entries({ client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: CHALLENGE, code_challenge_method: "S256", state: "client-state" })) {
    url.searchParams.set(k, v);
  }
  const dialog = await call(new Request(url));
  expect(dialog.status).toBe(200);
  const html = await dialog.text();
  const approved = await call(
    new Request(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieValues(dialog).join("; ") },
      body: new URLSearchParams({ handle: hidden(html, "handle"), decision: "approve", allow_write: "1" }).toString(),
    })
  );
  expect(approved.status).toBe(302);
  const signIn = new URL(String(approved.headers.get("location")));
  const state = String(signIn.searchParams.get("state"));
  const stateCookie = cookieValues(approved).join("; ");
  // Each stub signs with a key of its own under the same kid, and the verifier keeps the
  // keys it read per JWKS URL, so the last sign-in's key is dropped first.
  forgetKeys();
  const access = await stubAccess({
    issuer: `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${env.ACCESS_SAAS_CLIENT_ID}`,
    audience: env.ACCESS_SAAS_CLIENT_ID!,
    email: env.ADMIN_EMAIL!,
    authorizationUrl: signIn.href,
    fallback: (u) => cimdResponse(u) ?? undefined,
  });
  let callback: Response;
  try {
    callback = await call(new Request(`${ORIGIN}/callback?code=access-code&state=${state}`, { headers: { Cookie: stateCookie } }));
  } finally {
    access.restore();
  }
  const location = callback.headers.get("location");
  const code = location && location.startsWith(REDIRECT) ? new URL(location).searchParams.get("code") : null;
  expect(code, `the callback did not send a code back: ${callback.status} ${location}`).toBeTruthy();
  const exchanged = await call(
    new Request(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: code!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: VERIFIER }).toString(),
    })
  );
  expect(exchanged.status, await exchanged.clone().text()).toBe(200);
  return ((await exchanged.json()) as { access_token: string }).access_token;
}

describe(`${ADMIN_MCP_ROUTE}, for the administrator's OAuth session`, () => {
  it("the admin's token reaches /mcp/admin and lists exactly the 8 Capsid Admin tools; on /mcp it lists Capsid's 14", async () => {
    const token = await adminToken();
    const admin = await listTools(ADMIN_MCP_ROUTE, token);
    expect(admin.server).toBe("capsid-admin");
    expect(admin.tools).toHaveLength(8);
    expect(sorted(admin.tools)).toEqual(sorted(CAPSID_ADMIN_TOOLS));

    const capsid = await listTools("/mcp", token);
    expect(capsid.server).toBe("capsid");
    expect(capsid.tools).toHaveLength(14);
    expect(sorted(capsid.tools)).toEqual(sorted(CAPSID_TOOLS));
    expect(capsid.tools.filter((t) => t.startsWith("capsid_admin_"))).toEqual([]);
  });

  it("PLANT: /mcp/admin without a token is a 401, and serves nothing", async () => {
    const answer = await rpc(ADMIN_MCP_ROUTE, null, "tools/list", {});
    expect(answer.status, answer.text).toBe(401);
    expect(answer.message?.result).toBeUndefined();
  });
});
