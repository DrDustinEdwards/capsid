// Test-only entry for the auth half of `npm run check:conformance`, NEVER DEPLOYED: hands every request to the real Worker (src/index.ts) and re-exports only the handler
// and Durable Objects, because wrangler dev refuses the cron constants src/index.ts also exports as entrypoints.

import worker from "../../src/index";

export { RateLimiter } from "@dustinedwards/site-runtime/rate-limit/durable-object";
export { ToolCallLog } from "@dustinedwards/site-runtime/audit-log";

export default { fetch: worker.fetch };
