import { toHex } from "@dustinedwards/site-runtime/encoding";

// One module for the credential vocabulary so the table, tool (src/tools/agents.ts) and enforcement
// point (src/scope.ts) cannot disagree. Free of Worker and MCP imports so it is unit-testable under node.
// A kind is descriptive, not authorizing: what an agent may do lives in its scopes alone.
export const AGENT_KINDS = ["session", "driver", "seat", "cron"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const AGENT_GRANTS = ["read", "write"] as const;
export type AgentGrant = (typeof AGENT_GRANTS)[number];

// Each flag names an action whose consequence leaves this Worker, so a write grant alone is not enough (FLAG_REASON, src/scope.ts).
export const SCOPE_FLAGS = ["can_merge", "can_touch_protected"] as const;
export type ScopeFlag = (typeof SCOPE_FLAGS)[number];

// "*" inside a list is not a wildcard, so a typo in a mint command cannot grant everything.
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
  // 1 from the mint until Activate in the Portal (0065); the key resolves only at 0. Optional for test fakes.
  pending?: number;
  archived_at?: string | null;
}

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && (AGENT_KINDS as readonly string[]).includes(value);
}

export function noFlags(): Record<ScopeFlag, boolean> {
  const flags = {} as Record<ScopeFlag, boolean>;
  for (const flag of SCOPE_FLAGS) flags[flag] = false;
  return flags;
}

function emptyScopes(): AgentScopes {
  return { namespaces: [], repos: [], tools: [], grants: [], flags: noFlags() };
}

// Read on the named namespaces, no flags. Tools and repos stay open because the grant already limits them.
export function defaultScopes(namespaces: string[]): AgentScopes {
  return {
    namespaces: [...namespaces],
    repos: "*",
    tools: "*",
    grants: ["read"],
    flags: noFlags(),
  };
}

function parseList(value: unknown): ScopeList {
  if (value === "*") return "*";
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

// Fails closed: a null, empty, truncated or wrongly shaped scopes column resolves to emptyScopes(),
// since a permissive parse of a corrupt row looks like a working one.
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
    ? (record.grants.filter((g): g is AgentGrant =>
        (AGENT_GRANTS as readonly unknown[]).includes(g),
      ) as AgentGrant[])
    : [];
  const flags = noFlags();
  // Only known flags and only boolean true, so a hand-written blob cannot add an axis; retired keys are ignored.
  const rawFlags =
    typeof record.flags === "object" && record.flags !== null
      ? (record.flags as Record<string, unknown>)
      : {};
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

// "*" is the only wildcard and only as the whole value, never an entry.
export function allowsScope(list: ScopeList, value: string): boolean {
  return list === "*" ? true : list.includes(value);
}

// Like allowsScope for a tool whose action decides what it does (capsid_write_doc: write vs move). An entry may be
// qualified, `capsid_write_doc.write`: a list naming any action of this tool narrows it to those; a bare name with no qualified sibling is the whole tool.
export function allowsToolAction(
  list: ScopeList,
  tool: string,
  action: string | undefined,
): boolean {
  if (list === "*") return true;
  if (!list.includes(tool)) return false;
  const prefix = `${tool}.`;
  const qualified = list.some((entry) => entry.startsWith(prefix));
  if (!qualified) return true;
  // An unknown action on a narrowed tool is refused, not read as the whole tool: otherwise a path naming no action
  // could reach every action. Opt-in: a list with no qualified sibling for this tool is untouched.
  if (action === undefined) return false;
  return list.includes(`${prefix}${action}`);
}

export function describeScope(list: ScopeList): string {
  if (list === "*") return "*";
  return list.length === 0 ? "(none)" : list.join(", ");
}

export function mintAgentId(): string {
  return `agent_${toHex(crypto.getRandomValues(new Uint8Array(6)))}`;
}

// 32 bytes behind a greppable prefix so a leaked key is findable by one search. Returned once; only its sha256 is stored.
export function mintAgentKey(): string {
  return `capsid_agent_${toHex(crypto.getRandomValues(new Uint8Array(32)))}`;
}

// The audit identity, in the vocabulary audit_log.actor speaks; the name is UNIQUE.
export function agentActor(name: string): string {
  return `agent:${name}`;
}

// Register returns the mint command rather than minting, so no credential crosses the tool boundary.
function driverAgentName(namespace: string): string {
  return `${namespace}-driver`;
}

function driverKeyPath(namespace: string): string {
  return `~/.capsid/agent-${driverAgentName(namespace)}.key`;
}

export function driverMintInstruction(namespace: string): string {
  return (
    `Mint its driver agent as the admin: capsid_admin_manage_agents action mint with name ${driverAgentName(namespace)}, kind driver, ` +
    `namespaces ["${namespace}"] and grants read and write; its repos come from this mapping. ` +
    `The key is returned once: save it to ${driverKeyPath(namespace)} at mode 0600. ` +
    // Cannot import TOOL_GRANTS (src/scope.ts imports this module); test/audit-2026-09-16.test.ts keeps them together.
    `capsid_admin_manage_namespaces action register does not mint it: minting is admin only, and capsid_admin_manage_namespaces action register is itself admin only.`
  );
}
