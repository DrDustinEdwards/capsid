// Bundled with React and React Router into build/worker/portal.js (npm run build:worker), so the Worker carries one copy of each.
import { RouterContextProvider, createRequestHandler, type ServerBuild } from "react-router";
// @ts-expect-error: the server build exists only after `react-router build`.
import * as build from "../build/server/index.js";
import { demoFile, movedToNow } from "./lib/demo";
import { portalServer, type PortalRead } from "./server/prefetch";

const handler = createRequestHandler(build as unknown as ServerBuild, "production");

export function renderPortalPage(
  request: Request,
  read: PortalRead,
  nonce: string,
): Promise<Response> {
  const context = new RouterContextProvider();
  context.set(portalServer, { read, nonce });
  return handler(request, context);
}

export function demoRead(file: (path: string) => Promise<Response>): PortalRead {
  return async (path) => movedToNow(await file(demoFile(path)));
}

export function renderDemoPage(
  request: Request,
  file: (path: string) => Promise<Response>,
  nonce: string,
): Promise<Response> {
  return renderPortalPage(request, demoRead(file), nonce);
}
