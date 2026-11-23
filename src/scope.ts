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

// The one enforcement point: every tool call, and every repo mutation inside one, is checked here and nowhere else. A per-tool gate in each handler can be omitted by a new tool, cannot see writes a module away (the queue, the auto-merge tick), and must be widened at N sites.
//
// `checkScope` returns a refusal naming the missing scope, or null. The registrar (`guardRegistrations`) calls it before any handler for what the tool and arguments decide (allowlist, grant, namespace, repo selector); the handler calls it for the flags, which depend on what the call asks (a forced branch delete needs can_merge, a plain one does not).

// What each tool requires, stated once. The registrar enforces this table and
// src/tool-annotations.ts derives readOnlyHint from it, so the two cannot disagree.
//
// "action" means the requirement depends on the action argument. A tool whose
// requirement depends on nothing but the action states it per action in
// TOOL_ACTION_GRANTS below, and the registrar reads it. `capsid_work_jobs` (action
// list reads) and `capsid_lint_namespace` (mode gather reads) also depend on a namespace the handler resolves,
// so their handlers call checkScope at the point where both are known.
//
// "admin" is write plus the admin identity, for a tool that edits the authorization boundary or changes what other callers may do. "admin_read" is the admin identity with only the read grant: admin because it spans every namespace, read-only because it changes nothing (capsid/research/design-mcp-servers.md, section 3). Both live here because checkScope is the one grant check (test/scope.test.ts); no handler decides a grant for itself.
export type ToolRequirement = "read" | "write" | "action" | "admin" | "admin_read";

// Capsid (11) and Capsid Admin (8): src/tools/surface.ts.
export const TOOL_GRANTS: Record<string, ToolRequirement> = {
  capsid_start_session: "read",
  capsid_find_docs: "read",
  capsid_read_doc: "read",
  capsid_write_doc: "write",
  capsid_delete_doc: "write",
  // gather reads, finalize archives and report writes, each checked by the handler
  // where the namespace is known.
  capsid_lint_namespace: "action",
  capsid_read_repo: "read",
  // The CI log tail beyond the summary needs write, checked by the handler.
  capsid_inspect_repo: "read",
  capsid_close_pr: "write",
  // list reads; every other action changes the queue.
  capsid_work_jobs: "action",
  // Capsid's status (src/status.ts).
  capsid_read_status: "read",

  // What needs the seat, across every namespace and repo. It only reads.
  capsid_admin_whats_next: "admin_read",
  // The namespace-to-repo mapping is the authorization boundary. A write-grant driver
  // that could edit it could remap its own namespace onto any repo the App reaches
  // and, with a repos axis of "*", immediately read and write it. Delete reaches
  // across every table that names the namespace, which no scope narrows.
  capsid_admin_manage_namespaces: "admin",
  // The credential control plane. An agent that could mint, revoke or re-scope another
  // could widen itself.
  capsid_admin_manage_agents: "admin",
  // Claims apart from verified outcomes. It only reads; it spans every namespace and
  // every agent, and its export is the whole dataset.
  capsid_admin_read_claims: "admin_read",
  // The watcher's last pass, Cloudflare Access and Email Routing, Workers Builds, and the
  // secrets and data model (secret names, never values).
  // It only reads, and spans every namespace's sites, CI runs and Cloudflare state.
  capsid_admin_read_ops: "admin_read",
  // The administrator's controls (preview, then perform with a signed single-use
  // token). A control revokes an agent, resumes a job or edits a site, so a caller
  // that could use one could widen itself.
  capsid_admin_run_controls: "admin",
  // sign_policy decides whether this Worker may merge without a human, breaker_reset
  // reopens a namespace's queue and overnight starts unattended sessions. None of those
  // is a driver's work.
  capsid_admin_manage_switches: "admin",
};

// Fail closed: a tool with no entry requires the write grant, so a tool added without
// touching this table is refused to a read-only caller rather than waved through.
// test/invariants.test.ts asserts the table and the registrations name the same set,
// so the fallback is a backstop and not the normal path.
export function requiredGrant(tool: string): ToolRequirement {
  return Object.hasOwn(TOOL_GRANTS, tool) ? TOOL_GRANTS[tool] : "write";
}

// What each action requires, for an "action" tool whose requirement depends on nothing
// but the action. The registrar reads this table. An unlisted action takes `default`,
// so a new action is refused to a driver until listed.
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

// The OAuth scopes of the admin login (src/routes.ts consent page): every grant reads, and
// writes only when the box was ticked. An agent key's grants map onto the same two.
export const SCOPES = mcpScopes("capsid");

// For an "action" tool, the actions that only read; every other action writes. The
// handlers split the same way where the namespace is known (src/tools/jobs.ts list,
// src/tools/lint.ts gather), and a caller holding only the read grant is served the tool
// with these actions alone (src/tools/surface-composite.ts READ_VIEWS; area 11, T7).
export const READ_ACTIONS: Record<string, readonly [string, ...string[]]> = {
  capsid_work_jobs: ["list"],
  capsid_lint_namespace: ["gather"],
};

/** The scope a call needs, from TOOL_GRANTS (never from readOnlyHint): read for a read or
 *  admin_read tool and for a read action, write for everything else. */
export function declaredScope(tool: string, action: string | undefined): string {
  const requirement = requiredForAction(tool, action);
  if (requirement === "read" || requirement === "admin_read") return SCOPES.read;
  if (requirement === "action" && action !== undefined && READ_ACTIONS[tool]?.includes(action))
    return SCOPES.read;
  return SCOPES.write;
}

// The family's grant gate (site-runtime authorizeCall; area 11, S3 and A13) on every tool call, deciding on declaredScope against the scopes the caller's grants map to. The caller is already resolved by Capsid's own door, so only the scopes decide. A refusal is worded by checkScope. An "action" tool (jobs, lint) is left to its handler after its arguments; its OAuth step-up still comes first.
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

// A requirement as the part of a ScopeNeed it decides. The registrar and every route
// use this one mapping, so "admin" means the same thing wherever it is enforced.
export function needFor(requirement: ToolRequirement): Pick<ScopeNeed, "grant" | "admin"> {
  if (requirement === "admin") return { grant: "write", admin: true };
  if (requirement === "admin_read") return { grant: "read", admin: true };
  if (requirement === "action") return {};
  return { grant: requirement };
}

export interface ScopeNeed {
  tool: string;
  // A capsid_work_jobs call as the registrar saw it: the job id it names, and whether it
  // asks for more than one job's row (a view, the stale view or a status filter). Only
  // the registrar sets it, before every handler; a bench run key is bound by it
  // (benchRunRefusal).
  call?: { jobId?: string; filtered: boolean };
  // The action, for a tool whose action decides what it does. Present means the tools
  // axis may narrow this call to the actions it names (allowsToolAction).
  action?: string;
  // The namespace this call touches. `undefined` means the call names none, which is
  // not the same as "allowed" (see namespaceRefusal).
  namespace?: string;
  // The resolved repo, "owner/name", never the selector the caller passed.
  // The `repo` argument is a selector (a label like "primary", or owner/name), but the repos axis holds owner/name entries, so comparing the selector to the axis refuses legitimate labels and skips the axis when omitted. Resolve first, then ask.
  repo?: string;
  // The document path a call names, for the one exception to the namespace axis: a
  // read of a portfolio document in capsid (portfolioReadAdmits).
  path?: string;
  grant?: AgentGrant;
  // The caller must be the admin identity, not merely hold the write grant. Set by
  // the registrar for a tool whose TOOL_GRANTS entry is "admin" or "admin_read".
  admin?: boolean;
  // The action is a risky admin action (STEP_UP): an OAuth session needs a recent
  // sign-in. Set by the registrar.
  stepUp?: boolean;
  // Flags whose absence refuses the call. Every one is checked, and the refusal
  // names the FIRST missing one.
  flags?: readonly ScopeFlag[];
}

// The work queue's tool, named once: the handlers' re-checks
// (src/tools/jobs.ts, src/jobs-schema.ts) ask about it.
export const JOBS_TOOL = "capsid_work_jobs";

// Why a flag is needed, so a refusal tells the caller what to ask for.
const FLAG_REASON: Record<ScopeFlag, string> = {
  can_merge: "merging a pull request can trigger a deploy on a repo that deploys on push",
  can_touch_protected:
    "an autonomy policy document decides what this Worker may do without a human, so writing one is a ruling",
};

// Order is deliberate: tool, grant, admin, namespace, repo, flags. A caller that
// cannot use the tool is told that, not that its namespace is out of scope, which
// would leak which namespaces exist.
export function checkScope(agent: Agent, need: ScopeNeed): string | null {
  if (agent.benchRun) {
    const bound = benchRunRefusal(agent.benchRun, agent.actor, need);
    if (bound) return bound;
  }
  const scopes = agent.scopes;
  if (!allowsToolAction(scopes.tools, need.tool, need.action)) {
    // Name the qualified tool.action that failed. A caller told it is not scoped to
    // 'capsid_work_jobs' after being minted with capsid_work_jobs in its list would look for the wrong bug.
    const asked = need.action === undefined ? need.tool : `${need.tool}.${need.action}`;
    return `unauthorized: ${agent.actor} is not scoped to the '${asked}' tool. Its tool scope is ${describeScope(scopes.tools)}.`;
  }
  if (need.grant && !scopes.grants.includes(need.grant)) {
    return (
      `unauthorized: '${need.tool}' requires the ${need.grant} grant and ${agent.actor} holds ${scopes.grants.length ? scopes.grants.join(", ") : "no grant at all"}. ` +
      `A read-only caller can use the read tools and nothing else.`
    );
  }
  // Before the namespace check, so a driver calling an admin-only tool on its own
  // namespace is told the tool is admin only.
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

// What a bench run key may do (src/bench-run-key.ts): claim its one job and list that job by id; complete and fail end the run's own account of its job (complete only with a reproduction, src/jobs-seat.ts completeAsCaller). Every other tool or action, another job, no job, or a list wider than one row is refused, so a later action is closed to it until listed here. A re-check inside the jobs handler carries no call and is not bound: the registrar's check has already run.
const BENCH_RUN_ACTIONS: readonly string[] = ["claim", "list", "complete", "fail"];

function benchRunRefusal(
  run: { run: string; job: string | null },
  actor: string,
  need: ScopeNeed,
): string | null {
  const refusal = `unauthorized: ${actor} is the run key of bench run ${run.run} and may only claim, read, complete or fail its own job`;
  if (need.tool !== JOBS_TOOL) return `${refusal}; it cannot use ${need.tool}.`;
  if (!need.call) return null;
  if (!need.action || !BENCH_RUN_ACTIONS.includes(need.action))
    return `${refusal}; it cannot ${need.action ?? "call the tool with no action"}.`;
  if (run.job === null) return `${refusal}, and no single job carries this run's title yet.`;
  if (need.call.jobId !== run.job)
    return `${refusal} (${run.job}); this call names ${need.call.jobId ?? "no job"}.`;
  if (need.call.filtered)
    return `${refusal}; a list may not take a view, the stale view or a status filter.`;
  return null;
}

// The one exception to the namespace axis (src/portfolio-docs.ts): any caller may read
// the portfolio documents in capsid, because every driver is told to follow them. Only a
// read tool on the list, so a write, a job or an edge never crosses. capsid_read_doc action read must
// name an allowlisted path. capsid_find_docs actions list, glob and search name none: they are admitted here and their
// handlers drop every capsid row that is not on the list (portfolioOnly).
function portfolioReadAdmits(need: ScopeNeed): boolean {
  if (need.namespace !== PORTFOLIO_DOCS.namespace) return false;
  if (!isPortfolioTool(need.tool, need.action) || requiredGrant(need.tool) !== "read") return false;
  if (need.grant !== undefined && need.grant !== "read") return false;
  if (need.admin || need.flags?.length) return false;
  if (need.tool === "capsid_read_doc") return need.path !== undefined && isPortfolioPath(need.path);
  return true;
}

/** Whether this caller reaches `namespace` only through the portfolio exception, so a
 *  listing handler must keep only the portfolio documents. */
export function portfolioOnly(agent: Agent, namespace: string | undefined): boolean {
  return namespace === PORTFOLIO_DOCS.namespace && !allowsScope(agent.scopes.namespaces, namespace);
}

// STEP-UP, for Capsid Admin: the admin actions that change who may do what, or that cannot be taken back, need a recent Access sign-in (a grant lives for weeks and refreshes without a person). It is a re-authentication, not a mid-call confirmation (the ruling's rule 12). "*" is every action of the tool.
//
// The window slides, as GitHub's sudo mode does: allowed when the Access sign-in or the last SUCCESSFUL step-up action was within STEP_UP_IDLE_MS, each success resetting the clock. STEP_UP_MAX_MS caps it from the sign-in (NIST SP 800-63B-4: AAL3 no more than 12 hours), so only a new sign-in extends past it. Only an OAuth session carries a sign-in time (Agent.signedInAt); a key holder is not stepped up, its key is the credential.
const STEP_UP_IDLE_MS = 2 * HOUR_MS;
const STEP_UP_MAX_MS = 12 * HOUR_MS;

export const STEP_UP: Record<string, readonly string[] | "*"> = {
  capsid_admin_manage_namespaces: ["register", "update", "delete_perform"],
  capsid_admin_manage_agents: ["mint", "revoke", "update_scopes"],
  capsid_admin_run_controls: ["perform"],
  capsid_admin_manage_switches: "*",
};

export function needsStepUp(tool: string, action: string | undefined): boolean {
  if (!Object.hasOwn(STEP_UP, tool)) return false;
  const actions = STEP_UP[tool];
  return actions === "*" || (action !== undefined && actions.includes(action));
}

// The last successful step-up action is kept in KV, because each MCP request builds a
// fresh Agent. It is kept per SESSION, keyed by the admin and the session's sign-in time,
// not per admin: activity in one session (a laptop) must not keep another, idle one (a
// forgotten device, or a grant whose refresh token leaked) inside the window. The entry
// outlives the hard cap, so it never expires while it could still matter.
const stepUpKey = (actor: string, signedInAt: number): string =>
  `step-up:last:${actor}:${signedInAt}`;

/** The time of this session's last successful step-up action, or undefined when there
 *  is none or KV cannot say. Undefined falls back to the sign-in time alone, so a KV
 *  failure can only narrow access, never widen it; a time after `now` is refused for the
 *  same reason, since it would read as activity that has not happened. */
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

// Called only after a step-up action succeeded. The action is already done, so a KV
// failure is logged and never fails it; the cost is that the idle clock is not reset.
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

// Why each admin-only thing is admin only, for the refusal. An "admin" requirement
// with no entry here fails the test that reads this table.
const ADMIN_REASON: Record<string, string> = {
  capsid_admin_whats_next:
    "It reads what waits on the seat across every namespace and every mapped repo (blocked jobs, questions, open pull requests and their CI, stale work, failed checks), which is wider than any one caller's scope.",
  capsid_admin_manage_namespaces:
    "It edits the namespace-to-repo mapping, which is the authorization boundary every repo call resolves through, and its delete removes every live document of a namespace, so a scoped caller that could use it could widen itself or delete the boundary it sits behind.",
  capsid_admin_manage_agents:
    "It mints, re-scopes and revokes agents, so a scoped caller that could use it could widen itself.",
  capsid_admin_read_claims:
    "It reads every agent's claims, the Worker's checks of them and every human touch, across every namespace, which is wider than any one caller's scope.",
  capsid_admin_read_ops:
    "It reads the watcher's last pass, the Cloudflare account's Access and Email Routing configuration, and every Workers Build, across every namespace, which is wider than any one caller's scope.",
  capsid_admin_run_controls:
    "It runs the administrator's controls (revoke an agent, resume or fail a job, edit the sites and packages the Portal watches), each of which changes what other callers may do or see, so a scoped caller that could use one could widen itself.",
  capsid_admin_manage_switches:
    "It holds the administrator's switches: sign_policy decides whether this Worker may merge without a human, breaker_reset reopens a namespace's queue and overnight starts unattended sessions, so a caller that could use one could widen itself. A driver reads status with capsid_read_status.",
};

function adminReason(tool: string): string {
  return Object.hasOwn(ADMIN_REASON, tool)
    ? ADMIN_REASON[tool]
    : "It acts on more than one namespace's scope.";
}

// The policy override is itself scoped: `allow_improve_paths`, which lets a document
// write reach an autonomy policy document (capsid/policy/), needs these flags. The
// argument keeps the improve loop's name, from when it also opened the loop's documents. The document tools check this list; it is named here so
// the flag vocabulary stays inside the enforcement point.
export const IMPROVE_OVERRIDE_FLAGS = ["can_touch_protected"] as const;

// Money paths: a repo path that names a billing or payment surface, matched by name.
// A tripwire, not an authorization boundary. Broad on purpose and portfolio-wide: a
// false positive costs one refusal naming the flag, a false negative is a payment
// file edited by a credential nobody scoped for it. A word separator counts as a
// boundary, so `stripe-client.ts` trips it (and so would `subscription-less.ts`).
const MONEY_PATH =
  /(^|\/)(billing|payments?|checkout|invoices?|pricing|subscriptions?|stripe|payouts?|refunds?)(\/|[-_.]|$)/i;

export function isMoneyPath(path: string): boolean {
  return MONEY_PATH.test(path);
}

// Every flag a repo mutation needs, derived from the call, in one function so the
// repo write tools cannot each decide a different answer.
export function repoWriteFlags(
  tool: string,
  action: string | undefined,
  args: { force?: boolean },
): ScopeFlag[] {
  const flags: ScopeFlag[] = [];
  // close deletes the head branch, so a plain write grant could destroy the only copy
  // of a branch somebody else pushed. That is the same blast radius as merge, so it
  // needs can_merge too. Not deleting on close would leave stale branches behind. A tag
  // or a release can start a deploy as a merge can.
  if (
    tool === "capsid_close_pr" &&
    (action === "merge" || action === "close" || action === "tag" || action === "release")
  )
    flags.push("can_merge");
  // A forced branch delete too: force lifts the open-PR refusal, so it could delete
  // another agent's open PR head. A delete without force needs no flag.
  if (tool === "capsid_close_pr" && action === "delete_branch" && args.force === true)
    flags.push("can_merge");
  return flags;
}
