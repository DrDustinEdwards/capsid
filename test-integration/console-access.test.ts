import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// CLOUDFLARE ACCESS COVERS THE CONSOLE AND NOTHING ELSE, through the real router.
//
// The Access application is on /console only; the Worker refuses every console route
// without a valid Access token, and every other path must still answer as it did, or
// MCP clients, runners and the OAuth flow break. No request here carries an Access
// token.

const ORIGIN = "https://capsid.dustinedwards.info";
const REFUSAL = /only through Cloudflare Access/;

async function fetchAs(method: string, path: string, body?: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    redirect: "manual",
    headers: body ? { "Content-Type": "application/json" } : {},
    body,
  });
}

describe("paths outside the console", () => {
  const cases: Array<[string, string, string?]> = [
    ["POST", "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })],
    ["POST", "/ops/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })],
    ["GET", "/health"],
    ["GET", "/.well-known/oauth-authorization-server"],
    ["GET", "/.well-known/oauth-protected-resource"],
    ["GET", "/authorize"],
    ["GET", "/callback"],
    ["POST", "/token", "{}"],
    ["POST", "/register", "{}"],
    ["POST", "/ops/backup"],
  ];
  for (const [method, path, body] of cases) {
    it(`${method} ${path} answers without Access`, async () => {
      const response = await fetchAs(method, path, body);
      const text = await response.clone().text();
      expect(text, `${path} was refused by the console's Access check`).not.toMatch(REFUSAL);
      expect(response.status, `${path} answered 404, so this proves nothing about it`).not.toBe(404);
    });
  }
});

describe("the console", () => {
  for (const [method, path] of [
    ["GET", "/console"],
    ["POST", "/console"],
    ["GET", "/console.json"],
    ["GET", "/console/callback"],
  ] as const) {
    it(`${method} ${path} is refused without an Access token`, async () => {
      const response = await fetchAs(method, path);
      expect(response.status).toBe(403);
      expect(await response.text()).toMatch(REFUSAL);
    });
  }
});
