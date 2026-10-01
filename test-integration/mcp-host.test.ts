import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LEGACY_HOST, MCP_HOST } from "../src/mcp-host";

// The MCP endpoint on mcp.dustinedwards.info, and the retired workers.dev /portal
// (src/mcp-host.ts; job_2f9671f89e89), through the WHOLE Worker: the host rules run
// first in src/index.ts, before the OAuth provider, which answers its own routes.

const MCP = `https://${MCP_HOST}`;
const LEGACY = `https://${LEGACY_HOST}`;
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

  it("a token for one host's resource is not the other's: each host advertises only its own", async () => {
    const mcp = (await (await SELF.fetch(`${MCP}/.well-known/oauth-protected-resource/mcp`)).json()) as { resource: string };
    const legacy = (await (await SELF.fetch(`${LEGACY}/.well-known/oauth-protected-resource/mcp`)).json()) as { resource: string };
    expect(mcp.resource).toBe(`${MCP}/mcp`);
    expect(legacy.resource).toBe(`${LEGACY}/mcp`);
  });
});

describe("the old address", () => {
  it("PLANT: its /portal is retired: every path under it is the plain 404, never the sign-in", async () => {
    for (const path of ["/portal", "/portal/", "/portal/queue", "/portal/callback", "/portal/api/ops", "/portal/assets/index.js"]) {
      const response = await SELF.fetch(`${LEGACY}${path}`, { redirect: "manual" });
      expect(await isFallback(response), `${path} answered ${response.status} on ${LEGACY_HOST}`).toBe(true);
    }
  });

  it("its MCP endpoint still answers for the hours of the cut", async () => {
    const mcp = await SELF.fetch(`${LEGACY}/mcp`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${LEGACY}/.well-known/oauth-protected-resource/mcp"`);
  });
});
