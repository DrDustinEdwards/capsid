// Lets `node --test` import src/server.ts, which imports its siblings without a
// file extension ("./github", "./auth").
//
// Node's ESM resolver requires the extension; the Worker bundler does not, and every
// module in src/ is written for the bundler. Appending .ts in src/ would change the
// production bundle to make a test runnable; this hook exists only in the test
// process.
//
// Registered by the test script via --import. Delete it the day src/ carries
// explicit extensions.
import { registerHooks } from "node:module";

// The Portal's pages are the dashboard's build (src/portal-pages.d.ts), which a test does not
// build: the tests' stand-in answers for it.
const PORTAL_PAGES = new URL("./fixtures/portal-pages.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "capsid-portal-pages") return nextResolve(PORTAL_PAGES, context);
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (relative && !/\.[cm]?[jt]s$|\.json$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // Fall through, so a missing module reports itself rather than a missing .ts.
      }
    }
    return nextResolve(specifier, context);
  },
});
