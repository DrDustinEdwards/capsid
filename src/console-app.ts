import { consoleGate } from "./console";
import type { Env } from "./env";

// The Watch Floor app's built files, served under /console/app/ (capsid/research/
// design-ops-console.md). Every request goes through consoleGate first, the same gate
// as /console, and only then reaches env.ASSETS: the files are the admin's dashboard,
// and a file served before the gate is a file served to anyone.
//
// That ordering holds only while the Worker runs before the assets router. The deployed
// config must set `assets.run_worker_first: true` (docs/console.md): without it,
// Cloudflare serves a request that matches a file (the assets directory's own
// /index.html and /assets/*, at the root of the origin) without invoking this Worker.
// test-integration/console-app.test.ts runs with the same setting and asserts the root
// paths reach the Worker.

export const CONSOLE_APP_PATH = "/console/app";
export const CONSOLE_APP_PREFIX = "/console/app/";

// The app's page only. Scripts and styles from this origin and nothing inline, so an
// injected tag in anything the feed carries cannot run. CONSOLE_CSP (the server-rendered
// page) and the consent dialog's CSP are separate and unchanged.
export const DASHBOARD_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

// Hashed build output, named by content, so a changed file has a new name. Private:
// the files sit behind a login, so no shared cache keeps a copy.
export const HASHED_ASSET_CACHE = "private, max-age=31536000, immutable";
const HASHED_ASSET_PREFIX = "/assets/";

const NOT_DEPLOYED =
  "the dashboard is not deployed: this Worker has no ASSETS binding. The built app (dashboard/dist) is served only when the deploy config declares it; the server-rendered console at /console is unaffected.";

function text(message: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "no-store", ...extra } });
}

/** A navigation, as opposed to a script or fetch asking for a file: the only kind that
 *  falls back to the app's page, so a client route such as /console/app/jobs loads the
 *  app while a missing script is still a 404. */
export function isNavigation(request: Request): boolean {
  if (request.headers.get("Sec-Fetch-Mode") === "navigate") return true;
  return (request.headers.get("Accept") ?? "").includes("text/html");
}

/** The path inside the assets directory. The page is asked for as "/", because the
 *  assets router answers /index.html with a redirect to / under its default html
 *  handling. */
export function assetPath(pathname: string): string {
  const inner = pathname.slice(CONSOLE_APP_PATH.length) || "/";
  return inner === "/index.html" ? "/" : inner;
}

function fetchAsset(assets: Fetcher, path: string, method: string): Promise<Response> {
  // The hostname is not meaningful to the binding; only the pathname is matched.
  return assets.fetch(new Request(new URL(path, "https://assets.invalid"), { method }));
}

export async function handleConsoleApp(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const url = new URL(request.url);
  const gate = await consoleGate(request, env, now, url.pathname);
  if (!gate.ok) return gate.response;
  if (!env.ASSETS) return text(NOT_DEPLOYED, 503);
  if (request.method !== "GET" && request.method !== "HEAD") return text("method not allowed: the dashboard's files are read with GET.", 405, { Allow: "GET, HEAD" });

  let path = assetPath(url.pathname);
  let response = await fetchAsset(env.ASSETS, path, request.method);
  if (response.status === 404 && isNavigation(request)) {
    // Behind the gate, like every other answer here: the fallback is the app's page.
    await response.body?.cancel();
    path = "/";
    response = await fetchAsset(env.ASSETS, path, request.method);
  }

  const headers = new Headers(response.headers);
  // A redirect from the assets router names a path inside the assets directory; the
  // browser needs it under /console/app.
  const location = headers.get("Location");
  if (location?.startsWith("/")) headers.set("Location", CONSOLE_APP_PATH + location);

  if (response.ok && path === "/") {
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Security-Policy", DASHBOARD_CSP);
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Frame-Options", "DENY");
  } else if (response.ok && path.startsWith(HASHED_ASSET_PREFIX)) {
    headers.set("Cache-Control", HASHED_ASSET_CACHE);
  } else {
    headers.set("Cache-Control", "no-store");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
