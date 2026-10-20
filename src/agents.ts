import { bearerToken, operatorIdentity, sha256Hex } from "./auth";
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
import { logEvent } from "./log";

// A bearer resolves to a caller, not to a tier. A bare "read" or "write" plus a key
// fingerprint cannot say whose credential did something, and cannot give a queue
// driver a credential that works a job without also being able to merge a pull
// request into a repo that deploys on push.
//
// Four kinds of caller resolve here, and the order matters:
//
//   1. A minted agent (a row in `agents`), with exactly its row's scopes. Checked
//      first, so a key that is also an OPERATOR_KEY_HASH entry gets the narrower
//      authority.
//   2. A legacy operator key: a plain entry is write with every flag, an `ro:` entry
//      is read with none. This lets the table exist without breaking the credential
//      used to mint the first agent. It stops working when its hash is removed.
//   3. A bench run key (src/bench-run-key.ts): one treatment run of the paired
//      comparison, bound to its one job while the run is open.
//   4. The OAuth admin session, resolved in src/index.ts: the synthetic agent
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
  // agent; `opkey:<fingerprint>` for a legacy operator key; the admin as
  // `access:<email>` on the MCP login (Cloudflare Access, since 2026-09-27) or
  // `github:<login>` on rows the old console wrote before it moved to Access. Those are more specific than a
  // synthetic name, and every audit query already reads them.
  actor: string;
  scopes: AgentScopes;
  // May this caller mint, revoke and re-scope other agents? True only for the OAuth
  // admin and a legacy write key, so a minted agent can never mint a wider one than
  // itself. Not a flag, because update_scopes can set flags.
  admin: boolean;
  // A row-backed agent, as opposed to a synthetic one. What last_seen is written for.
  row: AgentRow | null;
  // When this OAuth session's Access sign-in happened (Props.signed_in_at), for the admin
  // server's step-up (src/scope.ts STEP_UP). Absent for a caller that holds a key rather
  // than a session; null for a session whose grant recorded no sign-in time, which is
  // stale.
  signedInAt?: number | null;
  // When this admin last completed a step-up action successfully, read from KV where the
  // session's agent is built and updated by the registrar (src/scope.ts STEP_UP). Absent
  // when there is none, or when KV could not say.
  lastStepUpAt?: number;
  // A bench run key's run and the one job it may work (null while no single job carries
  // the run's title). checkScope refuses it everything else (src/scope.ts).
  benchRun?: { run: string; job: string | null };
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

// The admin, as the MCP and Portal logins know it: the email Access verified, already
// checked against ADMIN_EMAIL and CO_OWNER_EMAILS at sign-in and on every request. A
// co-owner is this same agent under her own email, so her actor is `access:<her email>`
// and her step-up clock (src/scope.ts) is her own.
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


// An indexed equality on the digest, confirmed with a constant-time compare. The
// index keeps the lookup O(1) as the table grows; the compare keeps the guarantee if
// the query is ever loosened (a LIKE, a case fold, a fake in a test).
async function liveAgentByHash(db: D1Database, hash: string): Promise<AgentRow | null> {
  const row = await db
    .prepare("SELECT * FROM agents WHERE key_hash = ?1 AND revoked_at IS NULL")
    .bind(hash)
    .first<AgentRow>();
  if (!row) return null;
  return await safeEqual(row.key_hash, hash) ? row : null;
}

// A revoked agent does not fall through to OPERATOR_KEY_HASH: a key minted as an
// agent is not an operator key, and falling through would make revocation depend on
// the key never having matched anything else.
export async function resolveAgent(
  request: Request,
  env: { DB: D1Database; OPERATOR_KEY_HASH?: string },
  now: Date = new Date()
): Promise<ResolvedAgent | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await liveAgentByHash(env.DB, hash);
  if (row) {
    const agent = agentFromRow(row);
    return { agent, touch: () => touchLastSeen(env.DB, agent) };
  }
  const run = await runKeyAgent(env.DB, hash, now);
  if (run) return { agent: run, touch: async () => {} };
  // A revoked key is refused whether its row is still in agents or has moved to the
  // archive (src/agents-archive.ts): an archived key is a revoked key.
  const revoked = await env.DB.prepare(
    "SELECT id FROM agents WHERE key_hash = ?1 UNION ALL SELECT id FROM agents_archive WHERE key_hash = ?1"
  )
    .bind(hash)
    .first<{ id: string }>();
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
    logEvent("error", "AGENT_LAST_SEEN_FAILED", { message: `AGENT_LAST_SEEN_FAILED ${agent.id}: ${err instanceof Error ? err.message : String(err)}` });
  }
}
