import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { cimdClient } from "./cimd-stub";

// The OAuth surface with a real KV under it. The provider is
// @cloudflare/workers-oauth-provider, wired into src/index.ts; unit tests stop at the
// handlers on either side of that wiring.
//
// Asserted here is what a browser and a client depend on: the discovery documents
// describe this server, /register takes only the allowlisted Grok, Gemini and ChatGPT
// callbacks and grants nothing (tightened DCR, site-runtime's registrationRefusal in
// src/index.ts), the consent dialog renders for a client known by its metadata document
// with its security headers, and a callback from another browser is refused.

describe("discovery", () => {
  it("serves protected-resource and authorization-server metadata", async () => {
    // workers-oauth-provider 1.x serves RFC 9728 metadata for the canonical resource at
    // its path-suffixed location only, on the canonical host, and every 401 challenge
    // names that URL. Measured 2026-09-27: 0.10.3 also answered the bare
    // /.well-known/oauth-protected-resource and any host; 1.1.0 answers 404 to both.
    // Each MCP host is its own resource (src/mcp-host.ts): mcp.dustinedwards.info, and the
    // old workers.dev address for the hours of the same-day cut, each served by its own
    // provider (src/index.ts).
    for (const origin of ["https://mcp.dustinedwards.info", "https://capsid.dustin-edwards.workers.dev"]) {
      const resource = await SELF.fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
      expect(resource.status, origin).toBe(200);
      const resourceDoc = (await resource.json()) as { resource?: string; authorization_servers?: string[] };
      // The audience is pinned to the host's own origin (RFC 8707): a token minted for one
      // host must not be presentable at another.
      expect(resourceDoc.resource).toBe(`${origin}/mcp`);
      expect(resourceDoc.authorization_servers).toEqual([origin]);
      expect((await SELF.fetch(`${origin}/.well-known/oauth-protected-resource`)).status).toBe(404);
      const challenge = await SELF.fetch(`${origin}/mcp`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
      expect(challenge.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
    }

    const server = await SELF.fetch("https://capsid.test/.well-known/oauth-authorization-server");
    expect(server.status).toBe(200);
    const serverDoc = (await server.json()) as {
      authorization_endpoint?: string;
      token_endpoint?: string;
      registration_endpoint?: string;
      code_challenge_methods_supported?: string[];
    };
    expect(serverDoc.authorization_endpoint).toContain("/authorize");
    expect(serverDoc.token_endpoint).toContain("/token");
    // PKCE is the provider default, asserted so it cannot change unnoticed.
    expect(serverDoc.code_challenge_methods_supported).toContain("S256");
    // CIMD for Claude, Claude Code and ChatGPT, and tightened DCR for Grok and Gemini,
    // on the MCP host only.
    expect(serverDoc.registration_endpoint).toBe("https://capsid.test/register");
    const legacy = (await (await SELF.fetch("https://capsid.dustin-edwards.workers.dev/.well-known/oauth-authorization-server")).json()) as { registration_endpoint?: string };
    expect(legacy.registration_endpoint).toBeUndefined();
    expect((serverDoc as { client_id_metadata_document_supported?: boolean }).client_id_metadata_document_supported).toBe(true);
  });
});

describe("tightened dynamic client registration", () => {
  const GROK = "https://grok.com/connectors/oauth/callback";
  const clients = async () => (await env.OAUTH_KV.list({ prefix: "client:" })).keys.length;
  const register = (redirects: string[], host = "capsid.test", ip = "198.51.100.20") =>
    SELF.fetch(`https://${host}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ client_name: "integration-client", redirect_uris: redirects, token_endpoint_auth_method: "none" }),
    });

  it("PLANT: an unlisted redirect is refused and writes no client record", async () => {
    const before = await clients();
    const response = await register(["https://client.example.com/callback"]);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_redirect_uri");
    expect(await clients()).toBe(before);
  });

  it("a refused registration spends none of the limit, so the live gate's probe cannot use it up", async () => {
    // Five an hour per address: six refusals from one address all answer 400, never 429
    // (run 41245505021 rolled a deploy back when the gate's probes had spent the day's 30).
    for (let i = 0; i < 6; i++) {
      const response = await register(["https://client.example.com/callback"], "capsid.test", "198.51.100.30");
      expect(response.status, `refusal ${i + 1}`).toBe(400);
    }
  });

  it("the old address registers nothing", async () => {
    const before = await clients();
    const response = await register([GROK], "capsid.dustin-edwards.workers.dev");
    expect(response.status).not.toBe(201);
    expect(await clients()).toBe(before);
  });

  it("PLANT: Grok's callback registers, and the registration grants nothing: the client meets the consent page", async () => {
    const before = await clients();
    const response = await register([GROK], "capsid.test", "198.51.100.21");
    expect(response.status, await response.clone().text()).toBe(201);
    const registered = (await response.json()) as { client_id: string; redirect_uris: string[]; access_token?: string };
    expect(registered.redirect_uris).toEqual([GROK]);
    expect(registered.access_token).toBeUndefined();
    expect(await clients()).toBe(before + 1);

    const url = new URL("https://capsid.test/authorize");
    for (const [k, v] of Object.entries({ client_id: registered.client_id, redirect_uri: GROK, response_type: "code", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", state: "s" })) {
      url.searchParams.set(k, v);
    }
    const dialog = await SELF.fetch(url.toString(), { redirect: "manual" });
    expect(dialog.status, "a registered client skipped the consent page").toBe(200);
    expect(await dialog.text()).toContain('name="handle"');
  });
});

describe("authorize", () => {
  // A client known only by its metadata document (./cimd-stub).
  function registerClient(): string {
    return cimdClient(["https://client.example.com/callback"], "authorize-client");
  }

  it("PLANT: the consent dialog renders, with the headers whose absence caused the 26-day outage", async () => {
    const clientId = registerClient();
    const url = new URL("https://capsid.test/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/callback");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "integration-state");

    const response = await SELF.fetch(url.toString());
    expect(response.status).toBe(200);
    const html = await response.text();
    // The dialog itself, which a CSP set elsewhere can blank by blocking its inline
    // style and form.
    expect(html).toContain("method=\"post\"");

    // The enforced CSP is set by the dialog rather than by src/security-headers.ts.
    const csp = response.headers.get("content-security-policy");
    expect(csp, "the consent dialog must carry its own enforced CSP").toBeTruthy();
  });

  it("refuses an authorize with a redirect_uri the client never registered", async () => {
    const clientId = registerClient();
    const url = new URL("https://capsid.test/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://attacker.example.com/collect");
    url.searchParams.set("response_type", "code");
    const response = await SELF.fetch(url.toString());
    // Whatever the shape of the refusal, it must not be a 200 consent page for an
    // unregistered destination, and it must not redirect there.
    expect(response.status).not.toBe(200);
    expect(response.headers.get("location") ?? "").not.toContain("attacker.example.com");
  });
});

describe("callback", () => {
  it("PLANT: a callback with no state cookie is refused rather than followed", async () => {
    // The provider's upstream state is bound to the browser that started the flow by its
    // own cookie, so a code arriving without it has nothing to match against.
    const response = await SELF.fetch("https://capsid.test/callback?code=abc&state=whatever", { redirect: "manual" });
    expect(response.status).not.toBe(302);
    expect(await response.text()).toMatch(/sign-in/i);
  });
});

describe("the token endpoint", () => {
  it("refuses an authorization_code grant that was never issued", async () => {
    const response = await SELF.fetch("https://capsid.test/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "a-code-that-was-never-issued",
        redirect_uri: "https://client.example.com/callback",
        client_id: "nobody",
        code_verifier: "x".repeat(43),
      }).toString(),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await response.text();
    expect(body).toMatch(/invalid|grant|client/i);
  });
});

// A guard driven through real HTTP. A source scan cannot see whether a helper's result
// is used.

describe("F10: the Origin allowlist on /mcp", () => {
  it("PLANT: a foreign Origin is refused 403 at POST /mcp", async () => {
    const response = await SELF.fetch("https://capsid.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(403);
  });

  it("THE INNOCENT DIRECTION: no Origin and claude.ai are not refused by THIS guard", async () => {
    // Both still fail auth, a different guard with a different status; the origin
    // check is not what stopped them.
    const noOrigin = await SELF.fetch("https://capsid.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(noOrigin.status).not.toBe(403);

    const claude = await SELF.fetch("https://capsid.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://claude.ai" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(claude.status).not.toBe(403);
  });
});
