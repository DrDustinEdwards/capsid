import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

// THE WHOLE OAUTH ROUND TRIP, through the real provider in workerd: register, consent,
// the GitHub sign-in (stubbed as the admin), the code exchange with PKCE, an MCP call
// with the issued token, and a refresh. workers-oauth-provider 1.0 binds every token to
// the canonical resource and requires the exchange's redirect_uri to equal the
// authorization request's, so this is the test that says an upgrade changed nothing a
// client sees. It runs on the canonical host, the one tokens are bound to.

const ORIGIN = "https://capsid.dustin-edwards.workers.dev";
const REDIRECT = "https://client.example.com/callback";
// RFC 7636 appendix B: this verifier's S256 challenge is E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

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

// GitHub, as the callback reaches it: the token endpoint, then the user endpoint.
function stubGithub(login: string): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "gh-token", token_type: "bearer" });
    if (url.startsWith("https://api.github.com/user")) return Response.json({ id: 7, login, name: "Admin" });
    throw new Error(`unexpected fetch in the round trip: ${url}`);
  });
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
async function authorize(login: string): Promise<{ clientId: string; code: string | null; callback: Response }> {
  const registered = await call(
    new Request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.77" },
      body: JSON.stringify({ client_name: "round-trip", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
    })
  );
  expect(registered.status).toBe(201);
  const clientId = ((await registered.json()) as { client_id: string }).client_id;

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
      body: new URLSearchParams({ csrf: hidden(html, "csrf"), req: hidden(html, "req") }).toString(),
    })
  );
  expect(approved.status).toBe(302);
  const state = String(new URL(String(approved.headers.get("location"))).searchParams.get("state"));
  const stateCookie = cookieValues(approved).find((c) => c.startsWith("capsid_state=")) ?? "";

  stubGithub(login);
  const callback = await call(new Request(`${ORIGIN}/callback?code=gh-code&state=${state}`, { headers: { Cookie: stateCookie } }));
  vi.restoreAllMocks();
  const location = callback.headers.get("location");
  const code = location && location.startsWith(REDIRECT) ? new URL(location).searchParams.get("code") : null;
  return { clientId, code, callback };
}

describe("the OAuth round trip", () => {
  it("the admin gets a code, a token that opens /mcp, and a refresh that does too", async () => {
    const { clientId, code, callback } = await authorize(env.ADMIN_GITHUB_LOGIN);
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

  it("the exchange refuses a redirect_uri other than the authorization request's", async () => {
    const { clientId, code } = await authorize(env.ADMIN_GITHUB_LOGIN);
    const refused = await tokenRequest({ grant_type: "authorization_code", code: code!, redirect_uri: "https://client.example.com/other", client_id: clientId, code_verifier: VERIFIER });
    expect(refused.status).toBe(400);
  });

  it("the exchange refuses a wrong PKCE verifier", async () => {
    const { clientId, code } = await authorize(env.ADMIN_GITHUB_LOGIN);
    const refused = await tokenRequest({ grant_type: "authorization_code", code: code!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: "not-the-verifier-not-the-verifier-not-the-verifier" });
    expect(refused.status).toBe(400);
  });

  it("a GitHub account that is not the admin gets no code", async () => {
    const { code, callback } = await authorize("someone-else");
    expect(code).toBeNull();
    expect(callback.status).toBe(403);
  });

  it("/mcp without a token is a 401 that names the resource metadata", async () => {
    const response = await call(
      new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) })
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate") ?? "").toMatch(/resource_metadata=/);
  });
});
