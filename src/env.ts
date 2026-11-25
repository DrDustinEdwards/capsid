import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

// What is written here is what the config cannot say: secrets, the OAuth provider the library
// injects, the optional assets binding, and the build stamps.
export interface Env extends Omit<
  GeneratedEnv,
  "GITHUB_APP_CLIENT_ID" | "EMAIL" | "ALERT_FROM" | "EMAIL_ROUTING"
> {
  OAUTH_PROVIDER: OAuthHelpers;
  MAINTENANCE?: string;
  COOKIE_ENCRYPTION_KEY: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_SAAS_CLIENT_ID?: string;
  ACCESS_SAAS_CLIENT_SECRET?: string;
  ADMIN_EMAIL?: string;
  // Co-owners: comma-separated emails admitted exactly like ADMIN_EMAIL (src/auth.ts site-runtime
  // isAdminEmail), each recorded under its own verified email, `access:<email>`. A co-owner cannot
  // change ADMIN_EMAIL or this list: both are set only in Cloudflare.
  CO_OWNER_EMAILS?: string;
  // The Audience tag of the self-hosted Access application that covers only
  // portal.dustinedwards.info/admin/access-drift, Service Auth only, for the drift check's service
  // token (src/index.ts). Unset, that path is 404 to everyone.
  ACCESS_DRIFT_AUD?: string;
  CF_OPS_TOKEN?: string;
  AI_GATEWAY_ID?: string;
  CF_ACCOUNT_ID?: string;
  // The Portal's site_key_rotate control (src/site-key.ts): a token with Workers Scripts Edit, to
  // set a site's key as a secret on its Worker and on Carrel. Apart from CF_OPS_TOKEN because it
  // writes. Unset, the control mints nothing and says why.
  CF_SECRETS_TOKEN?: string;
  GSC_SERVICE_ACCOUNT_KEY?: string;
  // Bing Webmaster Tools' read (src/bing-webmaster.ts): the API key from Bing Webmaster Tools'
  // Settings, API access. Bing gives it no narrower scope, so the module calls only Get methods.
  // Unset, capsid_inspect_repo action bing reads nothing and says why.
  BING_WEBMASTER_API_KEY?: string;
  ASSETS?: Fetcher;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  BUILD_SHA?: string;
  // Root secret the job and policy signing key (src/signed-docs.ts) and the backup credential key
  // (src/signed-requests.ts) are derived from. Named for the improve loop that first used it;
  // renaming a Worker secret is a step only the seat can take.
  IMPROVE_SCORE_SECRET?: string;
  // The capsid-bench repo's signing key (src/bench.ts), the same value as its BENCH_KEY secret.
  BENCH_SECRET?: string;
  // The backup credential mint (src/signed-requests.ts): the temp-access-credentials token and the
  // parent it derives from. Omitted from RepoEnv.
  R2_TEMP_CRED_TOKEN?: string;
  R2_ACCOUNT_ID?: string;
  R2_BACKUP_PARENT_ACCESS_KEY_ID?: string;
  // Each site's operator token is a secret named by that site's configuration
  // (<NAME>_OPERATOR_TOKEN, src/site-operator.ts), read by name and never declared here.
  DCR_REDIRECT_URIS?: string;
  // The daily digest (src/digest.ts) sends only when EMAIL_ROUTING is "on". EMAIL, ALERT_FROM and
  // EMAIL_ROUTING come from the example (worker-configuration.d.ts) and are widened to optional
  // here, so the code keeps saying which is missing when one is not set.
  EMAIL?: SendEmail;
  EMAIL_ROUTING?: string;
  VAPID_PRIVATE_KEY?: string;
  ALERT_EMAIL?: string;
  ALERT_FROM?: string;
}

export type RepoEnv = Omit<
  Env,
  "R2_TEMP_CRED_TOKEN" | "R2_BACKUP_PARENT_ACCESS_KEY_ID" | "CF_OPS_TOKEN" | "VAPID_PRIVATE_KEY"
>;

export interface Props extends Record<string, unknown> {
  email: string;
  // When Access verified that email, in milliseconds since the epoch, set at /callback. The admin
  // server's step-up reads it (src/scope.ts STEP_UP): a risky admin action needs a sign-in this
  // recent. A grant made before it was recorded carries none and reads as stale.
  signed_in_at?: number;
}
