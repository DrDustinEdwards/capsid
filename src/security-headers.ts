import {
  buildPolicy,
  CSP_REPORT_GROUP,
  reportingEndpoints,
  scriptHash,
} from "@dustinedwards/site-runtime/csp";
import { buildSecurityHeaders } from "@dustinedwards/site-runtime/headers";
import { CONSENT_STYLE } from "@dustinedwards/site-runtime/mcp-login";
import { OWNER_STYLE } from "@dustinedwards/site-runtime/owner-page";
import { pageSecurity } from "@dustinedwards/site-runtime/page-headers";
import { capsidMcp, capsidPortal } from "@dustinedwards/site-runtime/sites";
import { MCP_HOST } from "./mcp-host";
import { PORTAL_HOST } from "./portal-host";

// THE HEADERS COME FROM THE PACKAGE: each host's set is its entry in site-runtime's registry (./sites), the same entry the live check (site-runtime-security) grades against, so none is typed here. The Portal host sends the standard exactly, COOP same-origin included (its sign-in is a full-page redirect to Access). The MCP host sends no COOP: its one page is the /authorize consent dialog, which MCP clients open in a popup and wait on through window.opener, and same-origin would sever that. No preload on HSTS: a vendor-list submission, effectively irreversible. The MCP host serves no page for search, so every response there says noindex, as site-runtime's withMcpHeaders does on the other doors.
const MCP_SET = {
  ...buildSecurityHeaders({ site: capsidMcp }),
  "X-Robots-Tag": "noindex, nofollow",
};
const PORTAL_SET = buildSecurityHeaders({ site: capsidPortal });

export const REPORT_PATH = "/csp-report";
// The sink by its full address on the MCP host, which Access does not cover. The Portal's host
// is behind Access, so a report sent to its own /csp-report met the sign-in redirect and was
// lost; every host now reports to this one (routes.ts answers the Portal's preflight).
export const REPORT_URL = `https://${MCP_HOST}${REPORT_PATH}`;
const REPORTING_ENDPOINTS = reportingEndpoints(CSP_REPORT_GROUP, REPORT_URL);
// Nothing writes under this prefix; the backup prune (backup.ts) reaps what is left.
export const REPORT_PREFIX = "reports/csp/";

// The policy on every response that names none of its own: nothing loads, nothing may frame it, no <base>, and no string reaches a script sink (Trusted Types; these pages run no script). An HTML page left without a policy gets the strictest one rather than none. form-action is deliberately absent, as below.
const DEFAULT_CSP = buildPolicy([
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  `report-uri ${REPORT_URL}`,
  `report-to ${CSP_REPORT_GROUP}`,
]);

// The OAuth consent dialog's own headers (src/routes.ts, renderApprovalDialog), less its per-request Set-Cookie; withSecurityHeaders adds the shared set. Kept here so node can import them: routes.ts cannot load under node --test.
//
// The dialog is site-runtime's (./mcp-login): one inline <style>, CONSENT_STYLE, trusted by its hash, and a form that posts back to /authorize. The owner page (/owner, ./owner-page) leaves with the same headers; its one style, OWNER_STYLE, is trusted by hash too. No scripts or images.
//
// form-action is deliberately absent. Approving submits this form into a redirect chain: POST /authorize, 302 to the Access sign-in, back to /callback, 302 out to the client's redirect_uri. Chrome enforces form-action against every hop and a blocked hop aborts the navigation silently while that response's Set-Cookie still lands. The terminal hop is whatever redirect_uri a client's metadata names, so no static allowlist can be correct. `form-action 'self'` shipped in 423bbd6 and broke hop two for 26 days, undetected because the approvedClients fast path never submits a form.
let consentHeaders: Promise<Readonly<Record<string, string>>> | undefined;
export function consentDialogHeaders(): Promise<Readonly<Record<string, string>>> {
  consentHeaders ??= Promise.all([scriptHash(CONSENT_STYLE), scriptHash(OWNER_STYLE)]).then(
    ([consent, owner]) => ({
      "Content-Type": "text/html;charset=utf-8",
      "Content-Security-Policy": buildPolicy([
        "default-src 'none'",
        `style-src '${consent}' '${owner}'`,
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "require-trusted-types-for 'script'",
        `report-uri ${REPORT_URL}`,
        `report-to ${CSP_REPORT_GROUP}`,
      ]),
    }),
  );
  return consentHeaders;
}

/** The set a response on `host` leaves with, where it has not set the header itself. */
export function securityHeadersFor(host: string): Record<string, string> {
  // no-store is applied by withCacheDefault, not here: /health is exempt and must stay cacheable.
  return {
    ...(host === PORTAL_HOST ? PORTAL_SET : MCP_SET),
    "Reporting-Endpoints": REPORTING_ENDPOINTS,
    "Content-Security-Policy": DEFAULT_CSP,
  };
}

// site-runtime's pageSecurity applies each host's set, the Reporting-Endpoints header and the default policy; a route's own value wins, and a text or XML Content-Type with no charset gets `charset=utf-8` (H2), since the assets binding serves the Portal's page and scripts without one. No response carries a nonce here: the Portal's page brings its own policy and nonce (src/dashboard-csp.ts).
const pages = (set: Readonly<Record<string, string>>) =>
  pageSecurity({ set, policy: () => DEFAULT_CSP, staged: false, reportPath: REPORT_URL });
const MCP_PAGES = pages(MCP_SET);
const PORTAL_PAGES = pages(PORTAL_SET);

export function withSecurityHeaders(response: Response, request: Request): Response {
  const host = new URL(request.url).hostname;
  return (host === PORTAL_HOST ? PORTAL_PAGES : MCP_PAGES).withSecurityHeaders(response, request);
}
