import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PORTAL_HOST } from "../src/portal-host";

// The Portal's own host through the WHOLE Worker (src/index.ts), not the routes handler
// alone. #218 put the host rewrite in defaultHandler, behind the OAuth provider, which
// answers its own routes first: /mcp on portal.dustinedwards.info reached the MCP
// endpoint (401) and live gate 7 rolled the deploy back (run 36863432268). The node
// tests in test/portal-host.test.ts called the routes handler directly and could not
// see it.

const PORTAL = `https://${PORTAL_HOST}`;

async function anonymous(path: string, method = "GET") {
  return SELF.fetch(`${PORTAL}${path}`, { method, redirect: "manual" });
}

describe("the Portal host through the whole Worker", () => {
  it("PLANT: / and /mcp send an anonymous caller to the Access sign-in, as live gate 7 asserts", async () => {
    for (const path of ["/", "/mcp"]) {
      const response = await anonymous(path);
      expect(response.status, `${path} answered ${response.status}`).toBe(302);
      expect(response.headers.get("Location") ?? "", `${path} redirected elsewhere`).toContain("sample.cloudflareaccess.com");
    }
  });

  it("PLANT: none of the OAuth provider's own routes answers on the Portal host", async () => {
    for (const [path, method] of [
      ["/mcp", "POST"],
      ["/token", "POST"],
      ["/authorize", "GET"],
      ["/register", "POST"],
      ["/.well-known/oauth-authorization-server", "GET"],
      ["/.well-known/oauth-protected-resource", "GET"],
    ] as const) {
      const response = await anonymous(path, method);
      // A Portal path behind the gate: the sign-in redirect, never the provider's
      // 401, its JSON metadata, or its token endpoint.
      expect(response.status, `${method} ${path} answered ${response.status}`).toBe(302);
      expect(response.headers.get("Location") ?? "").toContain("sample.cloudflareaccess.com");
    }
  });

  it("an old /portal address on the Portal host redirects once, to the root path", async () => {
    const response = await anonymous("/portal/queue");
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe(`${PORTAL}/queue`);
  });

  it("workers.dev is untouched: /mcp there is still the MCP endpoint", async () => {
    const response = await SELF.fetch("https://capsid.test/mcp", { method: "POST", redirect: "manual" });
    expect(response.status).toBe(401);
  });
});
