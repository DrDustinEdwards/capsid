// Test-only entry for `npm run check:conformance`, NEVER DEPLOYED (reached only positionally via `wrangler dev` with wrangler.conformance.jsonc). The suite cannot complete an OAuth sign-in, so this mounts the real
// protocol layer and tools with the token check replaced by a fixed read-grant caller over an empty D1; the auth half runs src/index.ts itself.

import { grantAgent } from "../../src/agents";
import type { Env } from "../../src/env";
import { serveMcp } from "../../src/mcp-handler";
import { buildServer } from "../../src/server";

export { RateLimiter } from "@dustinedwards/site-runtime/rate-limit/durable-object";
export { ToolCallLog } from "@dustinedwards/site-runtime/audit-log";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return serveMcp(request, env, ctx, "/mcp", () =>
      buildServer(env, grantAgent("read", "conformance")),
    );
  },
} satisfies ExportedHandler<Env>;
