import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "../env";
import type { Agent } from "../agents";
import { type ScopeNeed } from "../scope";
import { registerListTool, registerReadTool, registerBriefTool, registerHistoryTool, registerBacklinksTool, registerFindTool, registerSearchTool } from "./docs-read";
import { registerWriteTool, registerRestoreTool, registerDeleteTool, registerMoveTool } from "./docs-write";
import { registerNamespaceTools } from "./namespaces";

export function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// PATH_MUTATION_HELPER_START
// The only site that mutates documents.path or deletes a documents row.
// document_links stores (ns, path) strings, no FK. newPath null means delete.
// Statement order is positional: rename [0] documents [1] from_path [2] to_path;
// delete [0] document_links [1] documents.
export function pathMutation(
  db: D1Database,
  namespace: string,
  path: string,
  newPath: string | null
): D1PreparedStatement[] {
  if (newPath === null) {
    return [
      db
        .prepare(
          "DELETE FROM document_links WHERE (from_ns = ?1 AND from_path = ?2) OR (to_ns = ?1 AND to_path = ?2)"
        )
        .bind(namespace, path),
      db.prepare("DELETE FROM documents WHERE namespace = ?1 AND path = ?2").bind(namespace, path),
    ];
  }
  return [
    db
      .prepare("UPDATE documents SET path = ?3, updated_at = datetime('now') WHERE namespace = ?1 AND path = ?2")
      .bind(namespace, path, newPath),
    db
      .prepare("UPDATE document_links SET from_path = ?3 WHERE from_ns = ?1 AND from_path = ?2")
      .bind(namespace, path, newPath),
    db
      .prepare("UPDATE document_links SET to_path = ?3 WHERE to_ns = ?1 AND to_path = ?2")
      .bind(namespace, path, newPath),
  ];
}

// Edges touching a document, read before a mutation so the caller can record
// them. document_versions snapshots only title and body, so for a delete this
// is the only place the edges survive.
export function edgesTouching(db: D1Database, namespace: string, path: string): D1PreparedStatement {
  return db
    .prepare(
      "SELECT from_ns, from_path, type, to_ns, to_path FROM document_links WHERE (from_ns = ?1 AND from_path = ?2) OR (to_ns = ?1 AND to_path = ?2)"
    )
    .bind(namespace, path);
}
// PATH_MUTATION_HELPER_END

type ConfirmVerdict = "accepted" | "declined" | "unsupported";

// Asks the connected client to confirm a destructive action via MCP elicitation.
// Stateless Streamable HTTP clients usually cannot answer server-initiated requests,
// so "unsupported" is the common case and callers fall back to requiring an explicit
// confirm:true argument.
async function confirmDestructive(server: McpServer, message: string): Promise<ConfirmVerdict> {
  if (!server.server.getClientCapabilities()?.elicitation) return "unsupported";
  try {
    const result = await server.server.elicitInput(
      {
        message,
        requestedSchema: {
          type: "object",
          properties: {
            confirm: { type: "boolean", title: "Confirm", description: "Set to true to proceed" },
          },
          required: ["confirm"],
        },
      },
      { timeout: 90_000 }
    );
    return result.action === "accept" && result.content?.confirm === true ? "accepted" : "declined";
  } catch {
    return "unsupported";
  }
}

// The confirmation step for every destructive tool. The messages stay per tool
// because they are the instruction the caller acts on.
//
// It reports whether it actually elicited. An elicited answer can arrive 90 seconds
// after the body it approved was read, so that consent goes stale like an if_match,
// and write and restore arm the commit-time body guard on it.
type ConfirmResult = { ok: true; elicited: boolean } | { ok: false; message: string };

export async function requireConfirmation(
  server: McpServer,
  confirm: boolean | undefined,
  messages: { prompt: string; declined: string; unsupported: string }
): Promise<ConfirmResult> {
  if (confirm === true) return { ok: true, elicited: false };
  const verdict = await confirmDestructive(server, messages.prompt);
  if (verdict === "accepted") return { ok: true, elicited: true };
  return { ok: false, message: verdict === "declined" ? messages.declined : messages.unsupported };
}

// The grant, not a boolean. A boolean misread at every call site:
// `buildServer(env, true, ...)` looks like "this is the operator server" when it
// means "this grant may write", and a read-only ro: key is also an operator.
// src/auth.ts resolves a key to exactly this union.
export type ToolGrant = "write" | "read";

export interface ToolCtx {
  env: Env;
  db: D1Database;
  // The principal recorded on every audit_log row: "github:<login>" for an OAuth
  // session, "opkey:<fingerprint>" for an operator key, "agent:<name>" for a minted
  // agent (src/agents.ts). The fingerprint is a 12-char prefix of the key's sha256,
  // because OPERATOR_KEY_HASH is the verifier and a full hash in audit_log would copy
  // it into the database. Older rows keep a literal 'operator' value.
  actor: string;
  // The caller, resolved once per request (src/agents.ts). `actor` is a projection of
  // it; the scope checks read this.
  agent: Agent;
  // checkScope bound to this caller (src/scope.ts): a refusal naming the missing
  // scope, or null. The registrar has already checked the tool, grant, namespace and
  // repo; this is for what only the handler knows: an action tool's action, and the
  // flags a repo mutation needs.
  scope: (need: ScopeNeed) => string | null;
  lastActor: (ns: string, path: string) => Promise<string | null>;
}

// Registered in this order, which is the order tools/list publishes.
export function registerDocTools(server: McpServer, ctx: ToolCtx): void {
  registerListTool(server, ctx);
  registerReadTool(server, ctx);
  registerBriefTool(server, ctx);
  registerWriteTool(server, ctx);
  registerHistoryTool(server, ctx);
  registerRestoreTool(server, ctx);
  registerBacklinksTool(server, ctx);
  registerDeleteTool(server, ctx);
  registerMoveTool(server, ctx);
  registerFindTool(server, ctx);
  registerSearchTool(server, ctx);
  registerNamespaceTools(server, ctx);
}
