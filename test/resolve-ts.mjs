// Lets `node --test` import src/*.ts, whose siblings are imported without an extension: the Worker bundler
// allows that, Node's ESM resolver does not. Test process only; delete once src/ carries explicit extensions.
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
