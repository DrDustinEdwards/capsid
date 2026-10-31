import { crawlApp, guardedCrawl, SIGNED_IN_MISSING_PATH, signedInReport, signedInReportResponse, signedInSummary } from "@dustinedwards/site-runtime/signed-in-crawl";
import type { Env } from "./env";
import { portalSessionCookie } from "./portal-auth";
import { HOUR_MS } from "./time";

// THE SIGNED-IN CRAWL (completeness area 2). devkit's live check has no session, so it grades only the Portal's
// sign-in redirect. This grades the pages behind it with site-runtime's shared crawl (./signed-in-crawl) against the
// `capsid-portal` registry entry, and publishes the result at SIGNED_IN_REPORT_PATH on the MCP host, where devkit's
// scoreboard reads it as the reported check "signed-in-security" (devkit live/areas.json). Carrel Desk grades itself
// the same way and publishes its own report on carrel-mcp (devkit's `site_reports`).
//
// The Portal is this Worker. Its sign-in is Capsid's own cookie, minted after Access for SaaS, so no Access service
// token can pass it. The crawl asks this Worker's own fetch handler in-process, with a Portal session minted for
// ADMIN_EMAIL that lives for one request and never leaves the isolate. GET only, plus R4's two refused POSTs, which the
// action gate answers with 415 before it reads a body, a CSRF pair or a session's rights.

export { SIGNED_IN_REPORT_PATH } from "@dustinedwards/site-runtime/signed-in-crawl";
const SIGNED_IN_REPORT_KEY = "reports:signed-in-security";
// Hourly; devkit reads it once a day and refuses one older than 180 minutes.
const REFRESH_MS = HOUR_MS;

export const PORTAL_ORIGIN = "https://portal.dustinedwards.info";

export type Fetch = (request: Request) => Promise<Response>;

/** The report. `self` is this Worker's own fetch handler, which serves the Portal. */
async function buildSignedInReport(env: Env, self: Fetch, now: Date) {
  const portal = await guardedCrawl(async () => {
    if (!env.ADMIN_EMAIL || !env.COOKIE_ENCRYPTION_KEY) throw new Error("ADMIN_EMAIL or COOKIE_ENCRYPTION_KEY is unset, so no Portal session can be minted");
    const cookie = (await portalSessionCookie({ email: env.ADMIN_EMAIL }, env.COOKIE_ENCRYPTION_KEY, now, "/")).split(";")[0] ?? "";
    return crawlApp({
      origin: PORTAL_ORIGIN,
      fetch: self,
      headers: { Cookie: cookie },
      pages: ["/", SIGNED_IN_MISSING_PATH],
      json: ["/api/namespaces"],
      actions: ["/api/actions/preview", "/api/actions/perform"],
    });
  });
  return signedInReport({ [PORTAL_ORIGIN]: portal }, { at: now, ref: `capsid ${(env.BUILD_SHA ?? "unknown").slice(0, 12)}` });
}

/** On the tick: a fresh report once an hour, stored in KV. Null when the stored one is still fresh. */
export async function signedInCrawlTick(env: Env, now: Date, self: Fetch): Promise<{ note: string } | null> {
  const stored = await env.APP_KV.get(SIGNED_IN_REPORT_KEY);
  const at = stored ? Date.parse((JSON.parse(stored) as { at?: string }).at ?? "") : Number.NaN;
  if (Number.isFinite(at) && now.getTime() - at < REFRESH_MS) return null;
  const report = await buildSignedInReport(env, self, now);
  await env.APP_KV.put(SIGNED_IN_REPORT_KEY, JSON.stringify(report));
  return { note: signedInSummary(report) };
}

/** GET SIGNED_IN_REPORT_PATH: the stored report, as stored. Public: it holds findings only. */
export async function handleSignedInReport(env: Env): Promise<Response> {
  return signedInReportResponse(await env.APP_KV.get(SIGNED_IN_REPORT_KEY));
}
