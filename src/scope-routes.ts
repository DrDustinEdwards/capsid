// The HTTP routes checkScope covers and the ones it does not.
import type { ToolRequirement } from "./scope";

// HTTP routes, which guardRegistrations never sees (it wraps MCP tools). A route checked only for
// the write grant would let a driver minted for one namespace act across all of them.

// A route that goes through checkScope, and what it requires.
export const ROUTE_GRANTS: Record<string, ToolRequirement> = {};

// A route that does not, and why. Each reason names what authorizes the request
// instead, because "public" and "authorized some other way" are different claims.
export const UNGATED_ROUTES: Record<string, string> = {
  "/health": "a liveness probe that returns provenance and store health, never a document",
  "/public/model/v1.json":
    "the public system model (src/public-data.ts): public by design, it serves only the document the daily build stored after toPublic filtered it (src/system-model.ts), never D1 or GitHub; GET only, edge-cached, then a per-IP KV limit that fails closed; no CORS, since site builds read it, not browsers",
  "/public/stats/v1.json":
    "the public aggregate numbers (src/public-stats.ts): counts, rates and medians over every namespace, agent and site, whole UTC days, null under ten rows, no string but a date and the sha /health shows; it serves only what the daily build stored, never D1; GET only, edge-cached, the same per-IP limit as the model, failing closed; no CORS",
  "/public/code/v1.json":
    "the public code maps (src/public-code.ts): each public system's repos' code-map.json from their code-map branch, parsed field by field, a private system's repos never read; it serves only what the daily build stored, never GitHub; GET only, edge-cached, the same per-IP limit as the model, failing closed; no CORS",
  "/public/versions/v1.json":
    "the public versions model (src/system-versions.ts): which version of each network package each system installs, read from the repos' lockfiles, a private system's without its file paths; it serves only what the nightly build stored, never GitHub; GET only, edge-cached, the same per-IP limit as the model, failing closed; no CORS",
  "/reports/signed-in-security.json":
    "the signed-in crawl's report (src/signed-in-crawl.ts): findings about the Portal's signed-in headers, for devkit's scoreboard; it serves only what the hourly crawl stored in KV, never a page, cookie or token; GET only",
  "/oauth/clients/verify-live.json":
    "the verify-live probe's OAuth client metadata document (src/oauth-client-docs.ts): public by nature, fetched by the authorization server with no credential, and holds no secret",
  "/csp-report":
    "browsers post violation reports with no credential; the body is size- and type-bounded and rate-limited",
  "/ops/mcp":
    "resolves the caller, and every tool call it serves then passes checkScope in the registrar",
  "/backup/credential":
    "signed with the backup-specific HMAC key, derived from the Worker's root secret under its own context, and replay-protected",
  "/backup/offaccount-report":
    "signed with the same backup-specific HMAC key and replay-protected under its own jti scope; stores the Amazon copy's per-site run ids for the watcher (src/offaccount.ts) and returns nothing",
  "/bench/tasks":
    "signed with the capsid-bench HMAC key (src/bench.ts), which no backup key can produce, and replay-protected; registers a task once and never changes one",
  "/bench/draw":
    "signed with the capsid-bench HMAC key and replay-protected; records the registration once and appends the drawn task order, which never changes",
  "/bench/start":
    "signed with the capsid-bench HMAC key and replay-protected; opens a run only while KV bench:enabled reads on and under the running cap, and returns a treatment run's own run key once",
  "/bench/repro":
    "signed with the capsid-bench HMAC key and replay-protected; writes the harness's reproduction receipt once for one running treatment run, which its run key's complete then requires",
  "/review/run":
    "a GitHub Actions OIDC token (audience capsid-review) whose owner id is Dustin's, whose job workflow is devkit's review.yml and whose event is a pull request; reviews only that pull request, read through the GitHub App, and records the verdict (src/review.ts)",
  "/bench/score":
    "signed with the capsid-bench HMAC key and replay-protected; closes one running bench run, takes every arm's claim from the report, and checks the treatment's job is its own, and closes that job in the same step",
  "/ops/inbox":
    "what needs Dustin, per app (src/inbox.ts): resolveAgent on the bearer (401 without one), then each app is kept only if checkScope admits the caller's read grant on that app's namespace, so a key scoped to one namespace sees that app alone and the admin or an all-namespace read key sees every app. GET only, no CORS headers (an app's server calls it, never a browser), nothing written",
  "/ops/inbox/report":
    "what an app reports about itself to the inbox (src/inbox-report.ts): resolveAgent on the bearer (401 without one), then checkScope for the write grant on the namespace the report names (403 otherwise), so a key reports for its own app alone; one report per minute per key, failing closed; at most 20 items, links on the app's own ops_sites origin only, a 16KB body cap; POST only, no CORS",
  "/authorize":
    "the OAuth authorization step, gated by the OAuth provider and the Access for SaaS login",
  "/callback": "the OAuth callback, which validates state before issuing anything",
  "/owner":
    "site-runtime's owner page (./owner-page), gated as /owner/* is: the Access for SaaS sign-in and admission of consent, ADMIN_EMAIL and CO_OWNER_EMAILS, before it shows anything",
  "/owner/*":
    "the owner page's POSTs /owner/revoke and /owner/sign-out (site-runtime ./owner-page): the same Access for SaaS sign-in and admission as consent (ADMIN_EMAIL and CO_OWNER_EMAILS), a state bound to the browser, a hashed 30-minute session in OAUTH_KV; a revoke needs a same-origin Origin and the session's CSRF token and reaches only the signed-in person's own grants",
  "/register":
    "tightened Dynamic Client Registration for Grok and Gemini (site-runtime registrationLimited and registrationRefusal, src/index.ts): rate limited per address (5 an hour) and, for a registration the allowlist allows, overall (30 a day), failing closed, every redirect URI matched exactly against the allowlist; it writes a client record and grants nothing, since the client still meets the consent page and the Access sign-in",
  "/portal/callback":
    "Capsid Portal's Access for SaaS callback, which validates state before issuing a session",
  "/portal/api/ops":
    "the Portal's feed, gated by portalGate: the administrator's Access session, and a 403 for any bearer",
  "/portal/api/ops/refresh":
    "one watcher pass on demand, gated by portalGate, then a same-origin header, then a KV rate limit that fails closed",
  "/portal/api/actions/preview":
    "a Portal action's preview, which writes nothing: portalGate, a same-origin Sec-Fetch-Site, a 64KB body cap, then the X-Capsid-CSRF header against the capsid_portal_csrf cookie",
  "/portal/api/actions/perform":
    "a Portal action's perform: the preview's checks, then a token signed at preview time that binds the action, its params and the administrator's email for five minutes",
  "/portal/api/namespaces":
    "the Portal's per-namespace status, read through the function behind capsid_read_status action status, gated by portalGate",
  "/portal/api/activity": "the Portal's bounded audit_log read, gated by portalGate",
  "/portal/api/claims":
    "the Portal's bounded read of claims, evaluations and touches, through the capsid_admin_read_claims tool's readers, gated by portalGate",
  "/portal/api/stale":
    "the Portal's stale jobs, through the reader behind capsid_work_jobs action list stale: true, gated by portalGate",
  "/portal/api/plan":
    "the Portal's Tonight plan, through the reader behind capsid_work_jobs action list view plan, over every namespace, gated by portalGate",
  "/portal/api/merge-units":
    "the Portal's Merge units panel: the suspended merge units and the units tick's proposals, read from KV, gated by portalGate",
  "/portal/api/site-search":
    "a site page's search tab: Search Console and Bing Webmaster for one namespace's site, through the readers behind capsid_inspect_repo actions search_console and bing_webmaster, gated by portalGate",
  "/portal/api/site-traffic":
    "a site page's traffic tab: 404s, 5xx, web vitals and AI crawlers from Cloudflare for one namespace's site, through the reader behind capsid_inspect_repo action site_traffic, gated by portalGate",
  "/portal/api/workers-builds":
    "a site page's deploys tab: the Workers Builds of the Worker one namespace's site row names, through the reader behind capsid_admin_read_ops action workers_builds, gated by portalGate",
  "/portal/api/build-log":
    "one Workers Build's log for a site page's deploys tab, through the reader behind capsid_admin_read_ops action workers_build_logs, gated by portalGate",
  "/portal/api/digest":
    "the Portal's since-you-last-looked strip, through the reader behind capsid_work_jobs action list view digest, over every namespace, gated by portalGate",
  "/portal/api/backups":
    "Health's Backups tab: every site's backup_status read live through its operator API beside its Amazon copy, through the reader behind capsid_admin_read_ops action backups, gated by portalGate",
  "/portal/api/convergence":
    "the Portal's convergence view of each site that opted into its operator API: sync_status, the health route and secret names read live, gated by portalGate",
  "/portal/api/maintenance":
    "the Portal's Maintenance list, the daily pass's stored list that capsid_read_status action status serves, gated by portalGate",
  "/portal/api/packages/history":
    "the Portal's on-demand download history of one configured package, cached, gated by portalGate",
  "/portal/api/completeness":
    "the Portal's Completeness view: devkit's daily scoreboard (board.json on its scoreboard branch), read through the GitHub App and cached for ten minutes, gated by portalGate",
  "/portal/api/not-found":
    "the Portal's 404 panel: Capsid's own missing pages from page_404_daily over 30 days, read-only, gated by portalGate",
  "/portal/api/shared-code":
    "the Portal's Shared code view: each network package's releases and the pins in every model repo, read nightly through the GitHub App and kept in KV, gated by portalGate",
  "/portal/api/resources":
    "the Portal's Workers tab: the secrets and data model (secret names, never values, and each Worker's stores), read nightly from Cloudflare and kept in KV, gated by portalGate",
  "/portal/api/library":
    "the Portal's read-only Library: the knowledge store's shelves, a search and one document with its edges, through the readers behind capsid_find_docs and capsid_read_doc, gated by portalGate",
  "/portal/api/trends":
    "the Portal's trends for its charts: minutes, the queue, merges and rollbacks from D1, backup slots from R2, default-branch CI from GitHub (cached an hour), read-only, gated by portalGate",
  "/portal/api/push":
    "the Portal's phone alerts: GET lists the devices with alerts on behind portalGate; POST turns one on or off or sends a test behind the preview's checks (portalGate, same-origin, the body cap, CSRF)",
  "/portal/api/sign-out":
    "expires the Portal's own cookies, behind the preview's checks so a cross-site page cannot sign the administrator out",
  "/portal/api/*":
    "any other path under /portal/api/: portalGate, then a JSON 404, so the app's page is never served as data",
  "/portal":
    "Capsid Portal's page, served from ASSETS only after portalGate admits the administrator's session",
  "/portal/*":
    "Capsid Portal's files and client routes, served from ASSETS only after portalGate admits the administrator's session",
};
