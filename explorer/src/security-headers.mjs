// The explorer's _headers file: the shared security headers and Content-Security-Policy from
// site-runtime and Prelum's training reservation (the TDMRep header ai.txt names), for every path, with long caching for the hashed-by-day assets kept off.
//
// The pages carry no inline script or style (src/pages.mjs), so the policy needs no hash or
// nonce: scripts and styles are 'self'. Violations go to Capsid's /csp-report, the family's one
// sink (src/security-headers.ts, REPORT_PATH). Enarratio's charts and Capsomer's map use no style
// attributes, so none are allowed; the browser spec fails on any violation.
import { buildContentSecurityPolicy } from "@dustinedwards/site-runtime/csp";
import { STANDARD_SECURITY_HEADERS } from "@dustinedwards/site-runtime/headers";
import { TDM_RESERVATION_HEADERS } from "@drdustinedwards/site-helpers/robots";

export const REPORT_URI = "https://mcp.dustinedwards.info/csp-report";

/** The text of _headers. */
export function headersFile() {
  // Cloudflare's edge injects its Web Analytics beacon into every page of the proxied host, so the
  // policy names it, or every page logs a blocked script.
  const csp = buildContentSecurityPolicy({ reportUri: REPORT_URI, cloudflareWebAnalytics: true });
  const lines = ["/*", `  ${csp.name}: ${csp.value}`];
  for (const [name, value] of Object.entries({ ...STANDARD_SECURITY_HEADERS, ...TDM_RESERVATION_HEADERS })) lines.push(`  ${name}: ${value}`);
  // The data changes once a day and the assets with each build, which renames nothing, so an
  // hour at the edge and in the browser is the most a reader can be behind.
  lines.push("  Cache-Control: public, max-age=3600");
  return `${lines.join("\n")}\n`;
}
