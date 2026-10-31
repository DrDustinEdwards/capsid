import { checkSecurityHeaders } from "@dustinedwards/site-runtime/check";
import { siteForOrigin } from "@dustinedwards/site-runtime/sites";
import type { Env } from "./env";
import { portalSessionCookie } from "./portal-auth";
import { HOUR_MS } from "./time";

// THE SIGNED-IN CRAWL (completeness area 2, gap 4 of the round 2 verifier). devkit's live check has no session, so it
// grades only what a stranger sees of Capsid Portal and Carrel Desk: the sign-in redirect. This crawl grades the pages
// behind it, with site-runtime's own checker and the registry entry each app declared, and publishes the result at
// SIGNED_IN_REPORT_PATH on the MCP host, where devkit's scoreboard reads it as the reported check "signed-in-security"
// (devkit live/areas.json; devkit #76's pattern: a check that needs a credential runs where the credential lives, and
// GitHub never holds it).
//
// - The Portal is this Worker. Its sign-in is Capsid's own cookie, minted after Access for SaaS, so no Access service
//   token can pass it. The crawl asks this Worker's own fetch handler in-process, with a Portal session minted for
//   ADMIN_EMAIL that lives for one request and never leaves the isolate: every header the edge would see, with no
//   credential anywhere but here. GET only, plus R4's two refused POSTs, which the action gate answers with 415 before
//   it reads a body, a CSRF pair or a session's rights.
// - Desk is Carrel's Worker behind an Access self-hosted app. The crawl fetches it over the network with an Access
//   service token (DESK_CRAWL_CLIENT_ID and DESK_CRAWL_CLIENT_SECRET, Worker secrets), GET only. Without them, Desk's
//   result is "error", never a pass.
//
// Items graded: every header checkSecurityHeaders grades, the policy on HTML pages (C9 and I3 as the registry declares
// them), R4 on the Portal's JSON actions, and as warnings each cross-origin subresource a page names (what COEP or
// default-src 'none' would have to allow). The report holds findings only, never a page body, a cookie or a token.

export const SIGNED_IN_REPORT_PATH = "/reports/signed-in-security.json";
const SIGNED_IN_REPORT_KEY = "reports:signed-in-security";
const CHECK = "signed-in-security";
// Hourly; devkit reads it once a day and refuses one older than 180 minutes.
const REFRESH_MS = HOUR_MS;
const TIMEOUT_MS = 15_000;
const MAX_FINDINGS = 60;

export const PORTAL_ORIGIN = "https://portal.dustinedwards.info";
const DESK_ORIGIN = "https://desk.dustinedwards.info";
// A path no app serves, for the signed-in 404.
const MISSING = "/signed-in-crawl-404";
// The Portal's page, a JSON read and the JSON actions R4 probes.
const PORTAL_PAGES = ["/", MISSING];
const PORTAL_JSON = ["/api/namespaces"];
const PORTAL_ACTIONS = ["/api/actions/preview", "/api/actions/perform"];
const DESK_PAGES = ["/", MISSING];

type Severity = "error" | "warning";
interface Finding { severity: Severity; check: string; detail: string }
interface SiteResult { status: "pass" | "fail" | "error"; findings: Finding[] }
interface SignedInReport { check: typeof CHECK; at: string; ref: string; sites: Record<string, SiteResult> }

export type Fetch = (request: Request) => Promise<Response>;

const NAV_HEADERS = { Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none", "Sec-Fetch-Dest": "document", "User-Agent": "capsid-signed-in-crawl" };

/** The findings site-runtime's checker gives one response, graded against the app's registry entry. */
function gradeResponse(origin: string, url: string, response: Response): Finding[] {
  const site = siteForOrigin(origin)?.id;
  const html = /^\s*text\/html/i.test(response.headers.get("Content-Type") ?? "");
  const results = checkSecurityHeaders(response.headers, { ...(site ? { site } : {}), csp: html });
  if (results.length === 0) throw new Error("checkSecurityHeaders returned no results, so a pass would mean nothing was checked");
  return results
    .filter((r) => !r.pass && !r.notice)
    .map((r) => ({ severity: r.warn ? "warning" : "error", check: r.id, detail: `${url} (${response.status}) ${r.name}: ${r.detail}` }));
}

/** Each script, stylesheet, image, frame or media the HTML names on another origin: what COEP or default-src 'none'
 *  would have to allow, as warnings. Same-origin and data: sources are the page's own. */
function crossOriginLoads(origin: string, url: string, html: string): Finding[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<(script|link|img|iframe|source|video|audio|embed)\b[^>]*?\s(?:src|href)\s*=\s*["']?([^"'\s>]+)/gi)) {
    const tag = (m[1] ?? "").toLowerCase();
    const raw = m[2] ?? "";
    if (tag === "link" && !/\brel\s*=\s*["']?(?:stylesheet|preload|modulepreload|icon)/i.test(m[0])) continue;
    let target: URL;
    try {
      target = new URL(raw, url);
    } catch {
      continue;
    }
    if (target.protocol === "data:" || target.origin === origin) continue;
    out.add(`${tag} ${target.origin}`);
  }
  return [...out].map((load) => ({ severity: "warning", check: "I3", detail: `${url} loads a ${load.replace(" ", " from ")}, which COEP and default-src 'none' must allow` }));
}

/** The first same-origin script the page names, for grading a signed-in asset. */
function firstScript(origin: string, url: string, html: string): string | null {
  for (const m of html.matchAll(/<script\b[^>]*\ssrc\s*=\s*["']?([^"'\s>]+)/gi)) {
    try {
      const target = new URL(m[1] ?? "", url);
      if (target.origin === origin) return target.pathname;
    } catch {
      // not a URL: skip it
    }
  }
  return null;
}

/** A signed-in crawl of one app: its pages, the first script a page names, and its R4 probes. `signedIn` says whether
 *  a response reached the app's own pages (not a sign-in redirect or a refusal). */
export async function crawlApp(opts: {
  origin: string;
  fetch: Fetch;
  headers: Record<string, string>;
  pages: string[];
  json?: string[];
  actions?: string[];
  r4Note?: string;
}): Promise<SiteResult> {
  const findings: Finding[] = [];
  const get = async (path: string, extra: Record<string, string> = {}, init: RequestInit = {}) => {
    const url = new URL(path, opts.origin).href;
    const response = await opts.fetch(new Request(url, { redirect: "manual", ...init, headers: { ...opts.headers, ...extra } }));
    return { url, response };
  };
  let script: string | null = null;
  for (const path of opts.pages) {
    const { url, response } = await get(path, NAV_HEADERS);
    if (path === "/" && (response.status >= 300 || response.status === 401 || response.status === 403)) {
      await response.body?.cancel();
      const where = response.headers.get("Location") ? `, to ${new URL(response.headers.get("Location") ?? "", url).host}` : "";
      return { status: "error", findings: [{ severity: "error", check: "session", detail: `${url} answered ${response.status}${where}: the crawl did not reach the signed-in pages` }] };
    }
    findings.push(...gradeResponse(opts.origin, url, response));
    const html = /text\/html/i.test(response.headers.get("Content-Type") ?? "") ? await response.text() : "";
    if (!html) await response.body?.cancel();
    findings.push(...crossOriginLoads(opts.origin, url, html));
    script ??= firstScript(opts.origin, url, html);
  }
  for (const path of [...(script ? [script] : []), ...(opts.json ?? [])]) {
    const { url, response } = await get(path, { Accept: "*/*", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "empty" });
    await response.body?.cancel();
    findings.push(...gradeResponse(opts.origin, url, response));
  }
  // R4: a JSON route refuses text/plain and form bodies with 415, so a cross-site form or a no-cors fetch never
  // reaches it as a simple request.
  for (const path of opts.actions ?? []) {
    for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
      const { url, response } = await get(path, { "Content-Type": type, "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "empty" }, { method: "POST", body: "r4=probe" });
      await response.body?.cancel();
      if (response.status !== 415) findings.push({ severity: "error", check: "R4", detail: `${url} answered ${response.status} to a ${type} body; a JSON route refuses it with 415 (requireJson)` });
    }
  }
  if (opts.r4Note) findings.push({ severity: "warning", check: "R4", detail: opts.r4Note });
  const errors = findings.some((f) => f.severity === "error");
  return { status: errors ? "fail" : "pass", findings: findings.slice(0, MAX_FINDINGS) };
}

async function guarded(run: () => Promise<SiteResult>): Promise<SiteResult> {
  try {
    return await run();
  } catch (error) {
    return { status: "error", findings: [{ severity: "error", check: "crawl", detail: `could not run: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) }] };
  }
}

/** The whole report. `self` is this Worker's own fetch handler, which serves the Portal. */
async function buildSignedInReport(env: Env, self: Fetch, now: Date, net: Fetch = (r) => fetch(r, { signal: AbortSignal.timeout(TIMEOUT_MS) })): Promise<SignedInReport> {
  const portal = await guarded(async () => {
    if (!env.ADMIN_EMAIL || !env.COOKIE_ENCRYPTION_KEY) throw new Error("ADMIN_EMAIL or COOKIE_ENCRYPTION_KEY is unset, so no Portal session can be minted");
    const cookie = (await portalSessionCookie({ email: env.ADMIN_EMAIL }, env.COOKIE_ENCRYPTION_KEY, now, "/")).split(";")[0] ?? "";
    return crawlApp({ origin: PORTAL_ORIGIN, fetch: self, headers: { Cookie: cookie }, pages: PORTAL_PAGES, json: PORTAL_JSON, actions: PORTAL_ACTIONS });
  });
  const desk = await guarded(async () => {
    if (!env.DESK_CRAWL_CLIENT_ID || !env.DESK_CRAWL_CLIENT_SECRET) throw new Error("no Access service token yet: DESK_CRAWL_CLIENT_ID and DESK_CRAWL_CLIENT_SECRET are unset");
    return crawlApp({
      origin: DESK_ORIGIN,
      fetch: net,
      headers: { "CF-Access-Client-Id": env.DESK_CRAWL_CLIENT_ID, "CF-Access-Client-Secret": env.DESK_CRAWL_CLIENT_SECRET },
      pages: DESK_PAGES,
      r4Note: "not probed on Desk: the crawl only reads there (GET), so a probe can never act as a person",
    });
  });
  return { check: CHECK, at: now.toISOString(), ref: `capsid ${(env.BUILD_SHA ?? "unknown").slice(0, 12)}`, sites: { [PORTAL_ORIGIN]: portal, [DESK_ORIGIN]: desk } };
}

/** On the tick: a fresh report once an hour, stored in KV. Null when the stored one is still fresh. */
export async function signedInCrawlTick(env: Env, now: Date, self: Fetch): Promise<{ note: string } | null> {
  const stored = await env.APP_KV.get(SIGNED_IN_REPORT_KEY);
  const at = stored ? Date.parse((JSON.parse(stored) as { at?: string }).at ?? "") : Number.NaN;
  if (Number.isFinite(at) && now.getTime() - at < REFRESH_MS) return null;
  const report = await buildSignedInReport(env, self, now);
  await env.APP_KV.put(SIGNED_IN_REPORT_KEY, JSON.stringify(report));
  const line = Object.entries(report.sites).map(([origin, r]) => `${new URL(origin).host} ${r.status} (${r.findings.filter((f) => f.severity === "error").length} errors)`).join(", ");
  return { note: line };
}

/** GET SIGNED_IN_REPORT_PATH: the stored report, as stored. Public: it holds findings only. */
export async function handleSignedInReport(env: Env): Promise<Response> {
  const body = await env.APP_KV.get(SIGNED_IN_REPORT_KEY);
  if (!body) return new Response("No report yet.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
