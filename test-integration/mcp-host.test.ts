import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MCP_HOST } from "../src/mcp-host";

// The MCP endpoint on mcp.dustinedwards.info (src/mcp-host.ts; job_2f9671f89e89), through
// the WHOLE Worker: the host rules run first in src/index.ts, before the OAuth provider,
// which answers its own routes.

const MCP = `https://${MCP_HOST}`;
const isFallback = async (r: Response) => r.status === 404 && (await r.clone().text()) === "not found";

describe("the MCP host", () => {
  it("PLANT: serves the machine surface: /mcp challenges, /health answers, the OAuth metadata names this host", async () => {
    const mcp = await SELF.fetch(`${MCP}/mcp`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${MCP}/.well-known/oauth-protected-resource/mcp"`);
    expect((await SELF.fetch(`${MCP}/health`)).status).not.toBe(404);
    const ops = await SELF.fetch(`${MCP}/ops/mcp`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(ops.status).toBe(401);
    const as = await SELF.fetch(`${MCP}/.well-known/oauth-authorization-server`);
    expect(as.status).toBe(200);
  });

  it("PLANT: answers nothing else: the Portal, its API and any page are the plain 404", async () => {
    for (const path of ["/", "/portal", "/portal/", "/portal/api/ops", "/portal/callback", "/console", "/nope"]) {
      const response = await SELF.fetch(`${MCP}${path}`, { redirect: "manual" });
      expect(await isFallback(response), `${path} answered ${response.status} on the MCP host`).toBe(true);
    }
  });
});
