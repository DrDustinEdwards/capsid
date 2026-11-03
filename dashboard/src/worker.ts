// The one module the capsid Worker imports to render a Portal page (src/portal-app.ts and
// src/portal-demo.ts there): React Router's request handler over this app's server build, with the
// page's reads and the response's CSP nonce in the router's context. npm run build:worker bundles
// it, React and React Router included, into build/worker/portal.js, so the Worker carries one copy
// of each and its own bundle needs none of them.
import { RouterContextProvider, createRequestHandler, type ServerBuild } from "react-router";
// @ts-expect-error: the server build exists only after `react-router build`.
import * as build from "../build/server/index.js";
import { DEMO_BASE, DEMO_CAPTURED, demoFileName, shiftTimes } from "./lib/demo";
import { portalServer, type PortalRead } from "./server/prefetch";

const handler = createRequestHandler(build as unknown as ServerBuild, "production");

/** A Portal page: `request` names it as the browser does (/health), `read` answers the Portal's
 *  API routes ("/ops"), and `nonce` goes on every script the page renders. */
export function renderPortalPage(request: Request, read: PortalRead, nonce: string): Promise<Response> {
  const context = new RouterContextProvider();
  context.set(portalServer, { read, nonce });
  return handler(request, context);
}

/** The demo's reads, answered from the captured files as the browser's are (lib/demo.ts): "/ops"
 *  reads /demos/api/ops.json (the query is not kept), a package's history its own file, every
 *  time moved to now. */
export function demoRead(file: (path: string) => Promise<Response>): PortalRead {
  return async (path) => {
    const url = new URL(path, "https://demo.invalid");
    const pkg = url.pathname === "/packages/history" ? url.searchParams.get("name") : null;
    const res = await file(`${DEMO_BASE}/api${url.pathname}${pkg ? `/${demoFileName(pkg)}` : ""}.json`);
    if (!res.ok) return res;
    const moved = shiftTimes(await res.json(), Date.now() - Date.parse(DEMO_CAPTURED), true);
    return new Response(JSON.stringify(moved), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

/** A demo page (/demos/...): `file` answers a path in the build's files. */
export function renderDemoPage(request: Request, file: (path: string) => Promise<Response>, nonce: string): Promise<Response> {
  return renderPortalPage(request, demoRead(file), nonce);
}
