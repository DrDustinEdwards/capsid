import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { forgetKeys } from "@dustinedwards/site-runtime/access-login";
import { stubAccess } from "@dustinedwards/devkit/access";
import { cimdClient, cimdResponse } from "./cimd-stub";

// THE WHOLE OAUTH ROUND TRIP, through the real provider in workerd: a CIMD client, consent,
// the Access for SaaS sign-in (stubbed, with a real signed ID token), the code exchange with PKCE, an MCP call
// with the issued token, and a refresh. workers-oauth-provider 1.0 binds every token to
// the canonical resource and requires the exchange's redirect_uri to equal the
// authorization request's, so this is the test that says an upgrade changed nothing a
// client sees. It runs on the canonical host, the one tokens are bound to.

// The MCP endpoint's host (src/mcp-host.ts): the round trip runs through its provider.
const ORIGIN = "https://mcp.dustinedwards.info";
const REDIRECT = "https://client.example.com/callback";
// RFC 7636 appendix B: this verifier's S256 challenge is E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
// The Access for SaaS application the test bindings in vitest.config.ts name.
const ISSUER = `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${env.ACCESS_SAAS_CLIENT_ID}`;

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch!(request as never, { ...env, COOKIE_ENCRYPTION_KEY: "integration-cookie-key" } as never, ctx);
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}

const cookieValues = (response: Response): string[] => response.headers.getSetCookie().map((c) => c.split(";")[0]);

function hidden(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  expect(match, `the dialog has no hidden ${name} field`).toBeTruthy();
  return match![1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

async function tokenRequest(body: Record<string, string>): Promise<Response> {
  return call(
    new Request(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    })
  );
}

async function mcpInitialize(accessToken: string): Promise<Response> {
  return call(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "round-trip", version: "1.0.0" } },
      }),
    })
  );
}

// Runs the flow up to the code, as `login`. Returns the client id and the code.
async function authorize(email: string, extra: Record<string, unknown> = {}, sameClient?: string, write = true): Promise<{ clientId: string; code: string | null; callback: Response; tokenBodies: URLSearchParams[]; signIn: URL }> {
  const clientId = sameClient ?? cimdClient([REDIRECT], "round-trip");

  const url = new URL(`${ORIGIN}/authorize`);
  for (const [k, v] of Object.entries({ client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: CHALLENGE, code_challenge_method: "S256", state: "client-state" })) {
    url.searchParams.set(k, v);
  }
  const dialog = await call(new Request(url));
  expect(dialog.status).toBe(200);
  const html = await dialog.text();
  // The consent form as site-runtime's loginHandler renders it: the provider's one-time
  // handle, and the write box ticked unless this sign-in is read-only.
  const form = new URLSearchParams({ handle: hidden(html, "handle"), decision: "approve" });
  if (write) form.set("allow_write", "1");
  const approved = await call(
    new Request(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieValues(dialog).join("; ") },
      body: form.toString(),
    })
  );
  expect(approved.status).toBe(302);
  const signIn = new URL(String(approved.headers.get("location")));
  const state = String(signIn.searchParams.get("state"));
  const stateCookie = cookieValues(approved).join("; ");

  // Each stub signs with a key of its own under the same kid, and the verifier keeps the
  // keys it read per JWKS URL, so the last sign-in's key is dropped first.
  forgetKeys();
  // The stub swaps the global fetch outright, so it is put back here rather than by
  // vi.restoreAllMocks. The token exchange after it finds the client documents again.
  const access = await stubAccess({ issuer: ISSUER, audience: env.ACCESS_SAAS_CLIENT_ID!, email, authorizationUrl: signIn.href, claims: extra, fallback: (u) => cimdResponse(u) ?? undefined });
  let callback: Response;
  try {
    callback = await call(new Request(`${ORIGIN}/callback?code=access-code&state=${state}`, { headers: { Cookie: stateCookie } }));
  } finally {
    access.restore();
  }
  const tokenBodies = access.tokenRequests;
  const location = callback.headers.get("location");
  const code = location && location.startsWith(REDIRECT) ? new URL(location).searchParams.get("code") : null;
  return { clientId, code, callback, tokenBodies, signIn };
}

describe("the OAuth round trip", () => {
  it("the admin gets a code, a token that opens /mcp, and a refresh that does too", async () => {
    const { clientId, code, callback, tokenBodies, signIn } = await authorize(env.ADMIN_EMAIL!);
    // The browser went to the Access SaaS app, with PKCE and a nonce, and the callback
    // exchanged the code with the verifier behind that challenge.
    expect(`${signIn.origin}${signIn.pathname}`).toBe(`${ISSUER}/authorization`);
    expect(signIn.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
    expect(signIn.searchParams.get("code_challenge_method")).toBe("S256");
    expect(signIn.searchParams.get("nonce")).toBeTruthy();
    expect(tokenBodies[0]?.get("code_verifier")).toBeTruthy();
    expect(tokenBodies[0]?.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
    expect(callback.status).toBe(302);
    expect(code, `the callback did not send a code back to the client: ${callback.headers.get("location")}`).toBeTruthy();
    expect(new URL(String(callback.headers.get("location"))).searchParams.get("state")).toBe("client-state");

    const exchanged = await tokenRequest({ grant_type: "authorization_code", code: code!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: VERIFIER });
    expect(exchanged.status, await exchanged.clone().text()).toBe(200);
    const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string; token_type: string };
    expect(tokens.token_type.toLowerCase()).toBe("bearer");

    const opened = await mcpInitialize(tokens.access_token);
    expect(opened.status, await opened.clone().text()).toBe(200);
    expect(await opened.text()).toMatch(/"serverInfo"/);

    const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    const next = (await refreshed.json()) as { access_token: string };
    expect(next.access_token).not.toBe(tokens.access_token);
    expect((await mcpInitialize(next.access_token)).status).toBe(200);
  });

  it("PLANT: a second authorization for the same user and client leaves the first grant usable", async () => {
    // Claude uses one CIMD client id for both the Capsid (/mcp) and Capsid Admin
    // (/mcp/admin) connectors. The provider revokes every earlier grant for the same
    // user and client on each authorization unless src/routes.ts keepingGrants passes
    // revokeExistingGrants: false, so signing into one signed the other out.
    const first = await authorize(env.ADMIN_EMAIL!);
    const exchanged = await tokenRequest({ grant_type: "authorization_code", code: first.code!, redirect_uri: REDIRECT, client_id: first.clientId, code_verifier: VERIFIER });
    expect(exchanged.status, await exchanged.clone().text()).toBe(200);
    const one = (await exchanged.json()) as { access_token: string; refresh_token: string };
    expect((await mcpInitialize(one.access_token)).status, "the first token does not open /mcp before the second sign-in").toBe(200);

    const second = await authorize(env.ADMIN_EMAIL!, {}, first.clientId);
    expect(second.code, "the second authorization sent no code").toBeTruthy();
    const exchangedTwo = await tokenRequest({ grant_type: "authorization_code", code: second.code!, redirect_uri: REDIRECT, client_id: first.clientId, code_verifier: VERIFIER });
    expect(exchangedTwo.status, await exchangedTwo.clone().text()).toBe(200);
    const two = (await exchangedTwo.json()) as { access_token: string };

    expect((await mcpInitialize(two.access_token)).status, "the second token does not open /mcp").toBe(200);
    expect((await mcpInitialize(one.access_token)).status, "the second authorization signed the first grant out").toBe(200);
    const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: one.refresh_token, client_id: first.clientId });
    expect(refreshed.status, "the first grant's refresh token was revoked").toBe(200);
  });

  it("PLANT: a token issued for this server is refused by another resource (RFC 8707 audience)", async () => {
    // Rule 12 of capsid/rulings/mcp-2026-10-10.md: reject any token not issued for this
    // server. The old address is a second resource on the same Worker and the same
    // OAUTH_KV, so the token is found there and refused only for its audience.
    const { clientId, code } = await authorize(env.ADMIN_EMAIL!);
    const exchanged = await tokenRequest({ grant_type: "authorization_code", code: code!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: VERIFIER });
    const { access_token } = (await exchanged.json()) as { access_token: string };
    expect((await mcpInitialize(access_token)).status, "the token does not open its own resource, so the refusal below proves nothing").toBe(200);
    const elsewhere = await call(
      new Request("https://capsid.dustin-edwards.workers.dev/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "audience", version: "1.0.0" } } }),
      })
    );
    expect(elsewhere.status).toBe(401);
    expect(await elsewhere.text()).not.toMatch(/"serverInfo"/);
  });

  it("the exchange refuses a redirect_uri other than the authorization request's", async () => {
    const { clientId, code } = await authorize(env.ADMIN_EMAIL!);
    const refused = await tokenRequest({ grant_type: "authorization_code", code: code!, redirect_uri: "https://client.example.com/other", client_id: clientId, code_verifier: VERIFIER });
    expect(refused.status).toBe(400);
  });

  it("the exchange refuses a wrong PKCE verifier", async () => {
    const { clientId, code } = await authorize(env.ADMIN_EMAIL!);
    const refused = await tokenRequest({ grant_type: "authorization_code", code: code!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: "not-the-verifier-not-the-verifier-not-the-verifier" });
    expect(refused.status).toBe(400);
  });

  it("an Access identity that is not ADMIN_EMAIL or a co-owner gets no code", async () => {
    const { code, callback } = await authorize("someone-else@example.com");
    expect(code).toBeNull();
    expect(new URL(String(callback.headers.get("location"))).searchParams.get("error")).toBe("access_denied");
  });

  it("PLANT: a grant without the write box holds the read grant only, and a write tool is refused", async () => {
    const { clientId, code } = await authorize(env.ADMIN_EMAIL!, {}, undefined, false);
    const exchanged = await tokenRequest({ grant_type: "authorization_code", code: code!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: VERIFIER });
    const { access_token, scope } = (await exchanged.json()) as { access_token: string; scope: string };
    expect(scope).toBe("capsid.read");
    const rpc = (id: number, method: string, params: Record<string, unknown>) =>
      call(
        new Request(`${ORIGIN}/mcp`, {
          method: "POST",
          headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        })
      );
    await rpc(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "read-only", version: "1.0.0" } });
    const written = await (await rpc(2, "tools/call", { name: "capsid_write_doc", arguments: { namespace: "sample", path: "notes/x.md", body: "x" } })).text();
    expect(written, "a read-only grant wrote a document").toMatch(/requires the write grant/);
  });

  it("/mcp without a token is a 401 that names the resource metadata", async () => {
    const response = await call(
      new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) })
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate") ?? "").toMatch(/resource_metadata=/);
    expect(response.headers.get("WWW-Authenticate") ?? "").toMatch(/scope="capsid\.read"/);
  });
});
