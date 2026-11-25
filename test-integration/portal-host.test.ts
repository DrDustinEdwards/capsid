import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PORTAL_HOST } from "../src/portal-host";

// Through the whole Worker, not the routes handler alone: the host rewrite once sat behind the OAuth provider, so /mcp on
// the Portal host reached the MCP endpoint (401) and rolled a deploy back, which the routes-handler node tests could not see.

const PORTAL = `https://${PORTAL_HOST}`;

async function anonymous(path: string, method = "GET") {
  return SELF.fetch(`${PORTAL}${path}`, { method, redirect: "manual" });
}

describe("the Portal host through the whole Worker", () => {
  it("PLANT: / and none of the OAuth provider's own routes answer on the Portal host: an anonymous caller gets the Access sign-in (live gate 7)", async () => {
    for (const [path, method] of [
      ["/", "GET"],
      ["/mcp", "GET"],
      ["/mcp", "POST"],
      ["/token", "POST"],
      ["/authorize", "GET"],
      ["/register", "POST"],
      ["/.well-known/oauth-authorization-server", "GET"],
      ["/.well-known/oauth-protected-resource", "GET"],
    ] as const) {
      const response = await anonymous(path, method);
      // Never the provider's 401, its JSON metadata, or its token endpoint.
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
    for (const [path, accept] of [
      ["/demos/", "text/html"],
      ["/demos/health", "text/html"],
      ["/demos/api/ops.json", "*/*"],
    ] as const) {
      const response = await SELF.fetch(`${PORTAL}${path}`, {
        headers: { Accept: accept },
        redirect: "manual",
      });
      expect(response.status, `${path} answered ${response.status}`).toBe(200);
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
    }
    const page = await (await SELF.fetch(`${PORTAL}/demos/health`)).text();
    expect(page, "the demo page read the captured feed").toContain('data-read="200"');
    expect((await anonymous("/demos/", "POST")).status).toBe(405);
    for (const path of ["/", "/site.webmanifest", "/api/ops"]) {
      const response = await anonymous(path);
      expect(response.status, `${path} answered ${response.status}`).toBe(302);
    }
  });

  it("another host is untouched: /mcp there is still the MCP endpoint", async () => {
    const response = await SELF.fetch("https://capsid.test/mcp", {
      method: "POST",
      redirect: "manual",
    });
    expect(response.status).toBe(401);
  });
});
