import type { Agent } from "./agents";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { authorizeCall, mcpScopes, type McpCaller } from "@dustinedwards/site-runtime/mcp-server";
import {
  allowsScope,
  allowsToolAction,
  describeScope,
  type AgentGrant,
  type ScopeFlag,
} from "./agents-schema";
import {
  describePortfolioDocs,
  isPortfolioPath,
  isPortfolioTool,
  PORTFOLIO_DOCS,
} from "./portfolio-docs";
import { MINUTE_MS, HOUR_MS } from "./time";

// The one enforcement point: every tool call and repo mutation is checked here. A per-tool gate can
// be omitted by a new tool and cannot see writes a module away (the tick).

// What each tool requires. The registrar enforces it and tool-annotations.ts derives readOnlyHint
// from it. "action" means the requirement depends on the action argument.
export type ToolRequirement = "read" | "write" | "action" | "admin" | "admin_read";

export const TOOL_GRANTS: Record<string, ToolRequirement> = {
  capsid_start_session: "read",
  capsid_find_docs: "read",
  capsid_read_doc: "read",
  capsid_write_doc: "write",
  capsid_delete_doc: "write",
  capsid_lint_namespace: "action",
  capsid_read_repo: "read",
  capsid_inspect_repo: "read",
  capsid_close_pr: "write",
  capsid_read_status: "read",

  capsid_admin_whats_next: "admin_read",
  // The namespace-to-repo mapping is the authorization boundary: a write driver that could edit it
  // could remap its namespace onto any repo the App reaches.
  capsid_admin_manage_namespaces: "admin",
  // The credential control plane. An agent that could mint, revoke or re-scope another
  // An agent that could mint or re-scope another could widen itself.
  capsid_admin_manage_agents: "admin",
  capsid_admin_read_ops: "admin_read",
  // A control revokes an agent or edits a site, so a caller using one could widen itself.
  capsid_admin_run_controls: "admin",
};

// Fail closed: a tool with no entry requires write. test/invariants.test.ts keeps the table and
// the registrations in step, so this is a backstop.
export function requiredGrant(tool: string): ToolRequirement {
  return Object.hasOwn(TOOL_GRANTS, tool) ? TOOL_GRANTS[tool] : "write";
}

// An unlisted action takes `default`, so a new action is refused to a driver until listed.
export const TOOL_ACTION_GRANTS: Record<
  string,
  { default: ToolRequirement; actions: Record<string, ToolRequirement> }
> = {};

export function requiredForAction(tool: string, action: string | undefined): ToolRequirement {
  const spec = Object.hasOwn(TOOL_ACTION_GRANTS, tool) ? TOOL_ACTION_GRANTS[tool] : null;
  if (!spec) return requiredGrant(tool);
  if (action === undefined) return spec.default;
  return Object.hasOwn(spec.actions, action) ? spec.actions[action] : spec.default;
}

export const SCOPES = mcpScopes("capsid");

export const READ_ACTIONS: Record<string, readonly [string, ...string[]]> = {
  capsid_lint_namespace: ["gather"],
};

// From TOOL_GRANTS, never readOnlyHint.
export function declaredScope(tool: string, action: string | undefined): string {
  const requirement = requiredForAction(tool, action);
  if (requirement === "read" || requirement === "admin_read") return SCOPES.read;
  if (requirement === "action" && action !== undefined && READ_ACTIONS[tool]?.includes(action))
    return SCOPES.read;
  return SCOPES.write;
}

// The family's grant gate (site-runtime authorizeCall) on every tool call. Only scopes decide: the
// caller is already resolved by Capsid's own door.
export function sharedGrantRefusal(
  agent: Agent,
  tool: string,
  action: string | undefined,
): string | null {
  if (requiredForAction(tool, action) === "action") return null;
  const scope = declaredScope(tool, action);
  const caller: McpCaller = {
    kind: "person",
    email: agent.actor,
    scopes: agent.scopes.grants.map((g) => SCOPES[g]),
  };
  if (authorizeCall({}, caller, scope, { site: "Capsid", scopes: SCOPES }) === null) return null;
  const grant: AgentGrant = scope === SCOPES.read ? "read" : "write";
  return (
    checkScope(agent, { tool, action, grant }) ??
    `unauthorized: '${tool}' requires the ${grant} grant.`
  );
}

export function needFor(requirement: ToolRequirement): Pick<ScopeNeed, "grant" | "admin"> {
  if (requirement === "admin") return { grant: "write", admin: true };
  if (requirement === "admin_read") return { grant: "read", admin: true };
  if (requirement === "action") return {};
  return { grant: requirement };
}

export interface ScopeNeed {
  tool: string;
  action?: string;
  // `undefined` means the call names none, which is not "allowed" (see namespaceRefusal).
  namespace?: string;
  // Resolved owner/name, never the caller's selector: the repos axis holds owner/name, so comparing a
  // label like "primary" would refuse legitimate calls.
  repo?: string;
  path?: string;
  grant?: AgentGrant;
  admin?: boolean;
  stepUp?: boolean;
  // The refusal names the first missing flag.
  flags?: readonly ScopeFlag[];
}

const FLAG_REASON: Record<ScopeFlag, string> = {
  can_merge: "merging a pull request can trigger a deploy on a repo that deploys on push",
  can_touch_protected:
    "an autonomy policy document decides what this Worker may do without a human, so writing one is a ruling",
};

// Order is deliberate: a caller that cannot use the tool is told that, not that its namespace is
// out of scope, which would leak which namespaces exist.
export function checkScope(agent: Agent, need: ScopeNeed): string | null {
  const scopes = agent.scopes;
  if (!allowsToolAction(scopes.tools, need.tool, need.action)) {
    // Name the qualified tool.action so the caller does not look for the wrong bug.
    const asked = need.action === undefined ? need.tool : `${need.tool}.${need.action}`;
    return `unauthorized: ${agent.actor} is not scoped to the '${asked}' tool. Its tool scope is ${describeScope(scopes.tools)}.`;
  }
  if (need.grant && !scopes.grants.includes(need.grant)) {
    return (
      `unauthorized: '${need.tool}' requires the ${need.grant} grant and ${agent.actor} holds ${scopes.grants.length ? scopes.grants.join(", ") : "no grant at all"}. ` +
      `A read-only caller can use the read tools and nothing else.`
    );
  }
  // Before the namespace check, so a driver on its own namespace is told the tool is admin only.
  if (need.admin && !agent.admin) {
    const asked = need.action === undefined ? need.tool : `${need.tool}.${need.action}`;
    return `unauthorized: '${asked}' is admin only and ${agent.actor} is not the admin. ${adminReason(need.tool)} Ask the admin to do it.`;
  }
  if (need.stepUp) {
    const stale = stepUpRefusal(agent, need, Date.now());
    if (stale) return stale;
  }
  if (
    need.namespace !== undefined &&
    !allowsScope(scopes.namespaces, need.namespace) &&
    !portfolioReadAdmits(need)
  ) {
    return (
      `unauthorized: ${agent.actor} is not scoped to the '${need.namespace}' namespace. Its namespace scope is ${describeScope(scopes.namespaces)}.` +
      (need.namespace === PORTFOLIO_DOCS.namespace
        ? ` Outside its own namespace it may only read the portfolio documents in ${PORTFOLIO_DOCS.namespace}: ${describePortfolioDocs().join(", ")}.`
        : "")
    );
  }
  if (need.repo !== undefined && !allowsScope(scopes.repos, need.repo)) {
    return `unauthorized: ${agent.actor} is not scoped to the '${need.repo}' repo. Its repo scope is ${describeScope(scopes.repos)}.`;
  }
  for (const flag of need.flags ?? []) {
    if (!scopes.flags[flag]) {
      return `unauthorized: '${need.tool}' needs the ${flag} flag and ${agent.actor} does not hold it, because ${FLAG_REASON[flag]}.`;
    }
  }
  return null;
}

// The one exception to the namespace axis: every driver is told to follow the portfolio documents.
function portfolioReadAdmits(need: ScopeNeed): boolean {
  if (need.namespace !== PORTFOLIO_DOCS.namespace) return false;
  if (!isPortfolioTool(need.tool, need.action) || requiredGrant(need.tool) !== "read") return false;
  if (need.grant !== undefined && need.grant !== "read") return false;
  if (need.admin || need.flags?.length) return false;
  if (need.tool === "capsid_read_doc") return need.path !== undefined && isPortfolioPath(need.path);
  return true;
}

export function portfolioOnly(agent: Agent, namespace: string | undefined): boolean {
  return namespace === PORTFOLIO_DOCS.namespace && !allowsScope(agent.scopes.namespaces, namespace);
}

// Step-up: admin actions that change who may do what or cannot be undone need a recent Access
// sign-in (a grant refreshes for weeks without a person).
const STEP_UP_IDLE_MS = 2 * HOUR_MS;
const STEP_UP_MAX_MS = 12 * HOUR_MS;

export const STEP_UP: Record<string, readonly string[] | "*"> = {
  capsid_admin_manage_namespaces: ["register", "update", "delete_perform"],
  capsid_admin_manage_agents: ["mint", "revoke", "update_scopes"],
  capsid_admin_run_controls: ["perform"],
};

export function needsStepUp(tool: string, action: string | undefined): boolean {
  if (!Object.hasOwn(STEP_UP, tool)) return false;
  const actions = STEP_UP[tool];
  return actions === "*" || (action !== undefined && actions.includes(action));
}

// KV, because each MCP request builds a fresh Agent.
const stepUpKey = (actor: string, signedInAt: number): string =>
  `step-up:last:${actor}:${signedInAt}`;

export async function readLastStepUp(
  kv: KVNamespace,
  actor: string,
  signedInAt: number,
  now: number = Date.now(),
): Promise<number | undefined> {
  try {
    const value = Number(await kv.get(stepUpKey(actor, signedInAt)));
    return Number.isFinite(value) && value > 0 && value <= now ? value : undefined;
  } catch (error) {
    logEvent(
      "STEP_UP_READ_FAILED",
      {
        message: `STEP_UP_READ_FAILED: ${errorMessage(error)}; using the sign-in time alone`,
      },
      { level: "error" },
    );
    return undefined;
  }
}

// Called only after a step-up action succeeded: a KV failure is logged and never fails it.
export async function recordStepUp(
  kv: KVNamespace,
  agent: Agent,
  signedInAt: number,
  now: number,
): Promise<void> {
  agent.lastStepUpAt = now;
  try {
    await kv.put(stepUpKey(agent.actor, signedInAt), String(now), {
      expirationTtl: STEP_UP_MAX_MS / 1000 + 3600,
    });
  } catch (error) {
    logEvent(
      "STEP_UP_WRITE_FAILED",
      {
        message: `STEP_UP_WRITE_FAILED: ${errorMessage(error)}; the action succeeded and the idle clock was not reset`,
      },
      { level: "error" },
    );
  }
}

function stepUpRefusal(agent: Agent, need: ScopeNeed, now: number): string | null {
  if (agent.signedInAt === undefined) return null;
  const asked = need.action === undefined ? need.tool : `${need.tool}.${need.action}`;
  const rule =
    `A step-up action needs an Access sign-in or a step-up action within the last ${STEP_UP_IDLE_MS / HOUR_MS} hours, ` +
    `and never more than ${STEP_UP_MAX_MS / HOUR_MS} hours after the sign-in.`;
  const fix = `Reconnect the Capsid Admin connector (disconnect, then connect, and sign in), then call it again. Nothing was done.`;
  if (agent.signedInAt === null) {
    return `step-up required: '${asked}' changes who may do what or cannot be taken back. ${rule} This session signed in before sign-in times were recorded. ${fix}`;
  }
  const sinceSignIn = now - agent.signedInAt;
  const sinceActive = now - Math.max(agent.signedInAt, agent.lastStepUpAt ?? 0);
  if (sinceSignIn <= STEP_UP_MAX_MS && sinceActive <= STEP_UP_IDLE_MS) return null;
  const minutes = (ms: number): string => `${Math.round(ms / MINUTE_MS)} minutes ago`;
  const why =
    sinceSignIn > STEP_UP_MAX_MS
      ? `this session signed in ${minutes(sinceSignIn)}, past the ${STEP_UP_MAX_MS / HOUR_MS} hour cap`
      : `this session signed in ${minutes(sinceSignIn)} and its last step-up action was ${agent.lastStepUpAt === undefined ? "none" : minutes(now - agent.lastStepUpAt)}`;
  return `step-up required: '${asked}' changes who may do what or cannot be taken back. ${rule} Here ${why}. ${fix}`;
}

const ADMIN_REASON: Record<string, string> = {
  capsid_admin_whats_next:
    "It reads what waits on the seat across every namespace and every mapped repo (open handoffs, open pull requests and their CI, the watcher's findings and failed checks), which is wider than any one caller's scope.",
  capsid_admin_manage_namespaces:
    "It edits the namespace-to-repo mapping, which is the authorization boundary every repo call resolves through, and its delete removes every live document of a namespace, so a scoped caller that could use it could widen itself or delete the boundary it sits behind.",
  capsid_admin_manage_agents:
    "It mints, re-scopes and revokes agents, so a scoped caller that could use it could widen itself.",
  capsid_admin_read_ops:
    "It reads the watcher's last pass, the Cloudflare account's Access and Email Routing configuration, and every Workers Build, across every namespace, which is wider than any one caller's scope.",
  capsid_admin_run_controls:
    "It runs the administrator's controls (revoke an agent, edit the sites the Portal watches and the npm packages it lists), each of which changes what other callers may do or see, so a scoped caller that could use one could widen itself.",
};

function adminReason(tool: string): string {
  return Object.hasOwn(ADMIN_REASON, tool)
    ? ADMIN_REASON[tool]
    : "It acts on more than one namespace's scope.";
}

// The flag `allow_policy_paths` needs: a write or delete that reaches capsid/policy/.
export const POLICY_OVERRIDE_FLAGS = ["can_touch_protected"] as const;

export function repoWriteFlags(
  tool: string,
  action: string | undefined,
  args: { force?: boolean },
): ScopeFlag[] {
  const flags: ScopeFlag[] = [];
  // close deletes the head branch (merge's blast radius); a tag or release can start a deploy.
  if (
    tool === "capsid_close_pr" &&
    (action === "merge" || action === "close" || action === "tag" || action === "release")
  )
    flags.push("can_merge");
  // force lifts the open-PR refusal, so it could delete another agent's open PR head.
  if (tool === "capsid_close_pr" && action === "delete_branch" && args.force === true)
    flags.push("can_merge");
  return flags;
}
