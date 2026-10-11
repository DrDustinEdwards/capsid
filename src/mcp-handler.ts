import type { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, type CreateMcpHandlerOptions } from "agents/mcp/server";
import type { Env } from "./env";
import { createLegacyEraHandler, isLegacyRequest } from "./legacy-era";

// Capsid's two MCP endpoints (/mcp for the admin login, /ops/mcp for driver keys) on
// MCP 2026-07-28 through @modelcontextprotocol/server 2 and agents, stateless: no
// session is kept between requests, and a fresh server answers each one. The caller is
// resolved before this runs and closed over by the factory, never read from the
// request.
//
// Origins: /mcp and /mcp/admin have their own Origin rule before the OAuth provider
// (src/headers.ts mcpOriginProblem, which admits https://claude.ai), so the wrapper's
// default list, which would refuse claude.ai, is not applied there a second time.
// /ops/mcp and /ops/mcp/admin are called with a bearer key and no browser, so they keep
// the wrapper's default: a present Origin must be localhost-class or the workers.dev host.
// Capsid Admin's routes: the administrator's OAuth session, and an admin key for the
// seat's scripts (src/routes.ts).
export const ADMIN_MCP_ROUTE = "/mcp/admin";
export const ADMIN_OPS_MCP_ROUTE = "/ops/mcp/admin";

export type McpRoute = "/mcp" | "/ops/mcp" | typeof ADMIN_MCP_ROUTE | typeof ADMIN_OPS_MCP_ROUTE;

export async function serveMcp(request: Request, env: Env, ctx: ExecutionContext, route: McpRoute, build: () => McpServer): Promise<Response> {
  const browserFacing = route === "/mcp" || route === ADMIN_MCP_ROUTE;
  const options: Omit<CreateMcpHandlerOptions, "legacy"> = browserFacing ? { route, allowedOriginHostnames: "*" } : { route };
  const factory = () => build();

  // --- the one legacy call site, deletable with src/legacy-era.ts ---------
  // The predicate reads the body, so it gets a clone: the handler needs the body too.
  if (await isLegacyRequest(request.clone() as Request<unknown>)) {
    return createLegacyEraHandler(factory, options)(request, env, ctx);
  }
  // -------------------------------------------------------------------------

  // Everything the predicate calls false goes here, including malformed envelopes: the
  // library's documentation says the modern path owns those error answers.
  return createMcpHandler(factory, { ...options, legacy: "reject" })(request, env, ctx);
}
