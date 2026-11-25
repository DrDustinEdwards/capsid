import { checkSecurityHeaders, failures } from "@dustinedwards/site-runtime/check";
import { siteForOrigin } from "@dustinedwards/site-runtime/sites";
import type { OpsSite } from "./ops-sites";
import type { WebAnalyticsSite } from "./ops-types/views";
import { MINUTE_MS } from "./time";

import type { LiveRule } from "./live-checks";

const BEACON_SCRIPT_HOST = "static.cloudflareinsights.com";

export const DEPLOY_GRACE_MINUTES = 45;

export function beaconCount(html: string): number {
  return [...html.matchAll(/<script\b[^>]*>/gi)].filter((tag) => BEACON_SRC.test(tag[0])).length;
}

const BEACON_SRC = new RegExp(
  `\\bsrc\\s*=\\s*["']?((?:https?:)?//${BEACON_SCRIPT_HOST.replace(/\./g, "\\.")}/[^"'\\s>]*)`,
  "i",
);

export interface LiveFinding {
  namespace: string;
  fingerprint: string;
  headline: string;
  evidence: string[];
}

export const slug = (path: string): string =>
  path
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "root";

export interface PageRead {
  status: number | null;
  headers: Headers | null;
  html: string | null;
  problem: string | null;
  // The page was not served to an anonymous visitor: a login redirect off the site, or a 401 or 403.
  // For a page that must carry no beacon that is the answer wanted, not a page that could not be
  // read.
  gated: boolean;
}

/**
 * The findings one beacon or nobeacon rule produces from one page read. A page that could not be
 * read yields none about the beacon (not read is not absent); the caller reports it as unread.
 */
export function pageFindings(
  site: Pick<OpsSite, "namespace" | "name" | "origin">,
  rule: Extract<LiveRule, { path: string }>,
  page: PageRead,
): LiveFinding[] {
  if (page.problem !== null || page.html === null || page.headers === null) return [];
  const url = `${site.origin}${rule.path}`;
  const where = slug(rule.path);
  const out: LiveFinding[] = [];
  if (rule.kind === "headers") {
    // The package's own check, graded against what the site declared in the registry (site-runtime
    // ./sites), so a declared deviation is not a finding and the watcher holds no second copy of
    // either.
    const results = checkSecurityHeaders(page.headers, { site: siteForOrigin(site.origin) });
    if (results.length === 0)
      throw new Error(
        "checkSecurityHeaders returned no results, so a pass would mean nothing was checked",
      );
    const failed = failures(results);
    if (failed.length > 0) {
      out.push({
        namespace: site.namespace,
        fingerprint: `live-headers-${site.namespace}-${where}`,
        headline: `${site.name} is missing security headers on a page that must carry them`,
        evidence: [
          `page: ${url}`,
          `${failed.length} of ${results.length} header checks failed`,
          ...failed.slice(0, 12).map((r) => `${r.name}: ${r.detail}`),
        ],
      });
    }
    return out;
  }
  if (rule.kind === "nobeacon") {
    const count = beaconCount(page.html);
    if (count > 0) {
      out.push({
        namespace: site.namespace,
        fingerprint: `live-beacon-present-${site.namespace}-${where}`,
        headline: `${site.name} carries the Web Analytics beacon on a page that must not`,
        evidence: [
          `page: ${url}`,
          `beacon scripts in the delivered HTML: ${count}`,
          "Conventions 7.9 keeps private and signed-in pages out of analytics. Cache-Control: no-transform stops Cloudflare injecting it.",
        ],
      });
    }
    return out;
  }
  // A beacon rule: site-runtime's C15, the beacon's script path prefix and its report to the site
  // itself, graded as if the site declared cloudflareWebAnalytics, so the watcher holds no second
  // CSP parser.
  const blocked = failures(
    checkSecurityHeaders(page.headers, {
      site: siteForOrigin(site.origin),
      cloudflareWebAnalytics: true,
    }),
  ).filter((r) => r.id === "C15");
  if (blocked.length > 0) {
    out.push({
      namespace: site.namespace,
      fingerprint: `live-csp-beacon-${site.namespace}-${where}`,
      headline: `${site.name}'s CSP blocks the Web Analytics beacon`,
      evidence: [`page: ${url}`, ...blocked.map((r) => `${r.name}: ${r.detail}`)],
    });
  }
  return out;
}

export function shaFinding(
  site: Pick<OpsSite, "namespace" | "name">,
  deployed: string | null,
  head: { sha: string; committed_at: string | null },
  now: Date,
): LiveFinding | null {
  if (deployed === null) {
    return {
      namespace: site.namespace,
      fingerprint: `live-sha-unreported-${site.namespace}`,
      headline: `${site.name} is set to be checked against its default branch but reports no deployed sha`,
      evidence: [
        "The site's health route did not report a sha, so the rule in capsid/policy/live-checks.md cannot be judged.",
        "Either the route does not report one or the rule should go.",
      ],
    };
  }
  if (deployed.length >= 7 && (head.sha.startsWith(deployed) || deployed.startsWith(head.sha)))
    return null;
  const committed = head.committed_at ? Date.parse(head.committed_at) : Number.NaN;
  if (Number.isNaN(committed)) return null;
  const minutes = (now.getTime() - committed) / MINUTE_MS;
  if (minutes < DEPLOY_GRACE_MINUTES) return null;
  return {
    namespace: site.namespace,
    fingerprint: `live-sha-drift-${site.namespace}-${head.sha.slice(0, 7)}`,
    headline: `${site.name}'s deployed sha is not its default branch head`,
    evidence: [
      `deployed: ${deployed}`,
      `default branch head: ${head.sha}, committed ${head.committed_at}`,
      `${Math.floor(minutes)} minutes ago, past the ${DEPLOY_GRACE_MINUTES} minute grace`,
      "A merge whose deploy failed or never ran looks exactly like this.",
    ],
  };
}

/**
 * The Web Analytics finding for one site, or null. A Worker cannot see the beacon the edge
 * injects, so what is read is the setting that makes Cloudflare inject it: the site's host has
 * automatic setup on, and its ruleset is not switched off.
 */
export function analyticsFinding(
  site: Pick<OpsSite, "namespace" | "name" | "origin">,
  sites: readonly WebAnalyticsSite[],
): LiveFinding | null {
  const host = new URL(site.origin).hostname.toLowerCase();
  const entry = sites.find((s) => s.host === host);
  if (!entry) {
    return {
      namespace: site.namespace,
      fingerprint: `live-analytics-missing-${site.namespace}`,
      headline: `${site.name}'s host has no Web Analytics site, so no traffic is counted`,
      evidence: [
        `host: ${host}`,
        `${sites.length} Web Analytics sites in the account, none for this host`,
        "Add the host under Web Analytics in the Cloudflare dashboard, with automatic setup.",
      ],
    };
  }
  if (entry.auto_install === true && entry.enabled !== false) return null;
  return {
    namespace: site.namespace,
    fingerprint: `live-analytics-off-${site.namespace}`,
    headline: `${site.name}'s Web Analytics automatic setup is off`,
    evidence: [
      `host: ${host}`,
      `auto_install: ${entry.auto_install}, ruleset enabled: ${entry.enabled}`,
      "Cloudflare injects the beacon only with automatic setup on, so no traffic is counted for this host.",
    ],
  };
}
