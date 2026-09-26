import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./env";
import { legacyAgent, type Agent } from "./agents";
import { checkScope, guardRegistrations } from "./scope";
import { registerDocumentResources } from "./resources";
import { registerPrompts } from "./prompts";
import { registerDocTools, type ToolCtx, type ToolGrant } from "./tools/docs";
import { registerLintTools } from "./tools/lint";
import { registerRepoTools } from "./tools/repo";
import { registerImproveTools } from "./tools/improve";
import { registerJobTools } from "./tools/jobs";
import { registerAgentTools } from "./tools/agents";

export type { ToolGrant };

const SERVER_INFO = { name: "capsid", version: "1.0.0" };

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
export function buildServer(env: Env, caller: Agent | ToolGrant, actor = ""): McpServer {
  const agent = typeof caller === "string" ? legacyAgent(caller, actor) : caller;
  const server = new McpServer(SERVER_INFO);
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
  };

  // Before any registration, so every tool registered below is wrapped.
  guardRegistrations(server, agent);

  registerDocTools(server, ctx);
  registerLintTools(server, ctx);
  registerRepoTools(server, ctx);
  registerImproveTools(server, ctx);
  registerJobTools(server, ctx);
  registerAgentTools(server, ctx);

  // Resources and prompts are raw request handlers, not tool registrations, so they
  // check scope themselves (src/resources.ts).
  registerDocumentResources(server, agent, db);
  registerPrompts(server, agent, db);

  return server;
}
