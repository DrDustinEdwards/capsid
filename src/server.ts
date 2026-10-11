import { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "./env";
import { legacyAgent, type Agent } from "./agents";
import { checkScope, guardRegistrations } from "./scope";
import type { AdminWriteObserver } from "./admin-client-audit";
import { registerDocumentResources } from "./resources";
import { registerPrompts } from "./prompts";
import { CACHE_HINTS } from "./cache-hints";
import { defineDocOperations, type ToolCtx, type ToolGrant } from "./tools/docs";
import { defineLintOperations } from "./tools/lint";
import { defineRepoOperations } from "./tools/repo";
import { defineImproveOperations } from "./tools/improve";
import { defineJobOperations } from "./tools/jobs";
import { defineAgentOperations } from "./tools/agents";
import { defineClaimsOperations } from "./tools/claims";
import { defineOpsSnapshotOperations } from "./tools/ops";
import { defineCloudflareOperations } from "./tools/cloudflare";
import { defineControlOperations } from "./tools/controls";
import { defineAdminOperations } from "./tools/admin";
import { Operations } from "./tools/operations";
import { registerCapsidAdminTools, registerCapsidTools } from "./tools/surface";

export type { ToolGrant };

const SERVER_INFO = { name: "capsid", version: "1.0.0" };
const ADMIN_SERVER_INFO = { name: "capsid-admin", version: "1.0.0" };

// Warn, never refuse, when overwriting a document touched in the last hour without if_match.
const CONCURRENT_EDIT_WINDOW_MS = 60 * 60 * 1000;

export function concurrentEditWarning(updatedAt: string | null | undefined, now: number): string | null {
  if (!updatedAt) return null;
  // D1 stores datetime('now') in UTC with no zone, which Date.parse reads as local.
  // That would silence the warning on a machine behind UTC and fire it constantly on
  // one ahead.
  const parsed = Date.parse(`${updatedAt.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed)) return null;
  const age = now - parsed;
  if (age < 0 || age > CONCURRENT_EDIT_WINDOW_MS) return null;
  return (
    `possible concurrent edit: this document was last written at ${updatedAt} UTC, within the last hour, and no if_match was passed. ` +
    `The write went through and the prior body was snapshotted to document_versions, so nothing is lost, but if another session is working on this document your write may have just replaced its changes. ` +
    `Pass if_match (the sha256 this response returns) on the next write to make that a refusal instead of a warning.`
  );
}

// The caller is an agent (src/agents.ts). A bare grant plus an actor string means an
// unrestricted caller at that grant: the OPERATOR_KEY_HASH fallback, expressed once so
// there is no second code path where scopes do not apply.
export function buildServer(env: Env, caller: Agent | ToolGrant, actor = "", observeAdminWrite?: AdminWriteObserver): McpServer {
  return build(env, caller, actor, observeAdminWrite, "capsid");
}

// Capsid Admin (capsid/rulings/mcp-2026-10-10.md, amendment answer 2): the eight
// administrator tools, on their own route for the administrator alone
// (src/mcp-handler.ts). Every tool on it is admin only in TOOL_GRANTS too, so the route
// and the registrar refuse a non-admin twice.
export function buildAdminServer(env: Env, caller: Agent | ToolGrant, actor = "", observeAdminWrite?: AdminWriteObserver): McpServer {
  return build(env, caller, actor, observeAdminWrite, "admin");
}

function build(env: Env, caller: Agent | ToolGrant, actor: string, observeAdminWrite: AdminWriteObserver | undefined, surface: "capsid" | "admin"): McpServer {
  const agent = typeof caller === "string" ? legacyAgent(caller, actor) : caller;
  const server = new McpServer(surface === "admin" ? ADMIN_SERVER_INFO : SERVER_INFO, { cacheHints: CACHE_HINTS });
  const db = env.DB;

  // Provenance: the actor from a document's latest audit_log entry, surfaced by read
  // and brief so a session can tell who wrote what it treats as context: a document
  // another client wrote is untrusted input. A separate read rather than a joined
  // subquery, so the document read stays a named-column projection. Null when the
  // document has no audit history.
  const lastActor = async (ns: string, path: string): Promise<string | null> => {
    const row = await db
      .prepare("SELECT actor FROM audit_log WHERE namespace = ?1 AND path = ?2 ORDER BY id DESC LIMIT 1")
      .bind(ns, path)
      .first<{ actor: string | null }>();
    return row?.actor ?? null;
  };

  const ctx: ToolCtx = {
    env,
    db,
    actor: agent.actor,
    agent,
    // The handler half of the one enforcement point, for checks that need the action,
    // mode or path.
    scope: (need) => checkScope(agent, need),
    lastActor,
    ops: new Operations(),
  };

  // Every operation, on both servers: an operation is not served until a tool on this
  // server dispatches to it (src/tools/surface.ts).
  defineDocOperations(server, ctx);
  defineLintOperations(server, ctx);
  defineRepoOperations(server, ctx);
  defineImproveOperations(server, ctx);
  defineJobOperations(server, ctx);
  defineAgentOperations(server, ctx);
  defineClaimsOperations(server, ctx);
  defineOpsSnapshotOperations(server, ctx);
  defineCloudflareOperations(server, ctx);
  defineControlOperations(server, ctx);
  defineAdminOperations(server, ctx);

  // Before any registration, so every tool registered below is wrapped.
  guardRegistrations(server, agent, observeAdminWrite, env.APP_KV);

  if (surface === "admin") {
    registerCapsidAdminTools(server, ctx.ops);
    return server;
  }
  registerCapsidTools(server, ctx.ops);

  // Resources and prompts are raw request handlers, not tool registrations, so they
  // check scope themselves (src/resources.ts).
  registerDocumentResources(server, agent, db);
  registerPrompts(server, agent, db);

  return server;
}
