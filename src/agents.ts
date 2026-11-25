import { bearerToken } from "@dustinedwards/site-runtime/agent-keys";
import { safeEqual } from "@dustinedwards/site-runtime/compare";
import {
  AGENT_GRANTS,
  SCOPE_FLAGS,
  agentActor,
  parseScopes,
  type AgentGrant,
  type AgentKind,
  type AgentRow,
  type AgentScopes,
  type ScopeFlag,
} from "./agents-schema";
import { runKeyAgent } from "./bench-run-key";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";

// A bearer resolves to a caller, not a tier: a bare "read" or "write" plus a key fingerprint
// cannot say whose credential did something, nor give a queue driver a credential that works a job
// without also being able to merge into a repo that deploys on push.

export interface Agent {
  // The agents.id for a minted agent. For a synthetic one, its actor string, so a caller identity is
  // always addressable by a single value.
  id: string;
  // The audit NAME. "admin" for an OAuth session, and the row's unique name for a minted agent.
  name: string;
  kind: AgentKind;
  // What lands in audit_log.actor and jobs.claimed_by. `agent:<name>` for a minted agent; the admin
  // as `access:<email>` on the MCP login (Cloudflare Access) or `github:<login>` on older rows.
  // Those are more specific than a synthetic name, and every audit query already reads them.
  actor: string;
  scopes: AgentScopes;
  // May this caller mint, revoke and re-scope other agents? True only for the OAuth admin, so a
  // minted agent can never mint a wider one than itself. Not a flag, because update_scopes can set
  // flags.
  admin: boolean;
  row: AgentRow | null;
  // When this OAuth session's Access sign-in happened (Props.signed_in_at), for the admin server's
  // step-up (src/scope.ts STEP_UP). Absent for a caller that holds a key rather than a session; null
  // for a session whose grant recorded no sign-in time, which is stale.
  signedInAt?: number | null;
  lastStepUpAt?: number;
  benchRun?: { run: string; job: string | null };
}

function flagsAll(value: boolean): Record<ScopeFlag, boolean> {
  const flags = {} as Record<ScopeFlag, boolean>;
  for (const flag of SCOPE_FLAGS) flags[flag] = value;
  return flags;
}

function unrestrictedScopes(): AgentScopes {
  return {
    namespaces: "*",
    repos: "*",
    tools: "*",
    grants: [...AGENT_GRANTS],
    flags: flagsAll(true),
  };
}

function readEverythingScopes(): AgentScopes {
  return { namespaces: "*", repos: "*", tools: "*", grants: ["read"], flags: flagsAll(false) };
}

export function adminAgentForEmail(email: string, signedInAt?: number | null): Agent {
  const actor = `access:${email}`;
  return {
    id: actor,
    name: "admin",
    kind: "seat",
    actor,
    scopes: unrestrictedScopes(),
    admin: true,
    row: null,
    ...(signedInAt === undefined ? {} : { signedInAt }),
  };
}

export function grantAgent(grant: AgentGrant, actor: string): Agent {
  return {
    id: actor,
    name: actor.includes(":") ? actor.slice(0, actor.indexOf(":")) : actor,
    kind: "session",
    actor,
    scopes: grant === "write" ? unrestrictedScopes() : readEverythingScopes(),
    admin: grant === "write",
    row: null,
  };
}

function agentFromRow(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    actor: agentActor(row.name),
    scopes: parseScopes(row.scopes),
    admin: false,
    row,
  };
}

export interface ResolvedAgent {
  agent: Agent;
  // last_seen, written best effort after the answer, so resolution stays a read and a failed write
  // cannot look like a failed auth.
  touch: () => Promise<void>;
}

async function liveAgentByHash(db: D1Database, hash: string): Promise<AgentRow | null> {
  const row = await db
    .prepare("SELECT * FROM agents WHERE key_hash = ?1 AND revoked_at IS NULL AND pending = 0")
    .bind(hash)
    .first<AgentRow>();
  if (!row) return null;
  return (await safeEqual(row.key_hash, hash)) ? row : null;
}

export async function resolveAgent(
  request: Request,
  env: { DB: D1Database },
  now: Date = new Date(),
): Promise<ResolvedAgent | null> {
  const token = bearerToken(request.headers.get("Authorization"));
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await liveAgentByHash(env.DB, hash);
  if (row) {
    const agent = agentFromRow(row);
    return { agent, touch: () => touchLastSeen(env.DB, agent) };
  }
  const run = await runKeyAgent(env.DB, hash, now);
  if (run) return { agent: run, touch: async () => {} };
  return null;
}

async function touchLastSeen(db: D1Database, agent: Agent): Promise<void> {
  if (!agent.row) return;
  try {
    await db
      .prepare("UPDATE agents SET last_seen = datetime('now') WHERE id = ?1")
      .bind(agent.id)
      .run();
  } catch (err) {
    logEvent(
      "AGENT_LAST_SEEN_FAILED",
      {
        message: `AGENT_LAST_SEEN_FAILED ${agent.id}: ${errorMessage(err)}`,
      },
      { level: "error" },
    );
  }
}
