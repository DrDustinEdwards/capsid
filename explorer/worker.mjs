// The explorer's Worker: site-runtime's staticSite, the one front door the family's static sites
// share. wrangler-config.mjs runs it first for every page and leaves /assets/* and /fonts/* to the
// asset server, with _headers. Every page gets the Speculation-Rules header and the explorer's own
// prefetch rules at /speculation-rules.json (in place of Cloudflare's generic ones), Server-Timing,
// and the preload Link header (Early Hints); a path with no file gets dist/404.html with status
// 404 and private, no-store, and so does a page asked for with a cookie. Pages end in a slash
// (/s/x/), which the asset server's auto-trailing-slash keeps, so there is no canonical redirect.
// Reports go to Capsid's /csp-report (src/security-headers.mjs), so the explorer receives none.
import { staticSite } from "@dustinedwards/site-runtime/static-site";
import { explorerSecurityHeaders, PAGE_PRELOADS } from "./src/security-headers.mjs";

// The set without its Cache-Control: _headers gives each file its own, and the Worker's own
// responses (the prefetch rules) keep theirs.
const { "Cache-Control": _cache, ...SET } = explorerSecurityHeaders();

export default staticSite({ headers: SET, preload: PAGE_PRELOADS.header, reportPath: null, canonical: false });
