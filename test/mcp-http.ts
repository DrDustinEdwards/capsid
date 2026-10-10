import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { serveMcp } from "../src/mcp-handler.ts";

// A client that reaches a built server through src/mcp-handler.ts, over HTTP, in the
// era it names. An in-memory pair always speaks 2025-11-25; the 2026-07-28 era (and its
// cache hints) is served only by the HTTP handler, so a test of either era goes here.

export const MODERN = "2026-07-28";
export const LEGACY = "2025-11-25";

const fakeCtx = () => ({ waitUntil() {}, passThroughOnException() {}, props: {} }) as unknown as ExecutionContext;

export function mcpFetch(env: never, build: () => McpServer, route: "/mcp" | "/ops/mcp" = "/ops/mcp") {
  return (input: string | URL | Request, init?: RequestInit) => serveMcp(new Request(input, init), env, fakeCtx(), route, build);
}

export async function httpClient(env: never, build: () => McpServer, era: typeof MODERN | typeof LEGACY, route: "/mcp" | "/ops/mcp" = "/ops/mcp") {
  const client = new Client({ name: "mcp-http", version: "1.0.0" }, { versionNegotiation: { mode: era === MODERN ? { pin: MODERN } : "legacy" } });
  const transport = new StreamableHTTPClientTransport(new URL(`https://mcp.example.com${route}`), { fetch: mcpFetch(env, build, route) as typeof fetch });
  await client.connect(transport);
  return client;
}
