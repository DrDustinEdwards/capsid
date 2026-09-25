import { sha256Hex } from "./auth";
import {
  AGENT_GRANTS,
  AGENT_KINDS,
  SCOPE_FLAGS,
  defaultScopes,
  isAgentKind,
  mintAgentId,
  mintAgentKey,
  parseScopes,
  serializeScopes,
  type AgentGrant,
  type AgentKind,
  type AgentRow,
  type AgentScopes,
} from "./agents-schema";
import { auditStatement } from "./store-guards";

// The control plane for credentials: mint, list, revoke, re-scope. Admin only (see
// ADMIN_REASON in src/scope.ts): an agent that could mint another could widen itself.
//
// Separate from src/agents.ts, the resolver. The resolver runs on every request and
// reads; this runs when a human changes the credential inventory and writes. Keeping
// them apart lets the resolver stay a read.

export interface AgentResult {
  ok: boolean;
  action: string;
  agent?: PublicAgent;
  agents?: PublicAgent[];
  key?: string;
  note?: string;
  scopes?: AgentScopes;
  refusal?: string;
}

// What an agent looks like to a reader. The stored hash never appears, only its
// first twelve hex, the same shape as an operator-key fingerprint, so an agent can be
// matched against an audit row without handing out what it authenticates with.
export interface PublicAgent {
  id: string;
  name: string;
  kind: AgentKind;
  fingerprint: string;
  scopes: AgentScopes;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  last_seen: string | null;
}

function publicAgent(row: AgentRow): PublicAgent {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    fingerprint: row.key_hash.slice(0, 12),
    scopes: parseScopes(row.scopes),
    created_by: row.created_by,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
    last_seen: row.last_seen,
  };
}

function refuse(action: string, refusal: string): AgentResult {
  return { ok: false, action, refusal };
}

function agentAudit(db: D1Database, actor: string, action: string, name: string, params: Record<string, unknown>) {
  // An agent is not a document, so its name goes in the path slot under a fixed
  // "agents" namespace: one audit table rather than a second log nobody reads.
  return auditStatement(db, actor, action, "agents", name, params);
}

async function liveAgentByName(db: D1Database, name: string): Promise<AgentRow | null> {
  return db.prepare("SELECT * FROM agents WHERE name = ?1 AND revoked_at IS NULL").bind(name).first<AgentRow>();
}

export interface ScopeArgs {
  namespaces?: string[];
  repos?: string[];
  tools?: string[];
  grants?: string[];
  flags?: Record<string, unknown>;
}

// A list of exactly ["*"] is the wildcard; anything else is a list of names. Shared
// by mint and re-scope, because a disagreement would mean one of them silently
// narrowing a caller to a namespace literally named "*".
function scopeList(names: string[]): "*" | string[] {
  return names.length === 1 && names[0] === "*" ? "*" : [...names];
}

// Applies the narrowing asked for on top of a base. An omitted axis keeps its base
// value, so naming one flag does not clear the others, and a call naming none
// cannot widen anything.
function applyScopes(base: AgentScopes, args: ScopeArgs): AgentScopes {
  const scopes: AgentScopes = { ...base, flags: { ...base.flags } };
  if (args.namespaces) scopes.namespaces = scopeList(args.namespaces);
  if (args.repos) scopes.repos = scopeList(args.repos);
  if (args.tools) scopes.tools = scopeList(args.tools);
  if (args.grants) scopes.grants = args.grants.filter((g): g is AgentGrant => (AGENT_GRANTS as readonly string[]).includes(g));
  if (args.flags) {
    for (const flag of SCOPE_FLAGS) {
      if (Object.hasOwn(args.flags, flag)) scopes.flags[flag] = args.flags[flag] === true;
    }
  }
  return scopes;
}

// The repos axis a mint gets when the caller names none: every repo the named
// namespaces map. Starting from defaultScopes (repos "*") would give every agent
// minted through MCP every repo in the portfolio, while scripts/mint-agents.mjs
// derives a narrow list; two mint paths must agree about the default.
//
// Derived from the live namespaces mapping, the same table resolveRepo reads and the
// repos axis is compared against, so the two cannot drift apart.
//
// A namespace scope of "*" derives "*": enumerating today's mapping would silently
// exclude a namespace registered later. A namespace with no mapped repo refuses
// rather than falling back to the wildcard, as the script does.
async function reposForNamespaces(db: D1Database, namespaces: "*" | string[]): Promise<{ repos: "*" | string[] } | { error: string }> {
  if (namespaces === "*") return { repos: "*" };
  const repos: string[] = [];
  for (const namespace of namespaces) {
    const row = await db.prepare("SELECT repos FROM namespaces WHERE namespace = ?1").bind(namespace).first<{ repos: string }>();
    if (!row) {
      return {
        error:
          `namespace '${namespace}' is not registered, so the repos this agent may reach cannot be derived. ` +
          `Register it first, or pass repos explicitly.`,
      };
    }
    let list: unknown;
    try {
      list = JSON.parse(row.repos || "[]");
    } catch {
      return { error: `namespace '${namespace}' has a corrupt repos mapping. Repair it with update_namespace, or pass repos explicitly.` };
    }
    if (!Array.isArray(list) || list.length === 0) {
      return {
        error:
          `namespace '${namespace}' maps no repos, so an agent scoped to it would get the wildcard by default. ` +
          `Map its repos with update_namespace, or pass repos explicitly (pass the single entry * to mean every repo deliberately).`,
      };
    }
    for (const entry of list as Array<{ repo?: unknown }>) {
      if (typeof entry?.repo === "string" && entry.repo && !repos.includes(entry.repo)) repos.push(entry.repo);
    }
  }
  return { repos };
}

export async function mintAgent(db: D1Database, actor: string, args: ScopeArgs & { name: string; kind: string }): Promise<AgentResult> {
  const name = args.name.trim();
  if (!name) return refuse("mint", "an agent needs a name: it is the audit identity every row it writes carries.");
  if (!isAgentKind(args.kind)) {
    return refuse("mint", `'${args.kind}' is not an agent kind. One of: ${AGENT_KINDS.join(", ")}.`);
  }
  if (!args.namespaces || args.namespaces.length === 0) {
    return refuse(
      "mint",
      "mint needs at least one namespace. A new agent is scoped to the namespaces it was named for, so minting one with none creates a credential that reaches nothing and says nothing about what it was for. Pass the single entry * deliberately if every namespace is what you mean."
    );
  }
  // Names are never reused, revoked ones included, so the check is over every row.
  // An audit actor has to mean one credential forever, or the log cannot answer who
  // did something.
  const existing = await db.prepare("SELECT id FROM agents WHERE name = ?1").bind(name).first<{ id: string }>();
  if (existing) {
    return refuse("mint", `an agent named '${name}' already exists (${existing.id}). A name is an audit identity and is never reused, including after a revoke.`);
  }
  const named = scopeList(args.namespaces);
  // Derived only when the caller named none; an explicit list, "*" included, is kept.
  let derived: "*" | string[] | undefined;
  if (!args.repos) {
    const answer = await reposForNamespaces(db, named);
    if ("error" in answer) return refuse("mint", answer.error);
    derived = answer.repos;
  }
  const scopes = applyScopes(
    { ...defaultScopes([]), namespaces: named, ...(derived === undefined ? {} : { repos: derived }) },
    { ...args, namespaces: undefined }
  );
  // The key is returned once; only its sha256 is stored or logged.
  const key = mintAgentKey();
  const keyHash = await sha256Hex(key);
  const row: AgentRow = {
    id: mintAgentId(),
    name,
    kind: args.kind,
    key_hash: keyHash,
    scopes: serializeScopes(scopes),
    created_by: actor,
    created_at: new Date().toISOString(),
    revoked_at: null,
    last_seen: null,
  };
  await db.batch([
    db
      .prepare("INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(row.id, row.name, row.kind, row.key_hash, row.scopes, row.created_by, row.created_at),
    agentAudit(db, actor, "agent-minted", name, { id: row.id, kind: row.kind, key_fingerprint: keyHash.slice(0, 12), scopes }),
  ]);
  return {
    ok: true,
    action: "mint",
    agent: publicAgent(row),
    key,
    scopes,
    note: "This key is shown ONCE and is stored nowhere: the table holds its sha256. Save it now. If it is lost, revoke this agent and mint another.",
  };
}

export async function listAgents(db: D1Database): Promise<AgentResult> {
  // Revoked rows are included: a revoked credential is exactly what an inventory is
  // read for, and hiding it would make "revoked" and "never existed" look the same.
  const { results } = await db.prepare("SELECT * FROM agents ORDER BY created_at DESC, name").all<AgentRow>();
  return { ok: true, action: "list", agents: (results ?? []).map(publicAgent) };
}

export async function revokeAgent(db: D1Database, actor: string, name: string): Promise<AgentResult> {
  const row = await liveAgentByName(db, name);
  if (!row) return refuse("revoke", `no live agent named '${name}'. Call list to see the inventory, revoked ones included.`);
  // Keyed UPDATE with RETURNING: no row back means somebody else got there first,
  // and reporting success over that would be false.
  const won = await db
    .prepare("UPDATE agents SET revoked_at = datetime('now') WHERE id = ?1 AND revoked_at IS NULL RETURNING id")
    .bind(row.id)
    .first<{ id: string }>();
  if (!won) return refuse("revoke", `'${name}' was revoked by somebody else between reading it and revoking it.`);
  await db.batch([agentAudit(db, actor, "agent-revoked", name, { id: row.id, scopes: parseScopes(row.scopes) })]);
  return { ok: true, action: "revoke", agent: { ...publicAgent(row), revoked_at: new Date().toISOString() } };
}

export async function updateAgentScopes(db: D1Database, actor: string, name: string, args: ScopeArgs): Promise<AgentResult> {
  const row = await liveAgentByName(db, name);
  if (!row) return refuse("update_scopes", `no live agent named '${name}'. Call list to see the inventory, revoked ones included.`);
  const before = parseScopes(row.scopes);
  const scopes = applyScopes(before, args);
  const won = await db
    .prepare("UPDATE agents SET scopes = ?2 WHERE id = ?1 AND revoked_at IS NULL RETURNING id")
    .bind(row.id, serializeScopes(scopes))
    .first<{ id: string }>();
  if (!won) return refuse("update_scopes", `'${name}' was revoked between reading it and re-scoping it.`);
  // Both sides go in the audit row. The current scopes are answerable from the table;
  // what they were before, and who widened them, only from the row that changed them.
  await db.batch([agentAudit(db, actor, "agent-rescoped", name, { id: row.id, before, after: scopes })]);
  return { ok: true, action: "update_scopes", agent: { ...publicAgent(row), scopes }, scopes };
}
