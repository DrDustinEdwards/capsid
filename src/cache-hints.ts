import type { CacheHint, ServerOptions } from "@modelcontextprotocol/server";

// Cache hints on the cacheable results of MCP 2026-07-28 (ttlMs and cacheScope on
// tools/list, prompts/list, resources/list, resources/templates/list, resources/read and
// server/discover). They are the SDK's own server option now, not a patch on its
// private handler map (job_a6ac3647bea3). The SDK fills them on 2026-era responses
// only; a 2025-era response never carries them, so the legacy shim's clients see the
// lists exactly as before.
//
// The tool list is the same for every caller: every tool is registered for every
// agent, and scope refuses at call time. So it is "public", as is server/discover,
// which describes the server and not the caller. Prompts and resources are filtered by
// the caller's namespaces, so theirs are "private".

export const LIST_TTL_MS = 60_000;

export const PUBLIC_LIST: CacheHint = { ttlMs: LIST_TTL_MS, cacheScope: "public" };
export const PRIVATE_LIST: CacheHint = { ttlMs: LIST_TTL_MS, cacheScope: "private" };

export const CACHE_HINTS: NonNullable<ServerOptions["cacheHints"]> = {
  "tools/list": PUBLIC_LIST,
  "server/discover": PUBLIC_LIST,
  "prompts/list": PRIVATE_LIST,
  "resources/list": PRIVATE_LIST,
  "resources/templates/list": PRIVATE_LIST,
  "resources/read": PRIVATE_LIST,
};
