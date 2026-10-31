// The explorer's _headers file: the shared security headers and Content-Security-Policy from
// site-runtime and Prelum's training reservation (the TDMRep header ai.txt names), for every path, with long caching for the hashed-by-day assets kept off.
//
// The pages carry no inline script or style (src/pages.mjs), so the policy needs no hash or
// nonce: scripts and styles are 'self'. Violations go to Capsid's /csp-report, the family's one
// sink (src/security-headers.ts, REPORT_PATH), by both report-uri and the report-to group "csp". Enarratio's charts and Capsomer's map use no style
// attributes, so none are allowed; the browser spec fails on any violation.
import { buildContentSecurityPolicy, reportingEndpoints } from "@dustinedwards/site-runtime/csp";
import { headersFile, STANDARD_SECURITY_HEADERS } from "@dustinedwards/site-runtime/headers";
import { TDM_RESERVATION_HEADERS } from "@drdustinedwards/site-helpers/robots";

export const REPORT_URI = "https://mcp.dustinedwards.info/csp-report";

/**
 * The set every response carries, the policy included: _headers, and the Worker's 404 (worker.mjs).
 * @returns {Record<string, string>}
 */
export function explorerSecurityHeaders() {
  // Cloudflare's edge injects its Web Analytics beacon into every page of the proxied host, so the
  // policy names it, or every page logs a blocked script.
  const csp = buildContentSecurityPolicy({ reportUri: REPORT_URI, reportTo: "csp", cloudflareWebAnalytics: true });
  // The data changes once a day and the assets with each build, which renames nothing, so an
  // hour at the edge and in the browser is the most a reader can be behind.
  return { ...STANDARD_SECURITY_HEADERS, ...TDM_RESERVATION_HEADERS, "Cache-Control": "public, max-age=3600", "Reporting-Endpoints": reportingEndpoints("csp", REPORT_URI), [csp.name]: csp.value };
}

/** The text of _headers. */
export function explorerHeadersFile() {
  const { "Content-Security-Policy": policy, ...set } = explorerSecurityHeaders();
  // headersFile leaves the policy off its `/*` block, since a Worker site sets it per page. Every
  // page here is a static file under this one policy, so it goes on every path in a second `/*`
  // block; Cloudflare applies both. `charset` adds charset=utf-8 to the HTML, XML and text files,
  // which the asset server sends without one.
  return headersFile(set, { charset: true, paths: { "/*": { "Content-Security-Policy": policy } } });
}
