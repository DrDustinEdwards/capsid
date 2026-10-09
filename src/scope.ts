import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Agent } from "./agents";
import type { AdminWriteObserver } from "./admin-client-audit";
import { allowsScope, allowsToolAction, describeScope, type AgentGrant, type ScopeFlag } from "./agents-schema";
import { protectedHits } from "./improve-schema";
import { describePortfolioDocs, isPortfolioPath, isPortfolioTool, PORTFOLIO_DOCS } from "./portfolio-docs";

// The one enforcement point. Every tool call, and every repo mutation inside one, is
// checked here and nowhere else.
//
// A per-tool gate in each handler has three failure modes: a new tool can simply
// omit the line, and a scan for mutating SQL cannot see a tool whose writes happen a
// module away (the queue, the improve loop, every repo write); a bare "may write"
// says nothing about which namespace, which repo, or whether the caller may merge
// into a repo that deploys on push; and a check spelled N times has to be widened at
// N sites, which is how a fix lands in all but one of them.
//
// `checkScope` returns a refusal string naming the missing scope, or null. It is
// called from two places, split by where the information is:
//
//   - The registrar (`guardRegistrations`), before any handler runs, for what is
//     knowable from the tool and its arguments: the tool allowlist, the grant, the
//     namespace and the repo selector.
//   - The handler, for the flags, which depend on what the call asks to do.
//     `mode: "direct"` needs can_direct_write and `mode: "pr"` does not, and no
//     wrapper can know that before reading the arguments.

// What each tool requires, stated once. The registrar enforces this table and
// src/tool-annotations.ts derives readOnlyHint from it, so the two cannot disagree.
//
// "action" means the requirement depends on the action argument. `improve_run` states
// its per-action requirements in TOOL_ACTION_GRANTS below, and the registrar reads
// them, because the requirement depends on nothing but the action. `jobs` (list
// reads) and `lint` (gather reads) also depend on a namespace the handler resolves,
// so their handlers call checkScope at the point where both are known.
//
// "admin" is write plus the admin identity, for a tool that edits the authorization
// boundary itself. It lives here, not in a handler, because these tools are
// admin-only in whole, which the registrar can decide from the tool name alone, and
// because under the one enforcement point rule (CLAUDE.md) this table is the one
// statement of what each tool requires. No handler decides a grant for itself.
export type ToolRequirement = "read" | "write" | "action" | "admin";

export const TOOL_GRANTS: Record<string, ToolRequirement> = {
  list: "read",
  read: "read",
  brief: "read",
  backlinks: "read",
  find: "read",
  search: "read",
  namespaces: "read",
  history: "read",

  write: "write",
  delete: "write",
  move: "write",
  restore: "write",
  // The namespace-to-repo mapping is the authorization boundary. A write-grant driver
  // that could edit it could remap its own namespace onto any repo the App reaches
  // and, with a repos axis of "*", immediately read and write it.
  register_namespace: "admin",
  update_namespace: "admin",
  // Removes the mapping and, with cascade, every live document of the namespace. It
  // reaches across every table that names the namespace, which no scope narrows.
  delete_namespace: "admin",
  // gather reads, finalize archives.
  lint: "action",

  list_repo_tree: "read",
  read_repo_file: "read",
  search_code: "read",
  repo_refs: "read",
  repo_history: "read",
  ci_status: "read",
  write_repo_file: "write",
  create_branch: "write",
  open_pr: "write",
  delete_repo_file: "write",
  manage_pr: "write",
  delete_branch: "write",
  ci_dispatch: "write",

  improve_status: "read",
  // Per action, in TOOL_ACTION_GRANTS: run and claim are a driver's work, and every
  // other action controls the loop rather than doing it.
  improve_run: "action",

  // list reads; every other action changes the queue.
  jobs: "action",

  // The credential control plane. Admin in whole: an agent that could mint, revoke or
  // re-scope another could widen itself.
  agents: "admin",

  // Claims apart from verified outcomes. It only reads, and is admin only in whole:
  // it spans every namespace and every agent, and its export is the whole dataset.
  claims: "admin",

  // The watcher's last pass. It only reads, and is admin only in whole: the snapshot
  // spans every namespace's sites, CI runs and Cloudflare state.
  ops_snapshot: "admin",

  // Cloudflare Access and Email Routing, read. Admin only in whole: the account's login
  // gates and mail routes span every namespace.
  cloudflare_config: "admin",

  // The administrator's controls, the Portal's buttons as one tool (preview, then perform
  // with a signed single-use token). Admin only in whole: a control pauses the loop,
  // revokes an agent or edits a site, so a caller that could use one could widen itself.
  // A ruled addition to the tool surface (capsid/decisions-vol-5.md, the controls ruling).
  controls: "admin",
};

// Fail closed: a tool with no entry requires the write grant, so a tool added without
// touching this table is refused to a read-only caller rather than waved through.
// test/invariants.test.ts asserts the table and the registrations name the same set,
// so the fallback is a backstop and not the normal path.
export function requiredGrant(tool: string): ToolRequirement {
  return Object.hasOwn(TOOL_GRANTS, tool) ? TOOL_GRANTS[tool] : "write";
}

// What each action requires, for an "action" tool whose requirement depends on nothing
// but the action. The registrar reads this table. An unlisted action takes `default`
// (admin for improve_run), so a new action is refused to a driver until listed.
export const TOOL_ACTION_GRANTS: Record<string, { default: ToolRequirement; actions: Record<string, ToolRequirement> }> = {
  improve_run: {
    // mode switches the whole loop off, pause stops a namespace, budget moves the spend
    // ceiling, mint_operator_key issues a credential, and sign_policy decides whether
    // this Worker may merge without a human. None of those is a driver's work.
    default: "admin",
    actions: {
      // A missing action is a run.
      run: "write",
      // Taking and releasing the driver lease is what a driver does every run, and it
      // is what stops two drivers working one namespace.
      claim: "write",
    },
  },
};

export function requiredForAction(tool: string, action: string | undefined): ToolRequirement {
  const spec = Object.hasOwn(TOOL_ACTION_GRANTS, tool) ? TOOL_ACTION_GRANTS[tool] : null;
  if (!spec) return requiredGrant(tool);
  const key = action ?? "run";
  return Object.hasOwn(spec.actions, key) ? spec.actions[key] : spec.default;
}

// A requirement as the part of a ScopeNeed it decides. The registrar and every route
// use this one mapping, so "admin" means the same thing wherever it is enforced.
export function needFor(requirement: ToolRequirement): Pick<ScopeNeed, "grant" | "admin"> {
  if (requirement === "admin") return { grant: "write", admin: true };
  if (requirement === "action") return {};
  return { grant: requirement };
}

// HTTP routes, which guardRegistrations never sees: it wraps MCP tools, and a plain
// route in src/routes.ts is outside it by construction. A route checked only for the
// write grant would let a driver minted for one namespace act across all of them.
//
// Every route in defaultHandler is in exactly one of these two tables, and
// test/route-gates.test.ts fails when one is in neither, so a new route is a decision
// rather than a gap.

// A route that goes through checkScope, and what it requires.
export const ROUTE_GRANTS: Record<string, ToolRequirement> = {
  "/ops/backup": "admin",
};

// A route that does not, and why. Each reason names what authorizes the request
// instead, because "public" and "authorized some other way" are different claims.
export const UNGATED_ROUTES: Record<string, string> = {
  "/health": "a liveness probe that returns provenance and store health, never a document",
  "/csp-report": "browsers post violation reports with no credential; the body is size- and type-bounded and rate-limited",
  "/ops/mcp": "resolves the caller, and every tool call it serves then passes checkScope in the registrar",
  "/improve/score": "signed with the per-namespace HMAC score key, which is the authorization, and replay-protected",
  "/improve/holdout-credential": "signed with the per-namespace HMAC score key, and mints read access to that namespace's holdout only",
  "/backup/credential": "signed with the backup-specific HMAC key, which no namespace score key can produce",
  "/ops/inbox":
    "what needs Dustin, per app (src/inbox.ts): resolveAgent on the bearer (401 without one), then each app is kept only if checkScope admits the caller's read grant on that app's namespace, so a key scoped to one namespace sees that app alone and the admin or an all-namespace read key sees every app. GET only, no CORS headers (an app's server calls it, never a browser), nothing written",
  "/ops/hooks":
    "Claude Code's HTTP hooks: resolveAgent on the bearer (401 without one), then only a driver, a runner key or the admin, and through checkScope only a caller holding the write grant on jobs (403 otherwise); each event binds to the runner key's job or the one job the driver holds claimed, and a session keeps its first binding. 64KB body cap, allowlisted fields only (src/ops-hooks.ts, caller check in src/ops-session-auth.ts)",
  "/ops/runner-key":
    "a GitHub Actions OIDC token verified against GitHub's key set, its run claims pinned against the repo as GitHub reports it, and a pending seat start; it mints a key bound to that one job (src/runner-key.ts)",
  "/ops/otlp/v1/metrics":
    "Claude Code's OTLP metrics: resolveAgent on the bearer (401 otherwise), then a driver, runner key or the admin holding write through checkScope (403 otherwise); the usage is bound to the runner key's job or the one job the driver holds claimed, never to a job the body names; points for a session another key reported first are refused (src/ops-session-auth.ts, src/ops-otlp.ts)",
  "/ops/otlp/v1/logs":
    "Claude Code's OTLP logs, counted as api_error events only: resolveAgent on the bearer and the same caller and job binding as the metrics route (src/ops-session-auth.ts)",
  "/authorize": "the OAuth authorization step, gated by the OAuth provider and the Access for SaaS login",
  "/callback": "the OAuth callback, which validates state before issuing anything",
  "/portal/callback": "Capsid Portal's Access for SaaS callback, which validates state before issuing a session",
  "/portal/api/ops": "the Portal's feed, gated by portalGate: the administrator's Access session, and a 403 for any bearer",
  "/portal/api/ops/refresh":
    "one watcher pass on demand, gated by portalGate, then a same-origin header, then a KV rate limit that fails closed",
  "/portal/api/actions/preview":
    "a Portal action's preview, which writes nothing: portalGate, a same-origin Sec-Fetch-Site, a 64KB body cap, then the X-Capsid-CSRF header against the capsid_portal_csrf cookie",
  "/portal/api/actions/perform":
    "a Portal action's perform: the preview's checks, then a token signed at preview time that binds the action, its params and the administrator's email for five minutes",
  "/portal/api/namespaces": "the Portal's per-namespace status, read through improve_status's function, gated by portalGate",
  "/portal/api/activity": "the Portal's bounded audit_log read, gated by portalGate",
  "/portal/api/claims": "the Portal's bounded read of claims, evaluations and touches, through the claims tool's readers, gated by portalGate",
  "/portal/api/packages/history": "the Portal's on-demand download history of one configured package, cached, gated by portalGate",
  "/portal/api/sign-out": "expires the Portal's own cookies, behind the preview's checks so a cross-site page cannot sign the administrator out",
  "/portal/api/*": "any other path under /portal/api/: portalGate, then a JSON 404, so the app's page is never served as data",
  "/portal": "Capsid Portal's page, served from ASSETS only after portalGate admits the administrator's session",
  "/portal/*": "Capsid Portal's files and client routes, served from ASSETS only after portalGate admits the administrator's session",
};

// The refusal for a gated route, or null. The same checkScope the tools use.
export function routeRefusal(path: string, agent: Agent): string | null {
  const requirement = Object.hasOwn(ROUTE_GRANTS, path) ? ROUTE_GRANTS[path] : "admin";
  return checkScope(agent, { tool: path, ...needFor(requirement) });
}

export interface ScopeNeed {
  tool: string;
  // The action, for a tool whose action decides what it does. Present means the tools
  // axis may narrow this call to the actions it names (allowsToolAction).
  action?: string;
  // The namespace this call touches. `undefined` means the call names none, which is
  // not the same as "allowed" (see namespaceRefusal).
  namespace?: string;
  // The resolved repo, "owner/name", never the selector the caller passed.
  //
  // The `repo` argument is a selector: a label ("primary", "legacy") or a full
  // owner/name that the namespace maps. The repos axis holds owner/name entries, so
  // comparing the selector to the axis gets both directions wrong: the legitimate
  // label "primary" is refused, and omitting the argument (almost every call) skips
  // the axis while resolveRepo picks the namespace primary. Resolve first, then ask.
  repo?: string;
  // The document path a call names, for the one exception to the namespace axis: a
  // read of a portfolio document in capsid (portfolioReadAdmits).
  path?: string;
  grant?: AgentGrant;
  // The caller must be the admin identity, not merely hold the write grant. Set by
  // the registrar for a tool whose TOOL_GRANTS entry is "admin".
  admin?: boolean;
  // Flags whose absence refuses the call. Every one is checked, and the refusal
  // names the FIRST missing one.
  flags?: readonly ScopeFlag[];
  // The job id a jobs call names, for a caller bound to one job (boundJobRefusal).
  jobId?: string;
}

// What a key bound to one job may do with the queue. The work actions need that job's
// id; list may read the queue but not name another job; everything else, including an
// action added later, is refused, so a new action is closed to a runner until listed.
const BOUND_WORK_ACTIONS: readonly string[] = ["claim", "heartbeat", "complete", "fail", "block", "resume"];

// capsid/research/design-seat-session-hardening.md, section 2b. A runner that could
// claim a second job would be choosing its own work, and one that could post or start
// could hand itself more.
function boundJobRefusal(agent: Agent, action: string, jobId: string | undefined): string | null {
  const job = agent.job as string;
  const refusal = `unauthorized: ${agent.actor} is bound to job ${job} and may work that job only`;
  if (action === "list") return jobId === undefined || jobId === job ? null : `${refusal}; it cannot list ${jobId}.`;
  if (!BOUND_WORK_ACTIONS.includes(action)) return `${refusal}; it cannot ${action}.`;
  if (jobId !== job) return `${refusal}; this call names ${jobId ?? "no job"}.`;
  return null;
}

// Why a flag is needed, so a refusal tells the caller what to ask for.
const FLAG_REASON: Record<ScopeFlag, string> = {
  can_merge: "merging a pull request can trigger a deploy on a repo that deploys on push",
  can_direct_write: "a direct-mode commit lands on the default branch with no review",
  can_dispatch: "dispatching a workflow spends CI minutes and runs code with that repo's secrets in scope",
  can_write_workflows: "a workflow is what MEASURES the code, and a caller that can edit its own measurements has none",
  can_touch_protected: "a protected path is tests, CI, lint or compiler config, a lockfile, a manifest, the agent steering layer, or a migration",
  money_paths: "the path names a billing or payment surface",
  can_comment_pr: "commenting on a pull request writes to a repo, and a reviewer that may comment must not thereby be able to merge or close",
};

// Order is deliberate: tool, grant, admin, namespace, repo, flags. A caller that
// cannot use the tool is told that, not that its namespace is out of scope, which
// would leak which namespaces exist.
export function checkScope(agent: Agent, need: ScopeNeed): string | null {
  const scopes = agent.scopes;
  if (!allowsToolAction(scopes.tools, need.tool, need.action)) {
    // Name the qualified tool.action that failed. A caller told it is not scoped to
    // 'jobs' after being minted with jobs in its list would look for the wrong bug.
    const asked = need.action === undefined ? need.tool : `${need.tool}.${need.action}`;
    return `unauthorized: ${agent.actor} is not scoped to the '${asked}' tool. Its tool scope is ${describeScope(scopes.tools)}.`;
  }
  // Binds every jobs call that names an action: the registrar's check, which runs
  // before every handler, and the jobs handler's own re-checks (src/tools/jobs.ts),
  // which name the action too. So every caller that names an action must also name
  // the call's id, or a bound key reads as naming no job. That omission refused every
  // claim in the first two hardened canary runs. A check with no action (the namespace
  // re-checks in src/jobs-schema.ts) is not bound here.
  if (agent.job && need.tool === "jobs" && need.action !== undefined) {
    const bound = boundJobRefusal(agent, need.action, need.jobId);
    if (bound) return bound;
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
  if (need.namespace !== undefined && !allowsScope(scopes.namespaces, need.namespace) && !portfolioReadAdmits(need)) {
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

// The one exception to the namespace axis (src/portfolio-docs.ts): any caller may read
// the portfolio documents in capsid, because every driver is told to follow them. Only a
// read tool on the list, so a write, a job or an edge never crosses. `read` must name an
// allowlisted path. list, find and search name none: they are admitted here and their
// handlers drop every capsid row that is not on the list (portfolioOnly).
function portfolioReadAdmits(need: ScopeNeed): boolean {
  if (need.namespace !== PORTFOLIO_DOCS.namespace) return false;
  if (!isPortfolioTool(need.tool) || requiredGrant(need.tool) !== "read") return false;
  if (need.grant !== undefined && need.grant !== "read") return false;
  if (need.admin || need.flags?.length) return false;
  if (need.tool === "read") return need.path !== undefined && isPortfolioPath(need.path);
  return true;
}

/** Whether this caller reaches `namespace` only through the portfolio exception, so a
 *  listing handler must keep only the portfolio documents. */
export function portfolioOnly(agent: Agent, namespace: string | undefined): boolean {
  return namespace === PORTFOLIO_DOCS.namespace && !allowsScope(agent.scopes.namespaces, namespace);
}

// Why each admin-only thing is admin only, for the refusal. An "admin" requirement
// with no entry here fails the test that reads this table.
const ADMIN_REASON: Record<string, string> = {
  register_namespace:
    "It edits the namespace-to-repo mapping, which is the authorization boundary every repo call resolves through, so a scoped caller that could edit it could widen itself.",
  update_namespace:
    "It edits the namespace-to-repo mapping, which is the authorization boundary every repo call resolves through, so a scoped caller that could edit it could widen itself.",
  delete_namespace:
    "It removes a namespace's repo mapping, which is the authorization boundary every repo call resolves through, and with cascade every live document in it, so a scoped caller that could use it could delete the boundary it sits behind.",
  agents: "It mints, re-scopes and revokes agents, so a scoped caller that could use it could widen itself.",
  claims:
    "It reads every agent's claims, the Worker's checks of them and every human touch, across every namespace, which is wider than any one caller's scope.",
  ops_snapshot:
    "It reads the watcher's last pass: every site's probes and uptime, every roster repo's CI and each site's Cloudflare deploys and errors, across every namespace, which is wider than any one caller's scope.",
  improve_run:
    "That action controls the loop rather than doing its work: mode switches it off, pause stops a namespace, budget moves the spend ceiling, mint_operator_key issues a credential, and sign_policy decides whether this Worker may merge without a human, so a caller that could sign one could widen itself. A driver takes its lease with action 'claim' and runs with action 'run'.",
  controls:
    "It runs the administrator's controls (pause the loop, revoke an agent, resume or fail a job, edit the sites and packages the Portal watches), each of which changes what other callers may do or see, so a scoped caller that could use one could widen itself.",
  cloudflare_config:
    "It reads the Cloudflare account's Access applications and policies and its Email Routing rules and addresses, which gate and route every namespace's site, so it is wider than any one caller's scope.",
  "/ops/backup": "It backs up and prunes every namespace in the store, which is wider than any one namespace's scope.",
};

function adminReason(tool: string): string {
  return Object.hasOwn(ADMIN_REASON, tool) ? ADMIN_REASON[tool] : "It acts on more than one namespace's scope.";
}

// The improve override is itself scoped: `allow_improve_paths`, which lets a document
// write reach the improve loop's control surface (its runs, prompts, skills and
// anchors), needs these flags. The document tools check this list; it is named here so
// the flag vocabulary stays inside the enforcement point.
export const IMPROVE_OVERRIDE_FLAGS = ["can_touch_protected"] as const;

// The same shape as fail() in tools/docs.ts, spelled here so the enforcement point
// does not import the tool modules it guards (a cycle).
function deny(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// An omitted namespace means "every namespace" on tools such as list, search, find,
// improve_status and jobs list. For a caller scoped to "*" that changes nothing. For a
// narrowed caller it would be a hole with no check in it, invisible because the tool
// works. So a namespace-restricted caller that omits it is refused and told to name
// it. Whether a tool takes a namespace is read from its own input schema, so a tool
// that gains the argument is covered without anybody remembering to add it.
function namespaceRefusal(agent: Agent, tool: string): string | null {
  if (agent.scopes.namespaces === "*") return null;
  return (
    `unauthorized: ${agent.actor} is scoped to ${describeScope(agent.scopes.namespaces)}, so it must name a namespace on '${tool}'. ` +
    `Omitting it asks for every namespace, which is wider than this caller's scope.`
  );
}

interface RegisteredConfig {
  inputSchema?: Record<string, unknown>;
}

type ToolHandler = (...args: unknown[]) => unknown;

// Which argument names what a tool is asked to do. lint spells it `mode`, because its
// modes separate a read (gather) from two writes. The registrar needs this to populate
// need.action, and a per-tool answer scattered across the handlers leaves the
// qualifier unwired. A tool absent here cannot be narrowed below the tool name. `mode` on
// write, write_repo_file and delete_repo_file is not an action: it already decides a
// flag (can_direct_write), and one setting should not have two authorities.
const ACTION_ARG: Record<string, string> = {
  agents: "action",
  claims: "action",
  cloudflare_config: "action",
  controls: "action",
  delete_namespace: "action",
  improve_run: "action",
  jobs: "action",
  lint: "mode",
  manage_pr: "action",
};

// The action a tool falls back to when the caller omits an optional one, so a
// narrowed list does not refuse the tool's own default. Every handler default needs
// an entry: an unknown action on a narrowed tool is refused (allowsToolAction), so an
// agent minted ["lint", "lint.gather"] would be refused its own default mode if the
// registrar saw no action where the handler reads "gather".
// test/audit-2026-09-16.test.ts derives the required entries from the served schemas:
// an action argument a tool marks optional is a handler default.
const DEFAULT_ACTION: Record<string, string> = { claims: "aggregate", improve_run: "run", lint: "gather" };

/** The action a call means when the caller omits the argument, or undefined. */
export function defaultActionFor(tool: string): string | undefined {
  return Object.hasOwn(DEFAULT_ACTION, tool) ? DEFAULT_ACTION[tool] : undefined;
}

export function actionArgFor(tool: string): string | undefined {
  return Object.hasOwn(ACTION_ARG, tool) ? ACTION_ARG[tool] : undefined;
}

// The action this call asks for, read off the tool's own declared argument so an
// unrelated property spelled "action" cannot narrow it.
function actionOf(tool: string, config: RegisteredConfig, args: Record<string, unknown>): string | undefined {
  const key = actionArgFor(tool);
  if (!key) return undefined;
  if (!config?.inputSchema || !Object.hasOwn(config.inputSchema, key)) return undefined;
  const value = args[key];
  if (typeof value === "string") return value;
  return defaultActionFor(tool);
}

// The registrar gate. Wraps the registration method once, before any tool module
// runs, so every registration that follows is guarded whether or not its author
// thought about scopes. A new tool cannot forget it, because a tool has to be
// registered to exist.
//
// It wraps the server rather than replacing the call sites so every registration
// stays a literal call on the server object, which test/invariants.test.ts,
// test/tool-annotations.test.ts and test/counts.test.ts parse by that spelling. This
// module must never spell that call itself, or those scanners would count it.
export function guardRegistrations(server: McpServer, agent: Agent, observe?: AdminWriteObserver): void {
  const original = server.registerTool.bind(server) as (name: string, config: unknown, handler: ToolHandler) => unknown;
  const patched = (name: string, config: RegisteredConfig, handler: ToolHandler) => {
    const takesNamespace = Boolean(config?.inputSchema && Object.hasOwn(config.inputSchema, "namespace"));
    const guarded: ToolHandler = (...callArgs: unknown[]) => {
      const args = (callArgs[0] ?? {}) as Record<string, unknown>;
      const namespace = typeof args.namespace === "string" ? args.namespace : undefined;
      // Only a full owner/name can be compared to the axis here; the repo tools
      // resolve a label and check the result (scopedRepo in src/tools/repo.ts).
      const selector = typeof args.repo === "string" ? args.repo : undefined;
      const repo = selector?.includes("/") ? selector : undefined;
      const action = actionOf(name, config, args);
      const refusal = checkScope(agent, {
        tool: name,
        namespace,
        repo,
        path: typeof args.path === "string" ? args.path : undefined,
        action,
        jobId: name === "jobs" && typeof args.id === "string" ? args.id : undefined,
        // An "action" tool outside TOOL_ACTION_GRANTS (jobs, lint) is checked by its
        // handler, where the namespace is known, so the registrar names no grant.
        ...needFor(requiredForAction(name, action)),
      });
      if (refusal) return deny(refusal);
      if (takesNamespace && namespace === undefined) {
        const missing = namespaceRefusal(agent, name);
        if (missing) return deny(missing);
      }
      // Observation only (src/admin-client-audit.ts): after every refusal above, before
      // the handler, and only for the admin and a requirement that is not a plain read.
      // "action" tools (jobs, lint) are included, so a jobs list is recorded too: more
      // than a write, never less.
      if (observe && agent.admin && requiredForAction(name, action) !== "read") {
        return observe({ tool: name, action, namespace }, server.server.getClientVersion()?.name ?? null).then((refusal) =>
          refusal ? deny(refusal) : handler(...callArgs)
        );
      }
      return handler(...callArgs);
    };
    return original(name, config, guarded);
  };
  (server as unknown as { registerTool: unknown }).registerTool = patched;
}

// Money paths: a repo path that names a billing or payment surface, matched by name.
// A tripwire, not an authorization boundary. Broad on purpose and portfolio-wide: a
// false positive costs one refusal naming the flag, a false negative is a payment
// file edited by a credential nobody scoped for it. A word separator counts as a
// boundary, so `stripe-client.ts` trips it (and so would `subscription-less.ts`).
const MONEY_PATH = /(^|\/)(billing|payments?|checkout|invoices?|pricing|subscriptions?|stripe|payouts?|refunds?)(\/|[-_.]|$)/i;

export function isMoneyPath(path: string): boolean {
  return MONEY_PATH.test(path);
}

// Every flag a repo mutation needs, derived from the call, in one function so the
// repo write tools cannot each decide a different answer.
export function repoWriteFlags(
  tool: string,
  args: { path?: string; mode?: string; action?: string; allow_workflow_write?: boolean; force?: boolean }
): ScopeFlag[] {
  const flags: ScopeFlag[] = [];
  if (args.mode === "direct") flags.push("can_direct_write");
  if (args.allow_workflow_write === true) flags.push("can_write_workflows");
  // close deletes the head branch, so a plain write grant could destroy the only copy
  // of a branch somebody else pushed. That is the same blast radius as merge, so it
  // needs can_merge too. Not deleting on close would leave stale branches behind.
  if (tool === "manage_pr" && (args.action === "merge" || args.action === "close")) flags.push("can_merge");
  // A forced branch delete too: force lifts the open-PR refusal, so it could delete
  // another agent's open PR head. A delete without force needs no flag.
  if (tool === "delete_branch" && args.force === true) flags.push("can_merge");
  // Separate from can_merge so the reviewer role can comment without merging.
  if (tool === "manage_pr" && args.action === "comment") flags.push("can_comment_pr");
  if (tool === "ci_dispatch") flags.push("can_dispatch");
  // The same protected list the improve loop enforces (src/improve-schema.ts), not a
  // second copy. Those paths are what measure a repo: its tests, CI, lint and compiler
  // config, lockfiles and manifests, agent steering layer and migrations. The loop may
  // never touch them; a scoped caller may, holding this flag.
  if (args.path && protectedHits([args.path]).length > 0) flags.push("can_touch_protected");
  if (args.path && isMoneyPath(args.path)) flags.push("money_paths");
  return flags;
}
