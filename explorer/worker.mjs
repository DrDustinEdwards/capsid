// The explorer's Worker, which answers only paths with no file (wrangler-config.mjs sets
// not_found_handling "none", so the asset server answers every file itself, with _headers): it is
// site-runtime's staticSite on the explorer's registry entry (capsid), the set _headers is written
// from, with Prelum's training reservation on top. It sends dist/404.html with status 404, that set,
// charset=utf-8 and private, no-store: no _headers rule can name a path with no file. Reports go to
// Capsid's /csp-report (the entry's reportOrigin), so the explorer receives none; pages end in a
// slash, which the asset server's auto-trailing-slash keeps, so there is no canonical redirect.
import { TDM_RESERVATION_HEADERS } from "@drdustinedwards/site-helpers/robots";
import { capsid } from "@dustinedwards/site-runtime/sites";
import { staticSite } from "@dustinedwards/site-runtime/static-site";

export default staticSite({ site: capsid, headers: TDM_RESERVATION_HEADERS, reportPath: null, prefetch: false, canonical: false });
