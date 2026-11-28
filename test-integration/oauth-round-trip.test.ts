import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_MCP_ROUTE } from "../src/mcp-handler";
import { authorize, call, ISSUER, ORIGIN, REDIRECT, tokenRequest, VERIFIER } from "./oauth-flow";

// workers-oauth-provider binds tokens to the canonical resource and requires matching redirect_uris, so an upgrade
// that changes what a client sees fails here.

afterEach(() => {
  vi.restoreAllMocks();
});

async function mcpInitialize(accessToken: string): Promise<Response> {
  return call(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "round-trip", version: "1.0.0" },
        },
      }),
    }),
  );
}

describe("the OAuth round trip", () => {
  it("the admin gets a code, a token that opens /mcp, and a refresh that does too", async () => {
    const { clientId, code, callback, tokenBodies, signIn } = await authorize(env.ADMIN_EMAIL!);
    expect(`${signIn.origin}${signIn.pathname}`).toBe(`${ISSUER}/authorization`);
    expect(signIn.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
    expect(signIn.searchParams.get("code_challenge_method")).toBe("S256");
    expect(signIn.searchParams.get("nonce")).toBeTruthy();
    expect(tokenBodies[0]?.get("code_verifier")).toBeTruthy();
    expect(tokenBodies[0]?.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
    expect(callback.status).toBe(302);
    expect(
      code,
      `the callback did not send a code back to the client: ${callback.headers.get("location")}`,
    ).toBeTruthy();
    expect(new URL(String(callback.headers.get("location"))).searchParams.get("state")).toBe(
      "client-state",
    );

    const exchanged = await tokenRequest({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: VERIFIER,
    });
    expect(exchanged.status, await exchanged.clone().text()).toBe(200);
    const tokens = (await exchanged.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
    };
    expect(tokens.token_type.toLowerCase()).toBe("bearer");

    const opened = await mcpInitialize(tokens.access_token);
    expect(opened.status, await opened.clone().text()).toBe(200);
    expect(await opened.text()).toMatch(/"serverInfo"/);

    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    const next = (await refreshed.json()) as { access_token: string };
    expect(next.access_token).not.toBe(tokens.access_token);
    expect((await mcpInitialize(next.access_token)).status).toBe(200);
  });

  it("PLANT: a second authorization for the same user and client leaves the first grant usable", async () => {
    // Claude uses one CIMD client id for both the Capsid (/mcp) and Capsid Admin
    // (/mcp/admin) connectors. The provider revokes every earlier grant for the same
    // user and client on each authorization unless src/routes.ts passes loginHandler
    // revokeExistingGrants: false, so signing into one signed the other out.
    const first = await authorize(env.ADMIN_EMAIL!);
    const exchanged = await tokenRequest({
      grant_type: "authorization_code",
      code: first.code!,
      redirect_uri: REDIRECT,
      client_id: first.clientId,
      code_verifier: VERIFIER,
    });
    expect(exchanged.status, await exchanged.clone().text()).toBe(200);
    const one = (await exchanged.json()) as { access_token: string; refresh_token: string };
    expect(
      (await mcpInitialize(one.access_token)).status,
      "the first token does not open /mcp before the second sign-in",
    ).toBe(200);

    const second = await authorize(env.ADMIN_EMAIL!, {}, first.clientId);
    expect(second.code, "the second authorization sent no code").toBeTruthy();
    const exchangedTwo = await tokenRequest({
      grant_type: "authorization_code",
      code: second.code!,
      redirect_uri: REDIRECT,
      client_id: first.clientId,
      code_verifier: VERIFIER,
    });
    expect(exchangedTwo.status, await exchangedTwo.clone().text()).toBe(200);
    const two = (await exchangedTwo.json()) as { access_token: string };

    expect(
      (await mcpInitialize(two.access_token)).status,
      "the second token does not open /mcp",
    ).toBe(200);
    expect(
      (await mcpInitialize(one.access_token)).status,
      "the second authorization signed the first grant out",
    ).toBe(200);
    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: one.refresh_token,
      client_id: first.clientId,
    });
    expect(refreshed.status, "the first grant's refresh token was revoked").toBe(200);
  });

  it("PLANT: a token issued for this server is refused by another resource (RFC 8707 audience)", async () => {
    // Reject any token not issued for this server: another host on the same Worker reaches the same OAUTH_KV, so the token is found there and refused only for its audience.
    const { clientId, code } = await authorize(env.ADMIN_EMAIL!);
    const exchanged = await tokenRequest({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: VERIFIER,
    });
    const { access_token } = (await exchanged.json()) as { access_token: string };
    expect(
      (await mcpInitialize(access_token)).status,
      "the token does not open its own resource, so the refusal below proves nothing",
    ).toBe(200);
    const elsewhere = await call(
      new Request("https://elsewhere.example.com/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "audience", version: "1.0.0" },
          },
        }),
      }),
    );
    expect(elsewhere.status).toBe(401);
    expect(await elsewhere.text()).not.toMatch(/"serverInfo"/);
  });

  it("the exchange refuses a redirect_uri other than the authorization request's, and a wrong PKCE verifier", async () => {
    for (const bad of [
      { redirect_uri: "https://client.example.com/other" },
      { code_verifier: "not-the-verifier-not-the-verifier-not-the-verifier" },
    ]) {
      const { clientId, code } = await authorize(env.ADMIN_EMAIL!);
      const refused = await tokenRequest({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: VERIFIER,
        ...bad,
      });
      expect(refused.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("an Access identity that is not ADMIN_EMAIL or a co-owner gets no code", async () => {
    const { code, callback } = await authorize("someone-else@example.com");
    expect(code).toBeNull();
    expect(new URL(String(callback.headers.get("location"))).searchParams.get("error")).toBe(
      "access_denied",
    );
  });

  it("PLANT: a grant without the write box holds the read grant only: a write tool is not served, and a write action is answered 403 insufficient_scope (step-up)", async () => {
    const { clientId, code } = await authorize(env.ADMIN_EMAIL!, {}, undefined, false);
    const exchanged = await tokenRequest({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: VERIFIER,
    });
    const { access_token, scope } = (await exchanged.json()) as {
      access_token: string;
      scope: string;
    };
    expect(scope).toBe("capsid.read");
    const rpc = (id: number, method: string, params: Record<string, unknown>) =>
      call(
        new Request(`${ORIGIN}/mcp`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${access_token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        }),
      );
    await rpc(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "read-only", version: "1.0.0" },
    });
    // A write-only tool is not served to a read grant, so a call to it is an unknown tool and never runs.
    const written = await rpc(2, "tools/call", {
      name: "capsid_write_doc",
      arguments: { namespace: "sample", path: "notes/x.md", body: "x" },
    });
    expect(await written.text(), "a read-only grant reached the write tool").toMatch(
      /capsid_write_doc not found/,
    );
    const posted = await rpc(3, "tools/call", {
      name: "capsid_lint_namespace",
      arguments: { mode: "finalize", namespace: "sample" },
    });
    expect(posted.status, "a read-only grant reached a write action").toBe(403);
    const challenge = posted.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toMatch(/error="insufficient_scope"/);
    expect(challenge).toMatch(/scope="capsid\.read capsid\.write"/);
    expect(challenge).toMatch(/resource_metadata=/);
  });

  it("/mcp without a token is a 401 that names the resource metadata and no error (RFC 6750 3.1), and so is /mcp/admin", async () => {
    const admin = await call(
      new Request(`${ORIGIN}${ADMIN_MCP_ROUTE}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    expect(admin.status).toBe(401);
    const response = await call(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate") ?? "").toMatch(/resource_metadata=/);
    expect(response.headers.get("WWW-Authenticate") ?? "").toMatch(/scope="capsid\.read"/);
    expect(response.headers.get("WWW-Authenticate") ?? "").not.toMatch(/error=/);
    // The challenge asks for the least scope; the metadata lists every scope.
    const metadata = (await (
      await call(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`))
    ).json()) as { scopes_supported?: string[] };
    expect(metadata.scopes_supported).toEqual(["capsid.read", "capsid.write"]);
  });
});
