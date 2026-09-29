// The app's page CSP, in a module with no imports, so the Worker (src/portal-app.ts)
// and the app's browser tests (dashboard/dev/mock-api.ts serves it under vite preview)
// read one string. A browser test run without the Worker's CSP would pass code the
// Worker's page then refuses.
//
// Scripts and styles from this origin and nothing inline, so an injected tag in
// anything the feed carries cannot run. The consent dialog's CSP is separate.
export const DASHBOARD_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
