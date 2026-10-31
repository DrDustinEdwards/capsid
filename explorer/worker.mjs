// The explorer's Worker: site-runtime's staticSite on the explorer's registry entry (capsid), the set
// _headers is written from, with Prelum's training reservation on top. wrangler-config.mjs runs it
// first for every page and leaves /assets/* and /fonts/* to the asset server, with _headers. Every
// page gets Server-Timing, the Speculation-Rules header with the explorer's own prefetch rules at
// /speculation-rules.json (in place of Cloudflare's generic ones), and the preload Link header,
// which Early Hints answers with a 103. A path with no file gets dist/404.html with status 404 and
// private, no-store, and so does a page asked for with a cookie. Reports go to Capsid's /csp-report
// (the entry's reportOrigin), so the explorer receives none; pages end in a slash, which the asset
// server's auto-trailing-slash keeps, so there is no canonical redirect.
import { TDM_RESERVATION_HEADERS } from "@drdustinedwards/site-helpers/robots";
import { preloads } from "@dustinedwards/site-runtime/preload";
import { capsid } from "@dustinedwards/site-runtime/sites";
import { staticSite } from "@dustinedwards/site-runtime/static-site";

/**
 * What every page blocks on or paints first: the three stylesheets and the Schibsted Grotesk face
 * every page links (src/pages.mjs). The names are not hashed; the test holds them to the pages' links.
 */
export const PAGE_PRELOADS = preloads([
  { href: "/assets/capsomer.css", as: "style" },
  { href: "/assets/enarratio.css", as: "style" },
  { href: "/assets/explorer.css", as: "style" },
  { href: "/fonts/schibsted-grotesk-latin-wght-normal.woff2", as: "font", type: "font/woff2" },
]);

export default staticSite({ site: capsid, headers: TDM_RESERVATION_HEADERS, preload: PAGE_PRELOADS.header, reportPath: null, canonical: false });
