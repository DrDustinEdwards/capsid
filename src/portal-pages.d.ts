// The Portal's server-rendered pages: dashboard/src/worker.ts, built by `npm run build:dashboard`
// into dashboard/build/worker/portal.js, which wrangler.jsonc.example's alias names. The unit and
// integration tests resolve the same name to test/fixtures/portal-pages.ts.
declare module "capsid-portal-pages" {
  /** A Portal page: `request` names it as the browser does (/health), `read` answers the
   *  Portal's API routes ("/ops"), and `nonce` goes on every script the page renders. */
  export function renderPortalPage(
    request: Request,
    read: (path: string) => Promise<Response>,
    nonce: string,
  ): Promise<Response>;
  /** A demo page (/demos/...): `file` answers a path in the build's files, where the sample
   *  answers are (/demos/api/<name>.json). */
  export function renderDemoPage(
    request: Request,
    file: (path: string) => Promise<Response>,
    nonce: string,
  ): Promise<Response>;
}
