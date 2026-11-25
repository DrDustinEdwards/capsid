// The Portal's page CSP, in its own module so the Worker (src/portal-app.ts) and the app's browser
// tests (dashboard/dev/serve.ts) build one policy; a test run without the Worker's CSP would pass
// code the Worker's page then refuses.
import {
  buildContentSecurityPolicy,
  CSP_REPORT_GROUP,
  generateNonce,
  type SitePolicy,
} from "@dustinedwards/site-runtime/csp";
import { TRUSTED_TYPES_NAMES } from "@dustinedwards/site-runtime/trusted-types";
import { REPORT_URL } from "./security-headers";

const POLICY: SitePolicy = {
  sources: { img: ["data:"] },
  denyUnlisted: true,
  reportUri: REPORT_URL,
  reportTo: CSP_REPORT_GROUP,
  // default-src 'none' refuses the web manifest unless it is named: the Portal's install and phone
  // alerts need it.
  extraDirectives: ["manifest-src 'self'"],
  trustedTypes: TRUSTED_TYPES_NAMES,
};

export interface DashboardCsp {
  nonce: string;
  policy: string;
}

export function dashboardCsp(nonce: string = generateNonce()): DashboardCsp {
  const site = { ...POLICY, nonce };
  return {
    nonce,
    policy: buildContentSecurityPolicy(site).value,
  };
}
