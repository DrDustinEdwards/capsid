import assert from "node:assert/strict";
import { test } from "node:test";
import { hostRefusal, LEGACY_HOST, MCP_HOST, servedOnMcpHost } from "../src/mcp-host.ts";

// The host rules (src/mcp-host.ts) without the Worker: what the MCP host serves, and the
// old address's retired /portal. test-integration/mcp-host.test.ts runs them through the
// whole Worker.

const at = (host: string, path: string) => hostRefusal(new Request(`https://${host}${path}`));

test("PLANT: the MCP host serves every machine route and nothing else", () => {
  for (const path of ["/mcp", "/mcp/sse", "/authorize", "/token", "/callback", "/health", "/csp-report", "/ops/mcp", "/ops/hooks", "/ops/otlp/v1/metrics", "/ops/runner-key", "/ops/backup", "/improve/score", "/improve/holdout-credential", "/backup/credential", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
    assert.equal(servedOnMcpHost(path), true, path);
    assert.equal(at(MCP_HOST, path), null, path);
  }
  for (const path of ["/", "/portal", "/portal/", "/portal/api/ops", "/console", "/mcpx", "/opsx", "/.well-known/security.txt"]) {
    assert.equal(servedOnMcpHost(path), false, path);
    assert.equal(at(MCP_HOST, path)?.status, 404, path);
  }
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
