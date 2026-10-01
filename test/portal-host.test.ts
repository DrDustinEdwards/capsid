import assert from "node:assert/strict";
import { test } from "node:test";
import { PORTAL_HOST, portalBase, portalCookiePath, portalHostRequest, publicPortalPath } from "../src/portal-host.ts";

// portal.dustinedwards.info serves the Portal and nothing else (src/portal-host.ts). The
// Worker asks portalHostRequest first, in src/index.ts before the OAuth provider
// (test-integration/portal-host.test.ts runs it through the whole Worker): on the Portal host /x is handled as /portal/x, an
// old /portal address redirects to the root, and the hashed files keep their path.

const PORTAL = `https://${PORTAL_HOST}`;
const WORKERS = "https://capsid.dustin-edwards.workers.dev";

function routed(url: string, init?: RequestInit): string | { redirect: string; status: number } {
  const r = portalHostRequest(new Request(url, init));
  if ("redirect" in r) return { redirect: String(r.redirect.headers.get("Location")), status: r.redirect.status };
  return new URL(r.request.url).pathname + new URL(r.request.url).search;
}

test("workers.dev requests pass through untouched, the Portal's and everything else's", () => {
  for (const path of ["/portal/", "/portal/queue", "/portal/api/ops", "/mcp", "/health", "/callback"]) {
    assert.equal(routed(`${WORKERS}${path}`), path);
  }
});

test("PLANT: on the Portal host, a root path is handled as the Portal's", () => {
  assert.equal(routed(`${PORTAL}/`), "/portal/");
  assert.equal(routed(`${PORTAL}/queue/job/job_0123456789ab`), "/portal/queue/job/job_0123456789ab");
  assert.equal(routed(`${PORTAL}/api/ops`), "/portal/api/ops");
  assert.equal(routed(`${PORTAL}/callback?code=c&state=s`), "/portal/callback?code=c&state=s");
  // Nothing but the Portal: the MCP endpoint and /health become Portal paths behind the
  // gate, not the Worker's own routes.
  assert.equal(routed(`${PORTAL}/mcp`), "/portal/mcp");
  assert.equal(routed(`${PORTAL}/health`), "/portal/health");
});

test("PLANT: on the Portal host, an old /portal address redirects to the same path at the root, keeping the method", () => {
  assert.deepEqual(routed(`${PORTAL}/portal/queue?ns=sample`), { redirect: `${PORTAL}/queue?ns=sample`, status: 308 });
  assert.deepEqual(routed(`${PORTAL}/portal`), { redirect: `${PORTAL}/`, status: 308 });
  assert.deepEqual(routed(`${PORTAL}/portal/api/ops/refresh`, { method: "POST" }), { redirect: `${PORTAL}/api/ops/refresh`, status: 308 });
  // /portalx is not under /portal: it is a root path like any other.
  assert.equal(routed(`${PORTAL}/portalx`), "/portal/portalx");
});

test("on the Portal host, the hashed files keep their /portal/assets/ path", () => {
  assert.equal(routed(`${PORTAL}/portal/assets/index-abc123.js`), "/portal/assets/index-abc123.js");
});

test("the base, the cookie path and the public path follow the host", () => {
  const p = new URL(`${PORTAL}/portal/`);
  const w = new URL(`${WORKERS}/portal/`);
  assert.equal(portalBase(p), "");
  assert.equal(portalBase(w), "/portal");
  assert.equal(portalCookiePath(p), "/");
  assert.equal(portalCookiePath(w), "/portal");
  assert.equal(publicPortalPath(p, "/portal/jobs"), "/jobs");
  assert.equal(publicPortalPath(p, "/portal"), "/");
  assert.equal(publicPortalPath(p, "/portal/callback"), "/callback");
  assert.equal(publicPortalPath(w, "/portal/jobs"), "/portal/jobs");
});
