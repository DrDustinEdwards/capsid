import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

// The bindings and vars wrangler.jsonc.example declares (DB, APP_KV, OAUTH_KV, MEDIA,
// HOLDOUT, GITHUB_APP_CLIENT_ID) come from worker-configuration.d.ts, which
// `npm run types` generates with `wrangler types` and test/env-types.test.ts holds to
// the example in both directions. What is written here is what the config cannot say:
// secrets, the OAuth provider the library injects, the optional assets binding, and the
// build stamps. HOLDOUT is generated, not declared here; AttemptEnv still omits it.
// GITHUB_APP_CLIENT_ID is generated as the literal pinned id; it is widened to string
// here so tests and the deploy check can hold other values.
export interface Env extends Omit<Cloudflare.Env, "GITHUB_APP_CLIENT_ID"> {
  OAUTH_PROVIDER: OAuthHelpers;
  OPERATOR_KEY_HASH: string;
  COOKIE_ENCRYPTION_KEY: string;
  // The MCP and Portal logins' upstream: Cloudflare Access for SaaS (OIDC),
  // src/access-login.ts. Unset, the sign-in is closed; ADMIN_EMAIL unset admits nobody.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_SAAS_CLIENT_ID?: string;
  ACCESS_SAAS_CLIENT_SECRET?: string;
  ADMIN_EMAIL?: string;
  // The Watch Floor's Cloudflare read (src/ops-cloudflare.ts): a read-only API token
  // with Account Analytics Read and Workers Scripts Read, and the account it reads.
  // Unset, the deploy and error columns show no data and say why.
  CF_OPS_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
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
  // HOLDOUT (the second R2 bucket) is withheld from AttemptEnv below. Only the
  // generated declaration and src/improve-scorer.ts may name it;
  // test/improve-holdout.test.ts refuses it in every other module.
  // Used only in improve_mode "api".
  ANTHROPIC_API_KEY?: string;
  // Root secret the per-namespace score-report HMAC keys are derived from.
  IMPROVE_SCORE_SECRET?: string;
  // Holdout mint only; omitted from AttemptEnv; only improve-scorer.ts may name the token.
  R2_TEMP_CRED_TOKEN?: string;
  R2_TEMP_CRED_PARENT_ACCESS_KEY_ID?: string;
  R2_ACCOUNT_ID?: string;
  // Backup mint parent, separate from the holdout parent. Omitted from AttemptEnv.
  R2_BACKUP_PARENT_ACCESS_KEY_ID?: string;
}

// Everything except the holdout bucket, the credentials that could mint read access to it,
// and the Cloudflare read token (it can read Worker code).
export type AttemptEnv = Omit<Env, "HOLDOUT" | "R2_TEMP_CRED_TOKEN" | "R2_TEMP_CRED_PARENT_ACCESS_KEY_ID" | "R2_BACKUP_PARENT_ACCESS_KEY_ID" | "CF_OPS_TOKEN">;

// A grant's props: the email Access verified at sign-in. Grants issued before the move
// to Access carry { id, login, name } from GitHub instead, fail the per-request email
// check, and the client signs in again once.
export interface Props extends Record<string, unknown> {
  email: string;
}
