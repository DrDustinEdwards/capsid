// The Portal's page CSP, in its own module so the Worker (src/portal-app.ts) and the app's
// browser tests (dashboard/dev/serve.ts) build one policy. A browser test run without the
// Worker's CSP would pass code the Worker's page then refuses.
//
// Scripts and styles from this origin, and React Router's inline scripts (its hydration data
// and module loader) by this response's nonce, so an injected tag in anything the feed carries
// cannot run: it carries no nonce. The page is never shared-cached, so a nonce per response is
// the right form (site-runtime ./csp). Nothing unlisted (denyUnlisted). The consent dialog's CSP
// is separate. Violations go to the sink on the MCP host (REPORT_URL), the group
// Reporting-Endpoints names. Trusted Types is staged (the Portal's registry entry): the
// Report-Only policy is the same with require-trusted-types-for added, sent beside it until the
// reports name every sink React reaches.
import { buildContentSecurityPolicy, buildStagedPolicy, CSP_REPORT_GROUP, generateNonce, type SitePolicy } from "@dustinedwards/site-runtime/csp";
import { REPORT_URL } from "./security-headers";

const POLICY: SitePolicy = {
  sources: { img: ["data:"] },
  denyUnlisted: true,
  reportUri: REPORT_URL,
  reportTo: CSP_REPORT_GROUP,
  // default-src 'none' refuses the web manifest unless it is named: the Portal's install and phone alerts need it.
  extraDirectives: ["manifest-src 'self'"],
};

export interface DashboardCsp {
  nonce: string;
  policy: string;
  reportOnly: string;
}

/** A fresh nonce and the two policies that carry it, for one page response. */
export function dashboardCsp(nonce: string = generateNonce()): DashboardCsp {
  const site = { ...POLICY, nonce };
  return { nonce, policy: buildContentSecurityPolicy(site).value, reportOnly: buildStagedPolicy(site, { trustedTypes: true }).value };
}
