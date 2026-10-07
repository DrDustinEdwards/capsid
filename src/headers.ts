import { buildSecurityHeaders } from "@dustinedwards/security-headers/headers";

export type SurfaceClass = "html" | "json" | "other";

// THE ENFORCED HEADERS COME FROM THE PACKAGE (CLAUDE.md is silent; conventions and
// capsid/research/centralize-build-jobs.md, D6.3). @dustinedwards/security-headers holds OWASP's
// defaults, so none is typed here. Capsid keeps what the package cannot express, and names it:
//   - Cross-Origin-Opener-Policy-Report-Only: COOP ships on trial, never enforced, pending a
//     demonstrated case and a ruling, so the package's enforced COOP is removed below.
//   - Reporting-Endpoints and the report-only CSP on non-HTML: they carry this Worker's own
//     /csp-report sink (REPORT_PATH), which the package's builder does not model.
//   - The consent dialog's enforced CSP (CONSENT_DIALOG_HEADERS), set by routes.ts.
// No preload on HSTS: that is a vendor-list submission and effectively irreversible.
export const CAPSID_STANDARD_HEADERS: Readonly<Record<string, string>> = buildSecurityHeaders({
  overrides: {
    "Cross-Origin-Opener-Policy": {
      value: null,
      reason: "COOP is on trial as Report-Only (COOP_REPORT_ONLY) pending a demonstrated case and a ruling",
    },
  },
});

export const HSTS = CAPSID_STANDARD_HEADERS["Strict-Transport-Security"];
export const PERMISSIONS_POLICY = CAPSID_STANDARD_HEADERS["Permissions-Policy"];

export const REPORT_PATH = "/csp-report";
export const REPORTING_ENDPOINTS = `csp="${REPORT_PATH}"`;
// Shared by intake (routes.ts) and prune (backup.ts), which must agree.
export const REPORT_PREFIX = "reports/csp/";

// Report-Only, never enforced. form-action is deliberately absent.
export const CSP_REPORT_ONLY_NON_HTML =
  `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; report-uri ${REPORT_PATH}; report-to csp`;

export const COOP_REPORT_ONLY = "same-origin";

// The OAuth consent dialog's own headers (src/routes.ts, renderApprovalDialog), less
// its per-request Set-Cookie. Kept here so node can import them: routes.ts cannot load
// under node --test, and test/counts.test.ts derives the enforced header count from
// this object.
//
// The dialog has an inline <style> and posts a form back to /authorize. No scripts or
// images, so everything else is locked down.
//
// form-action is deliberately absent. Approving submits this form into a redirect
// chain: POST /authorize, 302 to the Access sign-in, back to /callback, 302 out to the
// client's redirect_uri. Chrome enforces form-action against every hop and a blocked
// hop aborts the navigation silently while that response's Set-Cookie still lands. The
// terminal hop is whatever redirect_uri a client's metadata document names, and any
// client may publish one, so no static allowlist can be correct. Adding the upstream
// and claude.ai alongside 'self' was rejected: it holds until the next client appears.
//
// `form-action 'self'` shipped in 423bbd6 and broke hop two for 26 days, undetected
// because the approvedClients fast path 302s out of the GET and never submits a form.
export const CONSENT_DIALOG_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html;charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

// No Origin passes, same-origin passes, claude.ai passes. Everything else is refused.
const MCP_BROWSER_ORIGINS = new Set(["https://claude.ai"]);

export function mcpOriginProblem(request: Request): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  if (origin === new URL(request.url).origin) return null;
  if (MCP_BROWSER_ORIGINS.has(origin)) return null;
  return `forbidden: Origin ${origin} is not allowed on /mcp. This endpoint accepts same-origin requests, https://claude.ai, and clients that send no Origin header.`;
}

export function classifySurface(contentType: string | null): SurfaceClass {
  if (!contentType) return "other";
  const ct = contentType.toLowerCase();
  if (ct.includes("text/html")) return "html";
  // Covers application/json and the +json suffix family (problem+json,
  // reports+json), which is what the provider and the MCP handler emit.
  if (ct.includes("json")) return "json";
  return "other";
}

export function securityHeadersFor(surface: SurfaceClass): Record<string, string> {
  const base: Record<string, string> = {
    ...CAPSID_STANDARD_HEADERS,
    "Reporting-Endpoints": REPORTING_ENDPOINTS,
  };

  if (surface === "html") {
    return { ...base, "Cross-Origin-Opener-Policy-Report-Only": COOP_REPORT_ONLY };
  }

  // no-store is already applied by withCacheDefault; repeating it here would
  // break /health, which is exempt and must stay cacheable.
  return {
    ...base,
    "Content-Security-Policy-Report-Only": CSP_REPORT_ONLY_NON_HTML,
  };
}

export function withSecurityHeaders(response: Response): Response {
  const surface = classifySurface(response.headers.get("Content-Type"));
  const wanted = securityHeadersFor(surface);

  const absent = Object.keys(wanted).filter((k) => !response.headers.has(k));
  if (absent.length === 0) return response;

  // Headers on an already-constructed Response can be immutable, so rebuild.
  const headers = new Headers(response.headers);
  for (const key of absent) headers.set(key, wanted[key]);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
