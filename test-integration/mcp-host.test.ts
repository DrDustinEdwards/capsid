import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MCP_HOST } from "../src/mcp-host";

// The MCP host through the whole Worker: the host rules run before the OAuth provider.

const MCP = `https://${MCP_HOST}`;
const isFallback = async (r: Response) =>
  r.status === 404 && (await r.clone().text()) === "not found";

describe("the MCP host", () => {
  // The /mcp challenge and the OAuth metadata on this host are in oauth.test.ts.
  it("serves the operator endpoint and /health", async () => {
    const ops = await SELF.fetch(`${MCP}/ops/mcp`, {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });
    expect(ops.status).toBe(401);
    expect((await SELF.fetch(`${MCP}/health`)).status).not.toBe(404);
  });

  it("PLANT: answers nothing else: the Portal, its API and any page are the plain 404", async () => {
    for (const path of [
      "/",
      "/portal",
      "/portal/",
      "/portal/api/ops",
      "/portal/callback",
      "/console",
      "/nope",
    ]) {
      const response = await SELF.fetch(`${MCP}${path}`, { redirect: "manual" });
      expect(
        await isFallback(response),
        `${path} answered ${response.status} on the MCP host`,
      ).toBe(true);
    }
  });
});
