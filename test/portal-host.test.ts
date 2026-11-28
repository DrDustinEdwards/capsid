import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PORTAL_HOST,
  portalCookiePath,
  portalHostRequest,
  publicPortalPath,
} from "../src/portal-host.ts";

// On the Portal host /x is handled as /portal/x and an old /portal address redirects to the root;
// test-integration/portal-host.test.ts runs it through the whole Worker.

const PORTAL = `https://${PORTAL_HOST}`;
const OTHER = "https://capsid.test";

function routed(url: string, init?: RequestInit): string | { redirect: string; status: number } {
  const r = portalHostRequest(new Request(url, init));
  if ("redirect" in r)
    return { redirect: String(r.redirect.headers.get("Location")), status: r.redirect.status };
  return new URL(r.request.url).pathname + new URL(r.request.url).search;
}

test("PLANT: on the Portal host a root path is handled as the Portal's; on another host every path passes through", () => {
  for (const [url, path] of [
    [`${OTHER}/portal/`, "/portal/"],
    [`${OTHER}/portal/api/ops`, "/portal/api/ops"],
    [`${OTHER}/mcp`, "/mcp"],
    [`${OTHER}/callback`, "/callback"],
    [`${PORTAL}/`, "/portal/"],
    [`${PORTAL}/board`, "/portal/board"],
    [`${PORTAL}/api/ops`, "/portal/api/ops"],
    [`${PORTAL}/callback?code=c&state=s`, "/portal/callback?code=c&state=s"],
    // The MCP endpoint becomes a Portal path behind the gate; /health alone is the Worker's.
    [`${PORTAL}/mcp`, "/portal/mcp"],
    [`${PORTAL}/health`, "/health"],
  ])
    assert.equal(routed(url), path, url);
});

test("PLANT: on the Portal host, an old /portal address redirects to the same path at the root, keeping the method", () => {
  assert.deepEqual(routed(`${PORTAL}/portal/board?ns=sample`), {
    redirect: `${PORTAL}/board?ns=sample`,
    status: 308,
  });
  assert.deepEqual(routed(`${PORTAL}/portal`), { redirect: `${PORTAL}/`, status: 308 });
  assert.deepEqual(routed(`${PORTAL}/portal/api/ops/refresh`, { method: "POST" }), {
    redirect: `${PORTAL}/api/ops/refresh`,
    status: 308,
  });
  assert.equal(routed(`${PORTAL}/portalx`), "/portal/portalx");
});

test("PLANT: on the Portal host, a /portal path that would leave the origin is refused, not redirected", () => {
  for (const path of [
    "/portal//attacker.example",
    "/portal//attacker.example/x?code=c",
    "/portal///attacker.example",
  ]) {
    assert.deepEqual(routed(`${PORTAL}${path}`), { redirect: "null", status: 404 }, path);
  }
});

test("the cookie path and the public path follow the host", () => {
  const p = new URL(`${PORTAL}/portal/`);
  const w = new URL(`${OTHER}/portal/`);
  assert.equal(portalCookiePath(p), "/");
  assert.equal(portalCookiePath(w), "/portal");
  assert.equal(publicPortalPath(p, "/portal/board"), "/board");
  assert.equal(publicPortalPath(p, "/portal"), "/");
  assert.equal(publicPortalPath(p, "/portal/callback"), "/callback");
  assert.equal(publicPortalPath(w, "/portal/board"), "/portal/board");
});
