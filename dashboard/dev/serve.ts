// The browser tests' server (playwright.config.ts): the production build, served as the capsid
// Worker serves it (src/portal-app.ts, src/portal-demo.ts there), with the dev mock in place of
// the Worker's API routes and no sign-in. Pages render through build/worker/portal.js, the module
// the Worker bundles; the build's files are served from build/client; every page carries the
// Worker's own CSP with a fresh nonce, so a script or style the Worker's page would refuse fails
// the tests too. Build first (npm run build).
//
//   node --import ../test/resolve-ts.mjs dev/serve.ts [port]
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dashboardCsp } from "../../src/dashboard-csp.ts";
import { mockHandler } from "./mock-api.ts";
// @ts-expect-error: the bundle exists only after `npm run build`.
import { renderDemoPage, renderPortalPage } from "../build/worker/portal.js";

const PORT = Number(process.argv[2] ?? 4174);
const CLIENT = fileURLToPath(new URL("../build/client/", import.meta.url));
const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
const mock = mockHandler();

async function file(path: string): Promise<Response> {
  const at = normalize(join(CLIENT, path));
  if (!at.startsWith(CLIENT)) return new Response("not found", { status: 404 });
  try {
    return new Response(await readFile(at), { headers: { "Content-Type": TYPES[extname(at)] ?? "application/octet-stream" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function page(req: IncomingMessage, url: URL): Promise<Response> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const request = new Request(url, { headers });
  const csp = dashboardCsp();
  // The page's cookies go with its reads, as the Worker's do (the mock's wf-mock switch).
  const cookie = req.headers.cookie;
  const read = (path: string) => fetch(`http://localhost:${PORT}/portal/api${path}`, { headers: cookie ? { accept: "application/json", cookie } : { accept: "application/json" } });
  const demo = url.pathname === "/demos" || url.pathname.startsWith("/demos/");
  const response: Response = demo ? await renderDemoPage(request, file, csp.nonce) : await renderPortalPage(request, read, csp.nonce);
  const out = new Headers(response.headers);
  out.set("Content-Security-Policy", csp.policy);
  out.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers: out });
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  mock(req, res, () => {
    const served = /\.[a-z0-9]+$/i.test(url.pathname) && !url.pathname.endsWith(".data") ? file(url.pathname) : page(req, url);
    served.then((r) => send(res, r)).catch((e: unknown) => {
      res.statusCode = 500;
      res.end(String(e instanceof Error ? e.stack : e));
    });
  });
}).listen(PORT, () => console.log(`serve: http://localhost:${PORT}/`));
