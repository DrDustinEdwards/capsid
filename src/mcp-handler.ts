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
// Origins: /mcp has its own Origin rule before the OAuth provider
// (src/headers.ts mcpOriginProblem, which admits https://claude.ai), so the wrapper's
// default list, which would refuse claude.ai, is not applied there a second time.
// /ops/mcp is called by drivers with a bearer key and no browser, so it keeps the
// wrapper's default: a present Origin must be localhost-class or the workers.dev host.
export async function serveMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  route: "/mcp" | "/ops/mcp",
  build: () => McpServer
): Promise<Response> {
  const options: Omit<CreateMcpHandlerOptions, "legacy"> = route === "/mcp" ? { route, allowedOriginHostnames: "*" } : { route };
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
