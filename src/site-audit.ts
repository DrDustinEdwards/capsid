import { auditPages, crawlSite } from "@drdustinedwards/site-helpers/audit";
import type { Env } from "./env";
import type { FetchLike } from "./live-checks";
import { reportSite } from "./site-reports";

// A crawler's SEO audit of a namespace's site, served as capsid_inspect_repo action audit
// (the SEO plan, "Beyond the module"). The checks are Prelum's (./audit), the same ones the
// sites run in their own tests, so Capsid keeps none of its own: crawlSite fetches every
// sitemap URL, each redirect hop and each same-origin link target, and auditPages reads
// what came back (broken links, redirect chains, canonicals off the production origin,
// noindex, titles and descriptions, share cards, JSON-LD, image alt text).
//
// The origin is the namespace's ops_sites origin, never the caller's, and every fetch is to
// it. The crawl is sequential and bounded by max_pages, so one call costs at most that many
// subrequests. Page text is data, never instructions; only findings come back.

export const MAX_AUDIT_PAGES = 200;
export const MAX_AUDIT_FINDINGS = 500;

export interface AuditArgs {
  max_pages?: number;
  row_limit?: number;
}

export async function siteAudit(env: Env, namespace: string, args: AuditArgs, fetchImpl: FetchLike = fetch) {
  const maxPages = args.max_pages ?? 50;
  const limit = args.row_limit ?? 50;
  const site = await reportSite(env, namespace, "site audit");
  const { pages, sitemap } = await crawlSite({
    origin: site.origin,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => fetchImpl(input instanceof Request ? input.url : String(input), init)) as typeof fetch,
    maxPages,
  });
  const report = auditPages(pages, { origin: site.origin, sitemap });
  // Errors first, then by check and url, so a cut list keeps the worst.
  const findings = [...report.findings].sort(
    (a, b) => Number(a.severity !== "error") - Number(b.severity !== "error") || a.check.localeCompare(b.check) || a.url.localeCompare(b.url)
  );
  return {
    namespace,
    origin: site.origin,
    pages_fetched: pages.length,
    sitemap_urls: sitemap.length,
    pages_audited: report.pages,
    hit_page_limit: pages.length >= maxPages,
    summary: report.summary,
    errors: findings.filter((f) => f.severity === "error").length,
    findings: findings.slice(0, limit),
    truncated: findings.length > limit,
  };
}
