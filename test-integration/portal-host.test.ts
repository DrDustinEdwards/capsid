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

  it("PLANT: the chart demo answers at /demos/ with no sign-in, and only there", async () => {
    // Its page (an app route falls back to it), its files and its captured sample data, noindex.
    for (const [path, accept] of [["/demos/", "text/html"], ["/demos/health", "text/html"], ["/demos/api/ops.json", "*/*"]] as const) {
      const response = await SELF.fetch(`${PORTAL}${path}`, { headers: { Accept: accept }, redirect: "manual" });
      expect(response.status, `${path} answered ${response.status}`).toBe(200);
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
    }
    // Nothing is written there, and the Portal's own page and files stay behind the gate.
    expect((await anonymous("/demos/", "POST")).status).toBe(405);
    for (const path of ["/", "/assets/app-abc123.js", "/api/ops"]) {
      const response = await anonymous(path);
      expect(response.status, `${path} answered ${response.status}`).toBe(302);
    }
  });

  it("workers.dev is untouched: /mcp there is still the MCP endpoint", async () => {
    const response = await SELF.fetch("https://capsid.test/mcp", { method: "POST", redirect: "manual" });
    expect(response.status).toBe(401);
  });
});
