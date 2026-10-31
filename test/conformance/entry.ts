// Test-only entry for `npm run check:conformance` (devkit-conformance, .conformance.json).
// NEVER DEPLOYED: the deploy target is src/index.ts, and this file is reached only by
// passing it positionally to `wrangler dev` with test/conformance/wrangler.conformance.jsonc.
//
// The official suite cannot complete an OAuth sign-in, so this mounts the REAL protocol
// layer (src/mcp-handler.ts serveMcp) and the REAL tools (src/server.ts buildServer) with
// the door's token check replaced by a fixed caller that holds the read grant alone, over
// an empty local D1, so a write is refused and a read answers empty. The door is certified
// separately: the auth half runs src/index.ts itself.

import { legacyAgent } from "../../src/agents";
import type { Env } from "../../src/env";
import { serveMcp } from "../../src/mcp-handler";
import { buildServer } from "../../src/server";

export { RateLimiter } from "@dustinedwards/site-runtime/rate-limit/durable-object";
export { ToolCallLog } from "@dustinedwards/site-runtime/audit-log";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return serveMcp(request, env, ctx, "/mcp", () => buildServer(env, legacyAgent("read", "conformance")));
  },
} satisfies ExportedHandler<Env>;
