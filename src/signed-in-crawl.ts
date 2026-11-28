import {
  crawlApp,
  guardedCrawl,
  SIGNED_IN_MISSING_PATH,
  signedInReport,
  signedInReportResponse,
  signedInSummary,
} from "@dustinedwards/site-runtime/signed-in-crawl";
import type { Env } from "./env";
import { portalSessionCookie } from "./portal-auth";
import { HOUR_MS } from "./time";

// THE SIGNED-IN CRAWL (completeness area 2). devkit's live check has no session, so it grades only
// the Portal's sign-in redirect.

const SIGNED_IN_REPORT_KEY = "reports:signed-in-security";
// Hourly; devkit reads it once a day and refuses one older than 180 minutes.
const REFRESH_MS = HOUR_MS;

const PORTAL_ORIGIN = "https://portal.dustinedwards.info";

export type Fetch = (request: Request) => Promise<Response>;

/** The report. `self` is this Worker's own fetch handler, which serves the Portal. */
async function buildSignedInReport(env: Env, self: Fetch, now: Date) {
  const portal = await guardedCrawl(async () => {
    if (!env.ADMIN_EMAIL || !env.COOKIE_ENCRYPTION_KEY)
      throw new Error(
        "ADMIN_EMAIL or COOKIE_ENCRYPTION_KEY is unset, so no Portal session can be minted",
      );
    const cookie =
      (
        await portalSessionCookie({ email: env.ADMIN_EMAIL }, env.COOKIE_ENCRYPTION_KEY, now, "/")
      ).split(";")[0] ?? "";
    return crawlApp({
      origin: PORTAL_ORIGIN,
      fetch: self,
      headers: { Cookie: cookie },
      pages: ["/", SIGNED_IN_MISSING_PATH],
      json: ["/api/namespaces"],
      actions: ["/api/actions/preview", "/api/actions/perform"],
    });
  });
  return signedInReport(
    { [PORTAL_ORIGIN]: portal },
    { at: now, ref: `capsid ${(env.BUILD_SHA ?? "unknown").slice(0, 12)}` },
  );
}

/** On the tick: a fresh report once an hour, stored in KV. Null when the stored one is still fresh. */
export async function signedInCrawlTick(
  env: Env,
  now: Date,
  self: Fetch,
): Promise<{ note: string } | null> {
  const stored = (await env.APP_KV.get(SIGNED_IN_REPORT_KEY, "json").catch(() => null)) as {
    at?: string;
  } | null;
  const at = Date.parse(stored?.at ?? "");
  if (Number.isFinite(at) && now.getTime() - at < REFRESH_MS) return null;
  const report = await buildSignedInReport(env, self, now);
  await env.APP_KV.put(SIGNED_IN_REPORT_KEY, JSON.stringify(report));
  return { note: signedInSummary(report) };
}

/** GET SIGNED_IN_REPORT_PATH: the stored report, as stored. Public: it holds findings only. */
export async function handleSignedInReport(env: Env): Promise<Response> {
  return signedInReportResponse(await env.APP_KV.get(SIGNED_IN_REPORT_KEY));
}
