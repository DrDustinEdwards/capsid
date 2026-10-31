import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

// The bindings and vars wrangler.jsonc.example declares (DB, APP_KV, OAUTH_KV, MEDIA,
// AI_SEARCH, GITHUB_APP_CLIENT_ID) come from worker-configuration.d.ts, which
// `npm run types` generates with `wrangler types` and test/env-types.test.ts holds to
// the example in both directions. What is written here is what the config cannot say:
// secrets, the OAuth provider the library injects, the optional assets binding, and the
// build stamps. GITHUB_APP_CLIENT_ID is generated as the literal pinned id; it is widened to string
// here so tests and the deploy check can hold other values.
export interface Env extends Omit<GeneratedEnv, "GITHUB_APP_CLIENT_ID"> {
  OAUTH_PROVIDER: OAuthHelpers;
  OPERATOR_KEY_HASH: string;
  COOKIE_ENCRYPTION_KEY: string;
  // The MCP and Portal logins' upstream: Cloudflare Access for SaaS (OIDC),
  // src/access-login.ts. Unset, the sign-in is closed; ADMIN_EMAIL unset admits nobody,
  // co-owners included.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_SAAS_CLIENT_ID?: string;
  ACCESS_SAAS_CLIENT_SECRET?: string;
  ADMIN_EMAIL?: string;
  // Co-owners: comma-separated emails admitted exactly like ADMIN_EMAIL (src/auth.ts
  // isAdminEmail), each recorded under its own verified email, `access:<email>`. A
  // co-owner cannot change ADMIN_EMAIL or this list: both are set only in Cloudflare.
  // Optional; unset or empty means no co-owners. Ignored while ADMIN_EMAIL is unset.
  CO_OWNER_EMAILS?: string;
  // The Audience tag of the self-hosted Access application that covers only
  // portal.dustinedwards.info/admin/access-drift, Service Auth only, for the drift check's
  // service token (src/index.ts). Unset, that path is 404 to everyone.
  ACCESS_DRIFT_AUD?: string;
  // The Watch Floor's Cloudflare read (src/ops-cloudflare.ts): a read-only API token
  // with Account Analytics Read and Workers Scripts Read, and the account it reads.
  // Unset, the deploy and error columns show no data and say why.
  CF_OPS_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  // Capsid Admin's capsid_admin_set_site_key (src/site-key.ts): a token with Workers Scripts Edit, to
  // set a site's key as a secret on its Worker and on Carrel. Apart from CF_OPS_TOKEN
  // because it writes. Unset, capsid_admin_set_site_key mints nothing and says why.
  CF_SECRETS_TOKEN?: string;
  // The Access sync's write token (src/access-sync.ts): Access: Groups Write, Access: Users
  // Read and Zero Trust: Seats Write on this account only. Capsid is its only holder
  // (Dustin, 2026-10-09). Unset, POST /ops/access-sync answers 503 and calls nothing.
  CF_ACCESS_SYNC_TOKEN?: string;
  // Google Search Console's read (src/search-console.ts): a service account's whole JSON
  // key, the account added as a Full user on each site's property. Unset,
  // capsid_inspect_repo action search reads nothing and says why.
  GSC_SERVICE_ACCOUNT_KEY?: string;
  // Bing Webmaster Tools' read (src/bing-webmaster.ts): the API key from Bing Webmaster
  // Tools' Settings, API access. Bing gives it no narrower scope, so the module calls only
  // Get methods. Unset, capsid_inspect_repo action bing reads nothing and says why.
  BING_WEBMASTER_API_KEY?: string;
  // The dashboard app's built files (dashboard/dist), served under /portal/ only
  // after the Portal's gate. Absent where no assets are configured.
  ASSETS?: Fetcher;
  // GitHub App. No pinned installation id: resolved per owner and repo.
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  // Stamped by scripts/deploy.mjs at deploy time, not committed.
  BUILD_SHA?: string;
  BUILD_DIRTY?: string;
  BUILT_AT?: string;
  // Root secret the job and policy signing key (src/signed-docs.ts) and the backup
  // credential key (src/signed-requests.ts) are derived from. Named for the improve
  // loop that first used it; renaming a Worker secret is a step only the seat can take.
  IMPROVE_SCORE_SECRET?: string;
  // The capsid-bench repo's signing key (src/bench.ts), the same value as its BENCH_KEY secret.
  BENCH_SECRET?: string;
  // The backup credential mint (src/signed-requests.ts): the temp-access-credentials
  // token and the parent it derives from. Omitted from RepoEnv.
  R2_TEMP_CRED_TOKEN?: string;
  R2_ACCOUNT_ID?: string;
  R2_BACKUP_PARENT_ACCESS_KEY_ID?: string;
  // The watcher's red and green mail about a site's health (src/site-watch.ts): a
  // send_email binding, the address it sends to and the one it sends from, all optional and set by the seat
  // in wrangler.jsonc (docs/portal.md, "Site repairs"). Unset, nothing is mailed, the
  // finding still opens in Incidents, and each pass says the mail was not sent.
  // Each site's operator token is a secret named by that site's configuration
  // (<NAME>_OPERATOR_TOKEN, src/site-operator.ts), read by name and never declared here.
  // The per-connector DCR callbacks (site-runtime's registrationRefusal, src/index.ts):
  // Gemini's and ChatGPT's exact redirect URIs, comma separated, set by the seat in
  // wrangler.jsonc. Unset, only site-runtime's DCR_CALLBACKS can register.
  DCR_REDIRECT_URIS?: string;
  EMAIL?: SendEmail;
  // The daily digest (src/digest.ts) sends only when this var is "on", which the seat sets
  // once Dustin has turned Email Routing on for the domain and verified ALERT_EMAIL.
  EMAIL_ROUTING?: string;
  // Phone alerts (src/push.ts, src/web-push.ts): the VAPID key that signs each Web Push,
  // a P-256 private key as a JWK, put by scripts/vapid-keys.mjs. Unset, no alert is sent
  // and the Portal's Settings says why.
  VAPID_PRIVATE_KEY?: string;
  // The signed-in crawl's Access service token for Carrel Desk (src/signed-in-crawl.ts): the token's Client ID and
  // Client Secret, admitted by a Service Auth rule on Desk's Access application. Unset, Desk's result is "error".
  DESK_CRAWL_CLIENT_ID?: string;
  DESK_CRAWL_CLIENT_SECRET?: string;
  ALERT_EMAIL?: string;
  ALERT_FROM?: string;
}

// What the GitHub modules (src/github/) are handed: everything except the credentials
// that mint backup read access, the Cloudflare read token (it can read Worker code), the
// Access sync's write token, the key that signs phone alerts and Desk's crawl token.
export type RepoEnv = Omit<Env, "R2_TEMP_CRED_TOKEN" | "R2_BACKUP_PARENT_ACCESS_KEY_ID" | "CF_OPS_TOKEN" | "CF_ACCESS_SYNC_TOKEN" | "VAPID_PRIVATE_KEY" | "DESK_CRAWL_CLIENT_ID" | "DESK_CRAWL_CLIENT_SECRET">;

// A grant's props: the email Access verified at sign-in. Grants issued before the move
// to Access carry { id, login, name } from GitHub instead, fail the per-request email
// check, and the client signs in again once.
export interface Props extends Record<string, unknown> {
  email: string;
  // When Access verified that email, in milliseconds since the epoch, set at /callback.
  // The admin server's step-up reads it (src/scope.ts STEP_UP): a risky admin action
  // needs a sign-in this recent. A grant made before it was recorded carries none and
  // reads as stale.
  signed_in_at?: number;
}
