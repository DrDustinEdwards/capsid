import { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import type { Agent } from "../agents";
import { type ScopeNeed } from "../scope";
import type { Operations } from "./operations";
import {
  defineListOperation,
  defineReadOperation,
  defineBriefOperation,
  defineHistoryOperation,
  defineBacklinksOperation,
  defineFindOperation,
  defineSearchOperation,
} from "./docs-read";
import { defineWriteOperation } from "./docs-write";
import {
  defineDeleteOperation,
  defineMoveOperation,
  defineRestoreOperation,
} from "./docs-lifecycle";
import { defineNamespaceOperations } from "./namespaces";

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
  newPath: string | null,
): D1PreparedStatement[] {
  if (newPath === null) {
    return [
      db
        .prepare(
          "DELETE FROM document_links WHERE (from_ns = ?1 AND from_path = ?2) OR (to_ns = ?1 AND to_path = ?2)",
        )
        .bind(namespace, path),
      db.prepare("DELETE FROM documents WHERE namespace = ?1 AND path = ?2").bind(namespace, path),
    ];
  }
  return [
    db
      .prepare(
        "UPDATE documents SET path = ?3, updated_at = datetime('now') WHERE namespace = ?1 AND path = ?2",
      )
      .bind(namespace, path, newPath),
    db
      .prepare("UPDATE document_links SET from_path = ?3 WHERE from_ns = ?1 AND from_path = ?2")
      .bind(namespace, path, newPath),
    db
      .prepare("UPDATE document_links SET to_path = ?3 WHERE to_ns = ?1 AND to_path = ?2")
      .bind(namespace, path, newPath),
  ];
}

// Read before a mutation so the caller can record them: document_versions snapshots only title and
// body, so for a delete this is the only place the edges survive.
export function edgesTouching(
  db: D1Database,
  namespace: string,
  path: string,
): D1PreparedStatement {
  return db
    .prepare(
      "SELECT from_ns, from_path, type, to_ns, to_path FROM document_links WHERE (from_ns = ?1 AND from_path = ?2) OR (to_ns = ?1 AND to_path = ?2)",
    )
    .bind(namespace, path);
}
// PATH_MUTATION_HELPER_END

type ConfirmVerdict = "accepted" | "declined" | "unsupported";

// Stateless Streamable HTTP clients usually cannot answer elicitation, so "unsupported" is common
// and callers fall back to requiring confirm:true.
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
      { timeout: 90_000 },
    );
    return result.action === "accept" && result.content?.confirm === true ? "accepted" : "declined";
  } catch {
    return "unsupported";
  }
}

// Reports whether it actually elicited: an answer can arrive 90 seconds after the body it approved
// was read, so that consent goes stale like an if_match.
type ConfirmResult = { ok: true; elicited: boolean } | { ok: false; message: string };

export async function requireConfirmation(
  server: McpServer,
  confirm: boolean | undefined,
  messages: { prompt: string; declined: string; unsupported: string },
): Promise<ConfirmResult> {
  if (confirm === true) return { ok: true, elicited: false };
  const verdict = await confirmDestructive(server, messages.prompt);
  if (verdict === "accepted") return { ok: true, elicited: true };
  return { ok: false, message: verdict === "declined" ? messages.declined : messages.unsupported };
}

// The grant, not a boolean: `buildServer(env, true, ...)` misreads as "the operator server" when it
// means "may write", and a read-only ro: key is also an operator.
export type ToolGrant = "write" | "read";

export interface ToolCtx {
  env: Env;
  db: D1Database;
  // The principal on every audit_log row; older rows keep "github:<login>", "opkey:<fingerprint>"
  // or 'operator'.
  actor: string;
  client?: string;
  agent: Agent;
  // For what only the handler knows (an action tool's action, a repo mutation's flags); the
  // registrar has checked tool, grant, namespace and repo.
  scope: (need: ScopeNeed) => string | null;
  ops: Operations;
  lastActor: (ns: string, path: string) => Promise<string | null>;
  lastClient: (ns: string, path: string) => Promise<string | null>;
}

// Registered in this order, which is the order tools/list publishes.
export function defineDocOperations(server: McpServer, ctx: ToolCtx): void {
  defineListOperation(server, ctx);
  defineReadOperation(server, ctx);
  defineBriefOperation(server, ctx);
  defineWriteOperation(server, ctx);
  defineHistoryOperation(server, ctx);
  defineRestoreOperation(server, ctx);
  defineBacklinksOperation(server, ctx);
  defineDeleteOperation(server, ctx);
  defineMoveOperation(server, ctx);
  defineFindOperation(server, ctx);
  defineSearchOperation(server, ctx);
  defineNamespaceOperations(server, ctx);
}
