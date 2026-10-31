// Test-only entry for the authorization-server half of `npm run check:conformance`. NEVER
// DEPLOYED. It hands every request to the real Worker (src/index.ts: the host rules, the
// Origin check, the registration limit and the OAuth provider) and re-exports only the
// handler and the Durable Object classes, because wrangler dev refuses the cron constants
// src/index.ts also exports as entrypoints.

import worker from "../../src/index";

export { RateLimiter } from "@dustinedwards/site-runtime/rate-limit/durable-object";
export { ToolCallLog } from "@dustinedwards/site-runtime/audit-log";

export default { fetch: worker.fetch };
