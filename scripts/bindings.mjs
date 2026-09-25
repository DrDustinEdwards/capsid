// The pinned Cloudflare binding identities, in ONE place. scripts/ci-config.mjs asserts
// the deploy against them and scripts/reap-probe-clients.mjs deletes from the OAuth KV
// namespace, so two copies could drift and leave the reaper deleting from the wrong
// keyspace while reporting success (KV DELETE is idempotent).
//
// SIDE-EFFECT FREE, so it can be imported. ci-config.mjs cannot hold these: it runs at
// module scope.
//
// NO node_modules IMPORTS. reap-probe-clients.mjs runs in the live job, which skips npm
// ci on purpose so the gate still works when install is broken.
//
// These values are published in capsid/core.md and are inert without an API token: an
// assertion, not a credential.

// THE COMPATIBILITY DATE, same string as wrangler.jsonc.example's compatibility_date
// (test/cloudflare-platform.test.ts asserts they agree). nodejs_compat is default-on
// from 2026-08-04, so the explicit flag in the example is redundant but kept.
export const COMPATIBILITY_DATE = "2026-09-06";

// THE PER-INVOCATION CPU CEILING, same number as wrangler.jsonc.example's limits.cpu_ms
// (test/cloudflare-platform.test.ts asserts they agree). A runaway invocation is killed
// by the platform at this line, which is the one hard stop budget alerts cannot provide.
// Sized at the projected backup dump cost times 1.5; the derivation is in
// wrangler.jsonc.example.
export const LIMITS = { cpu_ms: 3500 };

export const D1 = { name: "capsid", id: "f24921c8-5e6f-499e-96a1-f124f52f12f7" };

// TWO KV NAMESPACES, each pinned and asserted independently.
//
// APP_KV holds ONLY the Worker's own state: the gh:install, gh:token and gh:get caches,
// the backup lease, and the dcr:rate counters. OAUTH_KV holds the provider's
// client/grant/token keys plus capsid:oauth-state.
//
// Resolution elsewhere is by EXACT TITLE and refuses ambiguity: the account also
// contains a namespace literally titled "OAUTH_KV" belonging to dustinedwards-mcp.
export const APP_KV = { name: "capsid-app-kv-v2", id: "21465e558b464cbf893753d2b2cb7829" };
export const OAUTH_KV = { name: "capsid-app-kv", id: "5fac20b95ad541a39f24eb8c5a753b6c" };

export const R2 = { name: "capsid-media" };

// A SECOND R2 BUCKET, holding the improve loop's hidden holdout suites. Separate from
// capsid-media rather than a prefix inside it: attempt-generating code holds MEDIA, and a
// distinct binding can be withheld structurally (src/env.ts's AttemptEnv). Only
// src/improve-scorer.ts may name it (test/improve-holdout.test.ts).
//
// CI reads the holdout tests from this bucket with its own read-only R2 token, a repo
// secret never in the Worker's environment. The Worker reads only the manifest.
export const HOLDOUT_R2 = { name: "capsid-improve-holdout" };

// Public identifier. It appears in every OAuth URL the App generates and in wrangler's
// own deploy output. Pinned because wrangler would otherwise write the example's
// placeholder over the live value: keep_vars preserves vars that are ABSENT from config,
// not ones present with a wrong value, and a placeholder client id would break every
// repo tool.
export const GITHUB_APP_CLIENT_ID = "Iv23lik2O8SPPksxbc6O";

// THE LIVE-GATE CANARY, a real OAuth client record that exists only to be read, so a
// lost client: record in OAUTH_KV is detected by verify-live gate 2b rather than by
// the owner's next failed connect.
//
// IT HAS NO EXPIRY, unlike every /register client (90 day clientRegistrationTTL): a
// canary that could expire would have a second legitimate reason to be absent. The gate
// asserts it stays non-expiring.
//
// Minted through the real POST /register path so the record shape is whatever the
// provider library writes, then rewritten byte-identically with the expiry removed:
//   wrangler kv key get "client:<id>" --namespace-id <OAUTH_KV> --remote --text > canary.json
//   wrangler kv key put "client:<id>" --namespace-id <OAUTH_KV> --remote --path canary.json
//
// The reaper cannot touch it: that script deletes only the id recorded in
// PROBE_CLIENT_FILE by gate 2 of the same run, and never lists the namespace.
export const CANARY_CLIENT = {
  id: "eZK0jwhRDvjSc_SN",
  name: "capsid live-gate canary (do not delete; asserted by verify-live gate 2b)",
};

