import { bytesToHex } from "./encoding";

// The vocabulary of a scoped credential, in one module so the table
// (migrations/0008_agents.sql), the tool (src/tools/agents.ts) and the enforcement
// point (src/scope.ts) cannot disagree about it: a list spelled twice drifts, and the
// copy nobody looks at ends up checking five flags out of six. Free of Worker and MCP
// imports so the scope logic is unit-testable under node.

// Descriptive, not authorizing. What an agent may do lives in its scopes and
// nowhere else, so a kind cannot quietly become a second permission system.
export const AGENT_KINDS = ["session", "driver", "seat", "cron"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const AGENT_GRANTS = ["read", "write"] as const;
export type AgentGrant = (typeof AGENT_GRANTS)[number];

// Each flag names an action whose consequence leaves this Worker, so the write grant
// alone is not enough for any of them. The reasons are FLAG_REASON in src/scope.ts.
export const SCOPE_FLAGS = [
  "can_merge",
  "can_direct_write",
  "can_dispatch",
  "can_write_workflows",
  "can_touch_protected",
  "money_paths",
  // Commenting goes through manage_pr, a write tool, so a reviewer holds the write
  // grant; without a flag of its own that grant would also let it merge and close.
  // This flag makes "may comment on this PR" smaller than "may decide this PR".
  "can_comment_pr",
] as const;
export type ScopeFlag = (typeof SCOPE_FLAGS)[number];

// A list of names, or "*" for every name. "*" inside a list is not a wildcard, so a
// typo in a mint command cannot grant everything.
export type ScopeList = "*" | string[];

export interface AgentScopes {
  namespaces: ScopeList;
  repos: ScopeList;
  tools: ScopeList;
  grants: AgentGrant[];
  flags: Record<ScopeFlag, boolean>;
}

export interface AgentRow {
  id: string;
  name: string;
  kind: AgentKind;
  key_hash: string;
  scopes: string;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  last_seen: string | null;
}

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && (AGENT_KINDS as readonly string[]).includes(value);
}

export function noFlags(): Record<ScopeFlag, boolean> {
  // Built fresh each time, so a flag set on one agent cannot leak to another.
  const flags = {} as Record<ScopeFlag, boolean>;
  for (const flag of SCOPE_FLAGS) flags[flag] = false;
  return flags;
}

// Nothing allowed: what parseScopes falls back to on a corrupt row.
function emptyScopes(): AgentScopes {
  return { namespaces: [], repos: [], tools: [], grants: [], flags: noFlags() };
}

// The default for a new agent: read, on the namespaces it was named for, and no
// flags. Tools and repos are unrestricted because the grant already limits them (a
// read grant cannot reach a write tool, and a repo read is a read); the axes that
// must be narrowed at mint time are the ones the mint command asks for.
export function defaultScopes(namespaces: string[]): AgentScopes {
  return { namespaces: [...namespaces], repos: "*", tools: "*", grants: ["read"], flags: noFlags() };
}

function parseList(value: unknown): ScopeList {
  if (value === "*") return "*";
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

// Fails closed: a scopes column that is null, empty, truncated, an array, a bare
// string or an object with none of the keys resolves to emptyScopes(). A permissive
// parse of a corrupt row looks like a working one until the row is corrupt.
export function parseScopes(json: string | null | undefined): AgentScopes {
  if (!json) return emptyScopes();
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return emptyScopes();
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyScopes();
  const record = raw as Record<string, unknown>;
  const grants = Array.isArray(record.grants)
    ? (record.grants.filter((g): g is AgentGrant => (AGENT_GRANTS as readonly unknown[]).includes(g)) as AgentGrant[])
    : [];
  const flags = noFlags();
  // Only the flags this system has, and only the boolean true, so a hand-written
  // scopes blob cannot add an axis the enforcement point does not know.
  const rawFlags = typeof record.flags === "object" && record.flags !== null ? (record.flags as Record<string, unknown>) : {};
  for (const flag of SCOPE_FLAGS) flags[flag] = rawFlags[flag] === true;
  return {
    namespaces: parseList(record.namespaces),
    repos: parseList(record.repos),
    tools: parseList(record.tools),
    grants,
    flags,
  };
}

export function serializeScopes(scopes: AgentScopes): string {
  return JSON.stringify(scopes);
}

// The one list comparison. "*" is the only wildcard and it is the whole value, never
// an entry.
export function allowsScope(list: ScopeList, value: string): boolean {
  return list === "*" ? true : list.includes(value);
}

// The same comparison for a tool whose action decides what it does (jobs: "may post
// a job" and "may claim one" are different authorities). An entry may be qualified,
// `jobs.post`, and the rule is:
//
//   - "*" allows everything.
//   - A list naming at least one action of this tool is narrowed to the actions it
//     names. Anything else of that tool is refused.
//   - A bare tool name with no qualified sibling means the whole tool.
//   - The narrowing reaches only the tool it names.
//
// Kept beside allowsScope rather than in the enforcement point so the rule is one
// pure function the tests can drive without an agent or a server.
export function allowsToolAction(list: ScopeList, tool: string, action: string | undefined): boolean {
  if (list === "*") return true;
  if (!list.includes(tool)) return false;
  const prefix = `${tool}.`;
  const qualified = list.some((entry) => entry.startsWith(prefix));
  if (!qualified) return true;
  // An unknown action on a narrowed tool is refused, not read as the whole tool:
  // otherwise a reviewer minted ["manage_pr", "manage_pr.comment"] could close a pull
  // request through a call path that names no action.
  //
  // It stays opt-in: a list with no qualified sibling for this tool is untouched.
  // Opting in means the call path has to say what it is doing, and a path that cannot
  // is refused.
  if (action === undefined) return false;
  return list.includes(`${prefix}${action}`);
}

// How a scope list reads in a refusal, so the refusal says what the scope is.
export function describeScope(list: ScopeList): string {
  if (list === "*") return "*";
  return list.length === 0 ? "(none)" : list.join(", ");
}

// agent_<12 hex>. See the migration for why it is not a sequence.
export function mintAgentId(): string {
  return `agent_${bytesToHex(crypto.getRandomValues(new Uint8Array(6)))}`;
}

// 32 bytes of entropy behind a greppable prefix, so a key pasted into a file, a log
// or a commit is findable by searching for one string. Returned ONCE by the mint
// action and stored nowhere: what the table holds is its sha256.
export function mintAgentKey(): string {
  return `capsid_agent_${bytesToHex(crypto.getRandomValues(new Uint8Array(32)))}`;
}

// The audit identity, in the vocabulary audit_log.actor and jobs.claimed_by already
// speak (`github:<login>`, `opkey:<fingerprint>`). The name is UNIQUE in the table,
// so this string identifies exactly one agent row.
export function agentActor(name: string): string {
  return `agent:${name}`;
}

// The driver bootstrap instruction. register_namespace returns the mint command
// rather than minting, so no credential crosses the tool boundary.
// test/register-namespace-mint.test.ts asserts the script it names can parse it.
export function driverAgentName(namespace: string): string {
  return `${namespace}-driver`;
}

export function driverKeyPath(namespace: string): string {
  return `~/.capsid/agent-${driverAgentName(namespace)}.key`;
}

export function driverMintInstruction(namespace: string): string {
  return (
    `Mint its driver agent as the admin: node scripts/mint-agents.mjs --namespace ${namespace} --apply. ` +
    `The key is returned once and lands in ${driverKeyPath(namespace)} at mode 0600. ` +
    // Cannot import TOOL_GRANTS (src/scope.ts imports this module), so
    // test/audit-2026-09-16.test.ts holds the sentence and the table together.
    `register_namespace does not mint it: minting is admin only, and register_namespace is itself admin only.`
  );
}
