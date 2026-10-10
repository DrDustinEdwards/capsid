// THE PRIOR-ERA SHIM. One module, one call site in src/mcp-handler.ts, deletable as a
// unit. The pattern is Carrel's (app/lib/mcp/legacy-era.ts), copied from
// dustinedwards-mcp, where it was measured.
//
// ============================================================================
// REMOVAL CONDITION
// ============================================================================
// Delete this file, its single call site in src/mcp-handler.ts, and 2025-11-25 from ERAS in
// scripts/mcp-probe-lib.mjs (live gate 8 calls both eras) when the probe in
// dustinedwards-mcp (`node scripts/probe-report.mjs`) shows the clients that reach
// Capsid opening with `server/discover` instead of `initialize`. Capsid's own
// admin_client_audit rows (src/admin-client-audit.ts) record the protocol version the
// admin's client sends and are a second reading.
//
// Targets and their last measurement (in dustinedwards-mcp; Capsid has no probe of its
// own):
//   Claude Code 2.1.203   2026-07-29   LEGACY (initialize, 2025-11-25)
//   claude.ai (Anthropic) 2026-07-30   LEGACY (initialize, 2025-11-25)
//
// Do NOT delete it on the strength of a release note or an announcement that a client
// "supports" the new revision. Re-run the probe and delete it on the capture.
// ============================================================================
//
// WHY IT EXISTS. MCP 2026-07-28 removed the `initialize` handshake, sessions and the GET
// stream. The primary handler is built `legacy: "reject"`, stateless and modern-only. A
// legacy client against a modern-only server fails with no fall-forward, and every
// driver and connector measured is legacy, so this shim is load-bearing today.
//
// WHY IT IS SHAPED THIS WAY. `createMcpHandler` could serve both eras from one handler
// with `legacy: "stateless"`, but then the compatibility path would live inside the
// library behind a flag. Routing in front of a `legacy: "reject"` handler, as the
// library documents on `isLegacyRequest`, makes the seam real: deleting this file
// leaves a modern-only server.

import { isLegacyRequest } from "@modelcontextprotocol/server";
import { createMcpHandler, type CreateMcpHandlerOptions, type StatelessMcpHandler } from "agents/mcp/server";

/** The single predicate this module exports for the routing decision. */
export { isLegacyRequest };

/**
 * The prior-era handler: each legacy request is answered by a fresh server from the
 * same factory, and 2025-era session operations (GET and DELETE) are answered 405, as
 * the modern handler does.
 */
export function createLegacyEraHandler(
  factory: Parameters<typeof createMcpHandler>[0],
  options: Omit<CreateMcpHandlerOptions, "legacy">
): StatelessMcpHandler {
  return createMcpHandler(factory, { ...options, legacy: "stateless" });
}
