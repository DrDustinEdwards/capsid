// The explorer's _headers file: the shared security headers and Content-Security-Policy from
// site-runtime and Prelum's training reservation (the TDMRep header ai.txt names), for every path, with long caching for the hashed-by-day assets kept off.
//
// The pages carry no inline script or style (src/pages.mjs), so the policy needs no hash or
// nonce: scripts and styles are 'self'. Violations go to Capsid's /csp-report, the family's one
// sink (src/security-headers.ts, REPORT_PATH). Enarratio's charts and Capsomer's map use no style
// attributes, so none are allowed; the browser spec fails on any violation.
import { buildContentSecurityPolicy } from "@dustinedwards/site-runtime/csp";
import { headersFile, STANDARD_SECURITY_HEADERS } from "@dustinedwards/site-runtime/headers";
import { TDM_RESERVATION_HEADERS } from "@drdustinedwards/site-helpers/robots";

export const REPORT_URI = "https://mcp.dustinedwards.info/csp-report";

/** The text of _headers. */
export function explorerHeadersFile() {
  // Cloudflare's edge injects its Web Analytics beacon into every page of the proxied host, so the
  // policy names it, or every page logs a blocked script.
  const csp = buildContentSecurityPolicy({ reportUri: REPORT_URI, cloudflareWebAnalytics: true });
  // The data changes once a day and the assets with each build, which renames nothing, so an
  // hour at the edge and in the browser is the most a reader can be behind.
  const set = { ...STANDARD_SECURITY_HEADERS, ...TDM_RESERVATION_HEADERS, "Cache-Control": "public, max-age=3600" };
  // headersFile leaves the policy off its `/*` block, since a Worker site sets it per page. The
  // explorer is static with no Worker, so its one policy goes on every path in a second `/*`
  // block; Cloudflare applies both.
  return headersFile(set, { paths: { "/*": { [csp.name]: csp.value } } });
}
