import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Cache hints on list results: the top-level ttlMs and cacheScope fields of MCP
// 2026-07-28's CacheableResult. The SDK here negotiates 2025-11-25, where both are
// extra fields a client may ignore, so they are forward-looking (docs/auth.md, "Tool
// hints and list caching"). ResultSchema is a loose object, so they pass through.
//
// The tool list is the same for every caller: every tool is registered for every
// agent, and scope refuses at call time. So it is "public". Prompts and resources are
// filtered by the caller's namespaces, so theirs are "private".

export const LIST_TTL_MS = 60_000;

export interface CacheHints {
  ttlMs: number;
  cacheScope: "public" | "private";
}

export const PUBLIC_LIST: CacheHints = { ttlMs: LIST_TTL_MS, cacheScope: "public" };
export const PRIVATE_LIST: CacheHints = { ttlMs: LIST_TTL_MS, cacheScope: "private" };

// The handlers McpServer installs itself. prompts/list and resources/list are
// capsid's own handlers (src/prompts.ts, src/resources.ts) and carry PRIVATE_LIST
// where their results are built, so nothing is wrapped twice.
const SDK_HANDLERS: Record<string, CacheHints> = {
  "tools/list": PUBLIC_LIST,
  "resources/templates/list": PRIVATE_LIST,
  "resources/read": PRIVATE_LIST,
};

type StoredHandler = (request: unknown, extra: unknown) => Promise<unknown>;

// Call after every registration: McpServer installs its handlers on the first
// registerTool and registerResource, and never again. The original handler runs and
// its result is decorated, so the JSON Schema conversion stays the SDK's.
//
// Protocol keeps its handlers in a private map, and setRequestHandler would re-parse
// the request a second time, so the entry is replaced in the map directly. If the SDK
// ever stops keeping that map, or a handler is missing, this throws rather than
// serving a list without its hints (CLAUDE.md, no swallowed error).
export function decorateCacheHints(server: McpServer): void {
  const handlers = (server.server as unknown as { _requestHandlers?: unknown })._requestHandlers;
  if (!(handlers instanceof Map)) {
    throw new Error("cache hints: the SDK's request handler map was not found, so list results cannot carry ttlMs and cacheScope");
  }
  for (const [method, hints] of Object.entries(SDK_HANDLERS)) {
    const original = handlers.get(method) as StoredHandler | undefined;
    if (typeof original !== "function") {
      throw new Error(`cache hints: no ${method} handler to decorate; decorateCacheHints runs after every registration`);
    }
    handlers.set(method, async (request: unknown, extra: unknown) => ({
      ...((await original(request, extra)) as Record<string, unknown>),
      ...hints,
    }));
  }
}
