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
import { parseMappedRepos } from "./github/client";
import { auditStatement, clientOf } from "./store-guards";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";

// Control plane for credentials, admin only (ADMIN_REASON in src/scope.ts): an agent that could mint
// another could widen itself. Kept apart from the resolver (src/agents.ts) so that stays a read.

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

// The stored hash never appears, only its first twelve hex: enough to match an audit row.
interface PublicAgent {
  id: string;
  name: string;
  kind: AgentKind;
  fingerprint: string;
  scopes: AgentScopes;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  last_seen: string | null;
  pending: boolean;
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
    pending: row.pending === 1,
  };
}

function refuse(action: string, refusal: string): AgentResult {
  return { ok: false, action, refusal };
}

function agentAudit(
  db: D1Database,
  actor: string,
  action: string,
  name: string,
  params: Record<string, unknown>,
) {
  // The name goes in the path slot under a fixed "agents" namespace: one audit table, no second log.
  return auditStatement(db, actor, action, "agents", name, params);
}

// State change and audit row in one batch. Both write only while the agent still matches `guard`;
// false means it changed after the caller read it and neither wrote.
async function changeWithAudit(
  db: D1Database,
  actor: string,
  action: string,
  row: { id: string; name: string },
  params: Record<string, unknown>,
  set: string,
  guard: string,
  extra?: string,
): Promise<boolean> {
  const audit = db
    .prepare(
      `INSERT INTO audit_log (actor, action, namespace, path, params, client)
       SELECT ?1, ?2, 'agents', ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM agents WHERE id = ?6 AND ${guard})`,
    )
    .bind(
      actor,
      action,
      row.name,
      JSON.stringify(params),
      clientOf(actor, params, undefined),
      row.id,
    );
  const update = db
    .prepare(`UPDATE agents SET ${set} WHERE id = ?1 AND ${guard} RETURNING id`)
    .bind(...(extra === undefined ? [row.id] : [row.id, extra]));
  const [, changed] = await db.batch([audit, update]);
  return (changed?.results?.length ?? 0) > 0;
}

async function liveAgentByName(db: D1Database, name: string): Promise<AgentRow | null> {
  return db
    .prepare("SELECT * FROM agents WHERE name = ?1 AND revoked_at IS NULL")
    .bind(name)
    .first<AgentRow>();
}

export interface ScopeArgs {
  namespaces?: string[];
  repos?: string[];
  tools?: string[];
  grants?: string[];
  flags?: Record<string, unknown>;
}

// Exactly ["*"] is the wildcard. Shared by mint and re-scope so neither narrows a caller to a namespace named "*".
function scopeList(names: string[]): "*" | string[] {
  return names.length === 1 && names[0] === "*" ? "*" : [...names];
}

// An omitted axis keeps its base, so naming one flag does not clear the others and nothing can widen.
function applyScopes(base: AgentScopes, args: ScopeArgs): AgentScopes {
  const scopes: AgentScopes = { ...base, flags: { ...base.flags } };
  if (args.namespaces) scopes.namespaces = scopeList(args.namespaces);
  if (args.repos) scopes.repos = scopeList(args.repos);
  if (args.tools) scopes.tools = scopeList(args.tools);
  if (args.grants)
    scopes.grants = args.grants.filter((g): g is AgentGrant =>
      (AGENT_GRANTS as readonly string[]).includes(g),
    );
  if (args.flags) {
    for (const flag of SCOPE_FLAGS) {
      if (Object.hasOwn(args.flags, flag)) scopes.flags[flag] = args.flags[flag] === true;
    }
  }
  return scopes;
}

// Default repos for a mint: every repo the named namespaces map (defaultScopes' "*" would give every agent every
// repo), derived from the live mapping. A "*" namespace derives "*"; one with no mapped repo refuses.
async function reposForNamespaces(
  db: D1Database,
  namespaces: "*" | string[],
): Promise<{ repos: "*" | string[] } | { error: string }> {
  if (namespaces === "*") return { repos: "*" };
  const repos: string[] = [];
  for (const namespace of namespaces) {
    const row = await db
      .prepare("SELECT repos FROM namespaces WHERE namespace = ?1")
      .bind(namespace)
      .first<{ repos: string }>();
    if (!row) {
      return {
        error:
          `namespace '${namespace}' is not registered, so the repos this agent may reach cannot be derived. ` +
          `Register it first, or pass repos explicitly.`,
      };
    }
    const parsed = parseMappedRepos(row.repos);
    if ("error" in parsed) {
      return {
        error: `namespace '${namespace}' has a corrupt repos mapping (${parsed.error}). Repair it with capsid_admin_manage_namespaces action update, or pass repos explicitly.`,
      };
    }
    if (parsed.list.length === 0) {
      return {
        error:
          `namespace '${namespace}' maps no repos, so an agent scoped to it would get the wildcard by default. ` +
          `Map its repos with capsid_admin_manage_namespaces action update, or pass repos explicitly (pass the single entry * to mean every repo deliberately).`,
      };
    }
    for (const { repo } of parsed.list) if (!repos.includes(repo)) repos.push(repo);
  }
  return { repos };
}

export async function mintAgent(
  db: D1Database,
  actor: string,
  args: ScopeArgs & { name: string; kind: string },
): Promise<AgentResult> {
  const name = args.name.trim();
  if (!name)
    return refuse(
      "mint",
      "an agent needs a name: it is the audit identity every row it writes carries.",
    );
  if (!isAgentKind(args.kind)) {
    return refuse(
      "mint",
      `'${args.kind}' is not an agent kind. One of: ${AGENT_KINDS.join(", ")}.`,
    );
  }
  if (!args.namespaces || args.namespaces.length === 0) {
    return refuse(
      "mint",
      "mint needs at least one namespace. A new agent is scoped to the namespaces it was named for, so minting one with none creates a credential that reaches nothing and says nothing about what it was for. Pass the single entry * deliberately if every namespace is what you mean.",
    );
  }
  // Names are never reused, revoked and archived included: an audit actor must mean one credential forever.
  const existing = await db
    .prepare("SELECT id FROM agents WHERE name = ?1")
    .bind(name)
    .first<{ id: string }>();
  if (existing) {
    return refuse(
      "mint",
      `an agent named '${name}' already exists (${existing.id}). A name is an audit identity and is never reused, including after a revoke.`,
    );
  }
  const named = scopeList(args.namespaces);
  let derived: "*" | string[] | undefined;
  if (!args.repos) {
    const answer = await reposForNamespaces(db, named);
    if ("error" in answer) return refuse("mint", answer.error);
    derived = answer.repos;
  }
  const scopes = applyScopes(
    {
      ...defaultScopes([]),
      namespaces: named,
      ...(derived === undefined ? {} : { repos: derived }),
    },
    { ...args, namespaces: undefined },
  );
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
    pending: 1,
  };
  await db.batch([
    db
      .prepare(
        "INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at, pending) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)",
      )
      .bind(row.id, row.name, row.kind, row.key_hash, row.scopes, row.created_by, row.created_at),
    agentAudit(db, actor, "agent-minted", name, {
      id: row.id,
      kind: row.kind,
      key_fingerprint: keyHash.slice(0, 12),
      scopes,
    }),
  ]);
  return {
    ok: true,
    action: "mint",
    agent: publicAgent(row),
    key,
    scopes,
    note: "This key is shown ONCE and is stored nowhere: the table holds its sha256. Save it now. If it is lost, revoke this agent and mint another. It resolves nothing until Dustin clicks Activate on the agent in the Portal (https://portal.dustinedwards.info, Agents), so a mint a session was talked into reaches nothing.",
  };
}

export async function listAgents(db: D1Database): Promise<AgentResult> {
  // Revoked rows are included until the watcher archives them: hiding them would make "revoked" and "never existed" look the same.
  const { results } = await db
    .prepare("SELECT * FROM agents WHERE archived_at IS NULL ORDER BY created_at DESC, name")
    .all<AgentRow>();
  return { ok: true, action: "list", agents: (results ?? []).map(publicAgent) };
}

export async function revokeAgent(
  db: D1Database,
  actor: string,
  name: string,
): Promise<AgentResult> {
  const row = await liveAgentByName(db, name);
  if (!row)
    return refuse(
      "revoke",
      `no live agent named '${name}'. Call action list to see the inventory, revoked ones included.`,
    );
  // The UPDATE returns the row, so a lost race is reported, never success.
  const won = await changeWithAudit(
    db,
    actor,
    "agent-revoked",
    row,
    { id: row.id, scopes: parseScopes(row.scopes) },
    "revoked_at = datetime('now')",
    "revoked_at IS NULL",
  );
  if (!won)
    return refuse(
      "revoke",
      `'${name}' was revoked by somebody else between reading it and revoking it.`,
    );
  return {
    ok: true,
    action: "revoke",
    agent: { ...publicAgent(row), revoked_at: new Date().toISOString() },
  };
}

export async function activateAgent(
  db: D1Database,
  actor: string,
  name: string,
): Promise<AgentResult> {
  const won = await db
    .prepare("SELECT * FROM agents WHERE name = ?1 AND revoked_at IS NULL AND pending = 1")
    .bind(name)
    .first<AgentRow>();
  const activated =
    won &&
    (await changeWithAudit(
      db,
      actor,
      "agent-activated",
      won,
      { id: won.id },
      "pending = 0",
      "revoked_at IS NULL AND pending = 1",
    ));
  if (!won || !activated)
    return refuse(
      "activate",
      `no live agent named '${name}' is waiting for activation. Call action list to see the inventory.`,
    );
  return { ok: true, action: "activate", agent: publicAgent(won) };
}

export async function updateAgentScopes(
  db: D1Database,
  actor: string,
  name: string,
  args: ScopeArgs,
): Promise<AgentResult> {
  const row = await liveAgentByName(db, name);
  if (!row)
    return refuse(
      "update_scopes",
      `no live agent named '${name}'. Call action list to see the inventory, revoked ones included.`,
    );
  const before = parseScopes(row.scopes);
  const scopes = applyScopes(before, args);
  // Both sides go in the audit row: only the row that changed them says what they were and who widened them.
  const won = await changeWithAudit(
    db,
    actor,
    "agent-rescoped",
    row,
    { id: row.id, before, after: scopes },
    "scopes = ?2",
    "revoked_at IS NULL",
    serializeScopes(scopes),
  );
  if (!won)
    return refuse("update_scopes", `'${name}' was revoked between reading it and re-scoping it.`);
  return { ok: true, action: "update_scopes", agent: { ...publicAgent(row), scopes }, scopes };
}
