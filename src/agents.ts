import { operatorIdentity, sha256Hex, timingSafeEqual } from "./auth";
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

// A bearer resolves to a caller, not to a tier. A bare "read" or "write" plus a key
// fingerprint cannot say whose credential did something, and cannot give a queue
// driver a credential that works a job without also being able to merge a pull
// request into a repo that deploys on push.
//
// Three kinds of caller resolve here, and the order matters:
//
//   1. A minted agent (a row in `agents`), with exactly its row's scopes. Checked
//      first, so a key that is also an OPERATOR_KEY_HASH entry gets the narrower
//      authority.
//   2. A legacy operator key: a plain entry is write with every flag, an `ro:` entry
//      is read with none. This lets the table exist without breaking the credential
//      used to mint the first agent. It stops working when its hash is removed.
//   3. The OAuth admin session, resolved in src/index.ts: the synthetic agent
//      "admin", holding every scope.

export interface Agent {
  // The agents.id for a minted agent. For a synthetic one, its actor string, so a
  // caller identity is always addressable by a single value.
  id: string;
  // The audit NAME. "admin" for an OAuth session, "opkey" for a legacy key, and the
  // row's unique name for a minted agent.
  name: string;
  kind: AgentKind;
  // What lands in audit_log.actor and jobs.claimed_by. `agent:<name>` for a minted
  // agent; `github:<login>` and `opkey:<fingerprint>` for the two identities that
  // predate the table, because those are more specific than a synthetic name and
  // every audit query already reads them.
  actor: string;
  scopes: AgentScopes;
  // May this caller mint, revoke and re-scope other agents? True only for the OAuth
  // admin and a legacy write key, so a minted agent can never mint a wider one than
  // itself. Not a flag, because update_scopes can set flags.
  admin: boolean;
  // A row-backed agent, as opposed to a synthetic one. What last_seen is written for.
  row: AgentRow | null;
}

function flagsAll(value: boolean): Record<ScopeFlag, boolean> {
  const flags = {} as Record<ScopeFlag, boolean>;
  for (const flag of SCOPE_FLAGS) flags[flag] = value;
  return flags;
}

// Every namespace, repo, tool, grant and flag.
function unrestrictedScopes(): AgentScopes {
  return { namespaces: "*", repos: "*", tools: "*", grants: [...AGENT_GRANTS], flags: flagsAll(true) };
}

function readEverythingScopes(): AgentScopes {
  return { namespaces: "*", repos: "*", tools: "*", grants: ["read"], flags: flagsAll(false) };
}

// The OAuth admin session. The provider has already checked the login against
// ADMIN_GITHUB_LOGIN (once at consent, once per request), so this function grants
// rather than decides.
export function adminAgent(login: string): Agent {
  return {
    id: `github:${login}`,
    name: "admin",
    kind: "seat",
    actor: `github:${login}`,
    scopes: unrestrictedScopes(),
    admin: true,
    row: null,
  };
}

// A legacy grant and actor expressed as an Agent, so checkScope is the only
// enforcement path: the fallback path and every test build a caller the same way,
// and there is no second code path where scopes do not apply.
export function legacyAgent(grant: AgentGrant, actor: string): Agent {
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
  // last_seen, written best effort after the answer, so resolution stays a read and a
  // failed write cannot look like a failed auth.
  touch: () => Promise<void>;
}

function bearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

// An indexed equality on the digest, confirmed with a constant-time compare. The
// index keeps the lookup O(1) as the table grows; the compare keeps the guarantee if
// the query is ever loosened (a LIKE, a case fold, a fake in a test).
async function liveAgentByHash(db: D1Database, hash: string): Promise<AgentRow | null> {
  const row = await db
    .prepare("SELECT * FROM agents WHERE key_hash = ?1 AND revoked_at IS NULL")
    .bind(hash)
    .first<AgentRow>();
  if (!row) return null;
  return timingSafeEqual(row.key_hash, hash) ? row : null;
}

// A revoked agent does not fall through to OPERATOR_KEY_HASH: a key minted as an
// agent is not an operator key, and falling through would make revocation depend on
// the key never having matched anything else.
export async function resolveAgent(request: Request, env: { DB: D1Database; OPERATOR_KEY_HASH?: string }): Promise<ResolvedAgent | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await liveAgentByHash(env.DB, hash);
  if (row) {
    const agent = agentFromRow(row);
    return { agent, touch: () => touchLastSeen(env.DB, agent) };
  }
  const revoked = await env.DB.prepare("SELECT id FROM agents WHERE key_hash = ?1").bind(hash).first<{ id: string }>();
  if (revoked) return null;
  const { grant, fingerprint } = await operatorIdentity(request, env);
  if (!grant || !fingerprint) return null;
  return { agent: legacyAgent(grant, `opkey:${fingerprint}`), touch: async () => {} };
}

// Best effort: last_seen is how an unused credential is noticed, not how a request
// is authorized.
async function touchLastSeen(db: D1Database, agent: Agent): Promise<void> {
  if (!agent.row) return;
  try {
    await db.prepare("UPDATE agents SET last_seen = datetime('now') WHERE id = ?1").bind(agent.id).run();
  } catch (err) {
    console.error(`AGENT_LAST_SEEN_FAILED ${agent.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
