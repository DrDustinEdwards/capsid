import type { Env } from "./env";
import { readSiteRow, sitesFrom } from "./ops-sites";

// What the search reports (src/search-console.ts, src/bing-webmaster.ts) share: the
// namespace's configured site, and a page to inspect that must be on it.

/** The namespace's site from ops_sites, or a refusal naming what it lacks. */
export async function reportSite(env: Env, namespace: string, what: string) {
  const row = await readSiteRow(env.DB, namespace);
  const site = row ? sitesFrom([row])[0] : undefined;
  if (!row || !site) {
    throw new Error(`${namespace} has no site configured (ops_sites), so it has no ${what}. The admin adds one with capsid_admin_run_controls control site_add.`);
  }
  return site;
}

/** The page to inspect, refused unless it is an https page on the site's own host. */
export function pageOnSite(origin: string, namespace: string, url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("url must be a whole address, such as https://example.com/about.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== new URL(origin).hostname) {
    throw new Error(`url must be a page on ${namespace}'s site, ${origin}.`);
  }
  return parsed.toString();
}
