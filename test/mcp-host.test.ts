import assert from "node:assert/strict";
import { test } from "node:test";
import { hostRefusal, LEGACY_HOST, MCP_HOST, servedOnMcpHost } from "../src/mcp-host.ts";
import { VERIFY_LIVE_CLIENT_PATH } from "../src/oauth-client-docs.ts";
import { ROUTE_GRANTS, UNGATED_ROUTES } from "../src/scope.ts";

// The host rules (src/mcp-host.ts) without the Worker: what the MCP host serves, and the
// old address's retired /portal. test-integration/mcp-host.test.ts runs them through the
// whole Worker.

const at = (host: string, path: string) => hostRefusal(new Request(`https://${host}${path}`));

test("PLANT: the MCP host serves every machine route and nothing else", () => {
  for (const path of ["/mcp", "/mcp/sse", "/mcp/admin", "/ops/mcp/admin", "/authorize", "/token", "/callback", "/health", "/csp-report", "/ops/mcp", "/ops/hooks", "/ops/otlp/v1/metrics", "/ops/backup", "/backup/credential", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp", "/oauth/clients/verify-live.json"]) {
    assert.equal(servedOnMcpHost(path), true, path);
    assert.equal(at(MCP_HOST, path), null, path);
  }
  for (const path of ["/", "/portal", "/portal/", "/portal/api/ops", "/console", "/mcpx", "/opsx", "/.well-known/security.txt", "/oauth/clients/other.json"]) {
    assert.equal(servedOnMcpHost(path), false, path);
    assert.equal(at(MCP_HOST, path)?.status, 404, path);
  }
});

// The path list is kept by hand, and a route left off it is a 404 in production while every
// test that calls the handler passes: /bench/repro and /shadow/* shipped that way on
// 2026-10-23. Every declared route outside the Portal must be on it.
test("PLANT: the MCP host serves every declared route outside the Portal", () => {
  for (const path of [...Object.keys(UNGATED_ROUTES), ...Object.keys(ROUTE_GRANTS)]) {
    if (path === "/portal" || path.startsWith("/portal/")) continue;
    assert.equal(servedOnMcpHost(path), true, path);
  }
});

// Live gate 2 fetches the probe document from the host under test (test/cimd-probe.test.ts
// ties gate 2's path to the Worker's). On 2026-10-10 the Worker served it and the gate
// asked for it, but the MCP host's path list did not include it, so the host answered 404
// and the gate rolled back the deploy of 4730307.
test("PLANT: the MCP host serves the probe document at the Worker's path", () => {
  assert.equal(servedOnMcpHost(VERIFY_LIVE_CLIENT_PATH), true);
  assert.equal(at(MCP_HOST, VERIFY_LIVE_CLIENT_PATH), null);
});

test("PLANT: the old address's /portal is the plain 404, and its machine routes still go on", () => {
  for (const path of ["/portal", "/portal/", "/portal/queue", "/portal/callback"]) assert.equal(at(LEGACY_HOST, path)?.status, 404, path);
  for (const path of ["/mcp", "/ops/mcp", "/health", "/portalx"]) assert.equal(at(LEGACY_HOST, path), null, path);
});

test("any other host is untouched (the Portal host, the test hosts)", () => {
  for (const host of ["portal.dustinedwards.info", "capsid.test"]) {
    for (const path of ["/", "/portal/", "/mcp"]) assert.equal(at(host, path), null, `${host}${path}`);
  }
});
