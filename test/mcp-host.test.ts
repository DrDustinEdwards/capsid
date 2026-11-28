import assert from "node:assert/strict";
import { test } from "node:test";
import { hostRefusal, MCP_HOST, servedOnMcpHost } from "../src/mcp-host.ts";
import { ROUTE_GRANTS, UNGATED_ROUTES } from "../src/scope-routes.ts";

const at = (host: string, path: string) => hostRefusal(new Request(`https://${host}${path}`));

test("PLANT: the MCP host serves every declared route outside the Portal, and 404s the rest", () => {
  // The MCP and OAuth provider routes are not in the route tables.
  const provider = [
    "/mcp",
    "/mcp/sse",
    "/mcp/admin",
    "/token",
    "/ops/hooks",
    "/ops/otlp/v1/metrics",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource/mcp",
  ];
  for (const path of [...provider, ...Object.keys(UNGATED_ROUTES), ...Object.keys(ROUTE_GRANTS)]) {
    if (path === "/portal" || path.startsWith("/portal/")) continue;
    assert.equal(servedOnMcpHost(path), true, path);
    assert.equal(at(MCP_HOST, path), null, path);
  }
  for (const path of [
    "/",
    "/portal",
    "/portal/",
    "/portal/api/ops",
    "/console",
    "/mcpx",
    "/opsx",
    "/.well-known/security.txt",
    "/oauth/clients/other.json",
  ]) {
    assert.equal(servedOnMcpHost(path), false, path);
    assert.equal(at(MCP_HOST, path)?.status, 404, path);
  }
});

test("any other host is untouched (the Portal host, the test hosts)", () => {
  for (const host of ["portal.dustinedwards.info", "capsid.test"]) {
    for (const path of ["/", "/portal/", "/mcp"])
      assert.equal(at(host, path), null, `${host}${path}`);
  }
});
