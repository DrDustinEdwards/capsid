import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// The OAuth surface with a real KV under it. The provider is
// @cloudflare/workers-oauth-provider, wired into src/index.ts; unit tests stop at the
// handlers on either side of that wiring.
//
// Asserted here is what a browser and a client depend on: the discovery documents
// describe this server, /register writes a real client record to a real KV, the
// consent dialog renders with its security headers, and the state cookie is scoped
// so a stolen one is not reusable.

describe("discovery", () => {
  it("serves protected-resource and authorization-server metadata", async () => {
    const resource = await SELF.fetch("https://capsid.test/.well-known/oauth-protected-resource");
    expect(resource.status).toBe(200);
    const resourceDoc = (await resource.json()) as { resource?: string; authorization_servers?: string[] };
    // The audience is pinned to the deployed origin, not to the request's (RFC 8707),
    // which is why this does not say capsid.test: a token minted for this server must
    // not be presentable at whatever host asked for the metadata.
    expect(resourceDoc.resource).toBe("https://capsid.dustin-edwards.workers.dev/mcp");

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
  });
});

describe("dynamic client registration", () => {
  it("registers a client and writes a real record to OAUTH_KV", async () => {
    const response = await SELF.fetch("https://capsid.test/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "integration-client",
        redirect_uris: ["https://client.example.com/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(response.status).toBe(201);
    const client = (await response.json()) as { client_id?: string; redirect_uris?: string[] };
    expect(typeof client.client_id).toBe("string");
    expect(client.redirect_uris).toEqual(["https://client.example.com/callback"]);

    // The record is in KV, under the provider's own prefix.
    const keys = await env.OAUTH_KV.list({ prefix: "client:" });
    expect(keys.keys.length).toBeGreaterThan(0);
    expect(keys.keys.some((k: { name: string }) => k.name.includes(String(client.client_id)))).toBe(true);
  });

  it("refuses a registration with no redirect_uri", async () => {
    const response = await SELF.fetch("https://capsid.test/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "no-redirect" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("authorize", () => {
  async function registerClient(): Promise<string> {
    const response = await SELF.fetch("https://capsid.test/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "authorize-client",
        redirect_uris: ["https://client.example.com/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    const client = (await response.json()) as { client_id: string };
    return client.client_id;
  }

  it("PLANT: the consent dialog renders, with the headers whose absence caused the 26-day outage", async () => {
    const clientId = await registerClient();
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
    expect(html).toContain('action="/authorize"');
    expect(html).toContain("method=\"post\"");

    // The enforced CSP is set by the dialog rather than by src/headers.ts.
    const csp = response.headers.get("content-security-policy");
    expect(csp, "the consent dialog must carry its own enforced CSP").toBeTruthy();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBeTruthy();
  });

  it("refuses an authorize with a redirect_uri the client never registered", async () => {
    const clientId = await registerClient();
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
    // The state cookie is sha256(state) with Path=/callback, so a code arriving
    // without the browser that started the flow has nothing to match against.
    const response = await SELF.fetch("https://capsid.test/callback?code=abc&state=whatever", { redirect: "manual" });
    expect(response.status).not.toBe(302);
    expect(await response.text()).toMatch(/state|expired|session/i);
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

// Two guards driven through real HTTP. A source scan cannot see whether a helper's
// result is used: a callback that computes the refusal and returns the client anyway
// keeps the name in the file.

describe("F9: dynamic client registration refuses more than one non-loopback redirect", () => {
  it("PLANT: two https redirect_uris are refused at POST /register", async () => {
    const response = await SELF.fetch("https://capsid.test/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "two-redirects",
        redirect_uris: ["https://client.example.com/callback", "https://evil.example.com/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("invalid_redirect_uri");

    // Nothing was registered.
    const keys = await env.OAUTH_KV.list({ prefix: "client:" });
    const names = keys.keys.map((k: { name: string }) => k.name).join(" ");
    expect(names).not.toContain("evil.example.com");
  });

  it("THE INNOCENT DIRECTION: several LOOPBACK redirects still register", async () => {
    // Native clients legitimately declare more than one loopback port, which is why
    // the guard counts non-loopback URIs rather than URIs.
    const response = await SELF.fetch("https://capsid.test/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "native-client",
        redirect_uris: ["http://127.0.0.1:8976/callback", "http://127.0.0.1:49152/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(response.status).toBe(201);
  });
});

describe("F10: the Origin allowlist on /mcp", () => {
  it("PLANT: a foreign Origin is refused 403 at POST /mcp", async () => {
    const response = await SELF.fetch("https://capsid.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("is not allowed on /mcp");
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
