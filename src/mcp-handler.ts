import type { McpServer } from "@modelcontextprotocol/server";
import { isLegacyRequest } from "@modelcontextprotocol/server";
import {
  checkRateLimit,
  MCP_PER_MINUTE,
  refuse,
  routeMcpEra,
} from "@dustinedwards/site-runtime/mcp-server";
import { recordAudit } from "@dustinedwards/site-runtime/audit-log";
import { createMcpHandler, type CreateMcpHandlerOptions } from "agents/mcp/server";
import type { Env } from "./env";
import { rateLimiter } from "./http";

// Origins: /mcp and /mcp/admin have their own Origin rule before the OAuth provider (src/index.ts,
// mcpOriginRefusal admitting https://claude.ai), so the wrapper's default list, which would refuse
// claude.ai, is not applied again there.
export const ADMIN_MCP_ROUTE = "/mcp/admin";

export { SCOPES } from "./scope";

export type McpRoute = "/mcp" | "/ops/mcp" | typeof ADMIN_MCP_ROUTE;

export async function serveMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  route: McpRoute,
  build: () => McpServer,
): Promise<Response> {
  const browserFacing = route === "/mcp" || route === ADMIN_MCP_ROUTE;
  const options: Omit<CreateMcpHandlerOptions, "legacy"> = browserFacing
    ? { route, allowedOriginHostnames: "*" }
    : { route };
  return routeMcpEra(request, env, ctx, {
    factory: () => build(),
    options,
    createMcpHandler,
    isLegacyRequest,
  });
}

// The door's rate limit on all four MCP routes, per caller (`access:<email>` for a session, the
// agent's actor for a key): site-runtime's 30 requests a minute on the RATE_LIMITER Durable
// Object, refusing when it cannot count. A refusal is logged as `rate-limited`, naming the server
// it was for.
export async function mcpRateLimited(
  env: Env,
  caller: string,
  server: { name: string; version: string },
): Promise<Response | null> {
  const verdict = await checkRateLimit(rateLimiter(env), caller);
  if (verdict.allowed) return null;
  await recordAudit(env, {
    callId: crypto.randomUUID(),
    phase: "rate-limited",
    caller,
    server: { name: server.name, version: server.version },
  });
  return refuse(
    `too many requests: at most ${MCP_PER_MINUTE} a minute per caller. Retry after ${verdict.retryAfter} seconds.`,
    429,
    { "retry-after": String(verdict.retryAfter) },
  );
}
