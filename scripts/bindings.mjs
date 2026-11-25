// Pinned Cloudflare binding identities, in one place: ci-config.mjs asserts the deploy against them and verify-live gate 2b reads the OAuth KV namespace, so two copies could drift.
// Side-effect free (ci-config.mjs runs at module scope) and no node_modules imports (the live job skips npm ci). Inert without an API token: an assertion, not a credential.

// Same string as wrangler.jsonc.example's compatibility_date (test/cloudflare-platform.test.ts asserts it).
// nodejs_compat is default-on from 2026-08-04; the example's explicit flag is redundant but kept.
export const COMPATIBILITY_DATE = "2026-09-06";

// Per-invocation CPU ceiling, same as the example's limits.cpu_ms (test/cloudflare-platform.test.ts asserts it).
// The one hard stop budget alerts cannot provide; the derivation is in wrangler.jsonc.example.
export const LIMITS = { cpu_ms: 10000 };

export const D1 = { name: "capsid", id: "f24921c8-5e6f-499e-96a1-f124f52f12f7" };

// The MCP login's Access for SaaS app (docs/auth.md); gate 5 asserts approval redirects here.
// Neither value is secret; the client secret is a Worker secret.
export const ACCESS_SAAS = {
  teamDomain: "https://dustinedwards.cloudflareaccess.com",
  clientId: "b7122cf1f57ab7e092476f63dfc895bb98101499c8b9799d6ed9f4a43202111b",
};

// Two KV namespaces, each pinned and asserted independently. APP_KV holds the Worker's own state (gh caches, backup lease);
// OAUTH_KV holds the provider's keys, capsid:oauth-state and registrationLimited's counters.
// Resolved elsewhere by exact title, refusing ambiguity: the account also has an unrelated "OAUTH_KV" (dustinedwards-mcp).
export const APP_KV = { name: "capsid-app-kv-v2", id: "21465e558b464cbf893753d2b2cb7829" };
export const OAUTH_KV = { name: "capsid-mcp-oauth", id: "5fac20b95ad541a39f24eb8c5a753b6c" };

export const R2 = { name: "capsid-media" };

// Public identifier. Pinned because keep_vars preserves absent vars, not ones present with a wrong value,
// so the example's placeholder would overwrite the live client id and break every repo tool.
export const GITHUB_APP_CLIENT_ID = "Iv23lik2O8SPPksxbc6O";

// Live-gate canary: a real OAuth client record that exists only to be read, so gate 2b detects a lost client: record.
// It has no expiry (DCR clients get 90 days), so it has no second reason to be absent; the gate asserts that.
// Minted through POST /register, then rewritten without the expiry:
//   wrangler kv key get "client:<id>" --namespace-id <OAUTH_KV> --remote --text > canary.json
//   wrangler kv key put "client:<id>" --namespace-id <OAUTH_KV> --remote --path canary.json
// /register now admits only the Grok, Gemini and ChatGPT callbacks, so a lost canary is restored from an OAUTH_KV backup or a saved canary.json with the put.
export const CANARY_CLIENT = {
  id: "eZK0jwhRDvjSc_SN",
  name: "capsid live-gate canary (do not delete; asserted by verify-live gate 2b)",
};
