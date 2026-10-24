// The app's page CSP, in its own module so the Worker (src/portal-app.ts) and the app's
// browser tests (dashboard/dev/mock-api.ts serves it under vite preview) read one string.
// A browser test run without the Worker's CSP would pass code the Worker's page then refuses.
//
// Scripts and styles from this origin and nothing inline, so an injected tag in anything the
// feed carries cannot run; nothing unlisted (denyUnlisted). The consent dialog's CSP is separate.
// Violations go to the sink on the MCP host (REPORT_URL), the group Reporting-Endpoints names.
import { buildContentSecurityPolicy } from "@dustinedwards/site-runtime/csp";
import { REPORT_URL } from "./security-headers";

export const DASHBOARD_CSP = buildContentSecurityPolicy({
  sources: { img: ["data:"] },
  denyUnlisted: true,
  reportUri: REPORT_URL,
  reportTo: "csp",
}).value;
