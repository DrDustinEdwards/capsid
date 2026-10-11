import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Agent } from "./agents";
import type { AdminWriteObserver } from "./admin-client-audit";
import { logEvent } from "./log";
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
// "action" means the requirement depends on the action argument. `capsid_run_improve` states
// its per-action requirements in TOOL_ACTION_GRANTS below, and the registrar reads
// them, because the requirement depends on nothing but the action. `capsid_work_jobs` (action
// list reads) and `capsid_lint_namespace` (mode gather reads) also depend on a namespace the handler resolves,
// so their handlers call checkScope at the point where both are known.
//
// "admin" is write plus the admin identity, for a tool that edits the authorization
// boundary itself or changes what other callers may do. "admin_read" is the admin
// identity with only the read grant, for an admin tool that only reads (claims, the
// operations state, what needs the seat): admin because it spans every namespace, and
// served read-only because it changes nothing (capsid/research/design-mcp-servers.md,
// section 3, which fixed claims and ops reading as not read-only). They live here, not
// in a handler, because these tools are admin-only in whole, which the registrar can
// decide from the tool name alone, and because under the one enforcement point rule
// (CLAUDE.md) this table is the one statement of what each tool requires. No handler
// decides a grant for itself.
export type ToolRequirement = "read" | "write" | "action" | "admin" | "admin_read";

// Capsid (14) and Capsid Admin (8): src/tools/surface.ts.
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
  capsid_change_repo: "write",
  capsid_open_pr: "write",
  capsid_close_pr: "write",
  capsid_run_ci: "write",
  // list reads; every other action changes the queue.
  capsid_work_jobs: "action",
  // Per action, in TOOL_ACTION_GRANTS: status reads, run and claim are a driver's work.
  capsid_run_improve: "action",

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
  // The watcher's last pass, Cloudflare Access and Email Routing, and Workers Builds.
  // It only reads, and spans every namespace's sites, CI runs and Cloudflare state.
  capsid_admin_read_ops: "admin_read",
  // The administrator's controls (preview, then perform with a signed single-use
  // token). A control pauses the loop, revokes an agent or edits a site, so a caller
  // that could use one could widen itself (capsid/decisions-vol-5.md, the controls ruling).
  capsid_admin_run_controls: "admin",
  // mode switches the whole loop off, pause stops a namespace, budget moves the spend
  // ceiling, mint_operator_key issues a credential, and sign_policy decides whether
  // this Worker may merge without a human. None of those is a driver's work.
  capsid_admin_control_improve: "admin",
  // Mints a site key and sets it on the site Worker and on Carrel.
  capsid_admin_set_site_key: "admin",
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
// (admin for capsid_run_improve), so a new action is refused to a driver until listed.
export const TOOL_ACTION_GRANTS: Record<string, { default: ToolRequirement; actions: Record<string, ToolRequirement> }> = {
  capsid_run_improve: {
    // An unlisted action is refused to a driver until listed.
    default: "admin",
    actions: {
      status: "read",
      // Taking and releasing the driver lease is what a driver does every run, and it
      // is what stops two drivers working one namespace.
      claim: "write",
      run: "write",
    },
  },
};

export function requiredForAction(tool: string, action: string | undefined): ToolRequirement {
  const spec = Object.hasOwn(TOOL_ACTION_GRANTS, tool) ? TOOL_ACTION_GRANTS[tool] : null;
  if (!spec) return requiredGrant(tool);
  if (action === undefined) return spec.default;
  return Object.hasOwn(spec.actions, action) ? spec.actions[action] : spec.default;
}

// A requirement as the part of a ScopeNeed it decides. The registrar and every route
// use this one mapping, so "admin" means the same thing wherever it is enforced.
export function needFor(requirement: ToolRequirement): Pick<ScopeNeed, "grant" | "admin"> {
  if (requirement === "admin") return { grant: "write", admin: true };
  if (requirement === "admin_read") return { grant: "read", admin: true };
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
  "/public/model/v1.json":
    "the public system model (src/public-data.ts): public by design, it serves only the document the daily build stored after toPublic filtered it (src/system-model.ts), never D1 or GitHub; GET only, edge-cached, then a per-IP KV limit that fails closed; no CORS, since site builds read it, not browsers",
  "/public/stats/v1.json":
    "the public aggregate numbers (src/public-stats.ts): counts, rates and medians over every namespace, agent and site, whole UTC days, null under ten rows, no string but a date and the sha /health shows; it serves only what the daily build stored, never D1; GET only, edge-cached, the same per-IP limit as the model, failing closed; no CORS",
  "/oauth/clients/verify-live.json": "the verify-live probe's OAuth client metadata document (src/oauth-client-docs.ts): public by nature, fetched by the authorization server with no credential, and holds no secret",
  "/csp-report": "browsers post violation reports with no credential; the body is size- and type-bounded and rate-limited",
  "/ops/mcp": "resolves the caller, and every tool call it serves then passes checkScope in the registrar",
  "/ops/mcp/admin":
    "Capsid Admin for a key: resolveAgent on the bearer (401 without one), then the admin identity only (403 for any other key), and every tool call it serves then passes checkScope in the registrar, where each tool is admin only",
  "/improve/score": "signed with the per-namespace HMAC score key, which is the authorization, and replay-protected",
  "/improve/holdout-credential": "signed with the per-namespace HMAC score key, and mints read access to that namespace's holdout only",
  "/backup/credential": "signed with the backup-specific HMAC key, which no namespace score key can produce",
  "/ops/inbox":
    "what needs Dustin, per app (src/inbox.ts): resolveAgent on the bearer (401 without one), then each app is kept only if checkScope admits the caller's read grant on that app's namespace, so a key scoped to one namespace sees that app alone and the admin or an all-namespace read key sees every app. GET only, no CORS headers (an app's server calls it, never a browser), nothing written",
  "/ops/inbox/report":
    "what an app reports about itself to the inbox (src/inbox-report.ts): resolveAgent on the bearer (401 without one), then checkScope for the write grant on the namespace the report names (403 otherwise), so a key reports for its own app alone; one report per minute per key, failing closed; at most 20 items, links on the app's own ops_sites origin only, a 16KB body cap; POST only, no CORS",
  "/ops/access-sync":
    "an app's members list made its Cloudflare Access group (src/access-sync.ts): resolveAgent on the bearer (401 without one), then checkScope for the write grant on the namespace the body names (403 otherwise); the group is never named by the caller but read from access_sync_groups for that namespace, and its name is checked against the pin before any write; per-key hourly and daily limits failing closed; a 64KB body cap; every call audited; POST only, no CORS",
  "/ops/hooks":
    "Claude Code's HTTP hooks: resolveAgent on the bearer (401 without one), then only a driver, a runner key or the admin, and through checkScope only a caller holding the write grant on capsid_work_jobs (403 otherwise); each event binds to the runner key's job or the one job the driver holds claimed, and a session keeps its first binding. 64KB body cap, allowlisted fields only (src/ops-hooks.ts, caller check in src/ops-session-auth.ts)",
  "/ops/runner-key":
    "a GitHub Actions OIDC token verified against GitHub's key set, its run claims pinned against the repo as GitHub reports it, and a pending seat start; it mints a key bound to that one job (src/runner-key.ts)",
  "/ops/otlp/v1/metrics":
    "Claude Code's OTLP metrics: resolveAgent on the bearer (401 otherwise), then a driver, runner key or the admin holding write through checkScope (403 otherwise); the usage is bound to the runner key's job or the one job the driver holds claimed, never to a job the body names; points for a session another key reported first are refused (src/ops-session-auth.ts, src/ops-otlp.ts)",
  "/ops/otlp/v1/logs":
    "Claude Code's OTLP logs, counted as api_error events only: resolveAgent on the bearer and the same caller and job binding as the metrics route (src/ops-session-auth.ts)",
  "/authorize": "the OAuth authorization step, gated by the OAuth provider and the Access for SaaS login",
  "/callback": "the OAuth callback, which validates state before issuing anything",
  "/register":
    "tightened Dynamic Client Registration for Grok and Gemini (src/dcr.ts): rate limited per caller and failing closed, a 16KB body cap, every redirect URI matched exactly against the allowlist; it writes a client record and grants nothing, since the client still meets the consent page and the Access sign-in",
  "/portal/callback": "Capsid Portal's Access for SaaS callback, which validates state before issuing a session",
  "/portal/api/ops": "the Portal's feed, gated by portalGate: the administrator's Access session, and a 403 for any bearer",
  "/portal/api/ops/refresh":
    "one watcher pass on demand, gated by portalGate, then a same-origin header, then a KV rate limit that fails closed",
  "/portal/api/actions/preview":
    "a Portal action's preview, which writes nothing: portalGate, a same-origin Sec-Fetch-Site, a 64KB body cap, then the X-Capsid-CSRF header against the capsid_portal_csrf cookie",
  "/portal/api/actions/perform":
    "a Portal action's perform: the preview's checks, then a token signed at preview time that binds the action, its params and the administrator's email for five minutes",
  "/portal/api/namespaces": "the Portal's per-namespace status, read through the function behind capsid_run_improve action status, gated by portalGate",
  "/portal/api/activity": "the Portal's bounded audit_log read, gated by portalGate",
  "/portal/api/claims": "the Portal's bounded read of claims, evaluations and touches, through the capsid_admin_read_claims tool's readers, gated by portalGate",
  "/portal/api/stale": "the Portal's stale jobs, through the reader behind capsid_work_jobs action list stale: true, gated by portalGate",
  "/portal/api/plan": "the Portal's Tonight plan, through the reader behind capsid_work_jobs action list view plan, over every namespace, gated by portalGate",
  "/portal/api/digest": "the Portal's since-you-last-looked strip, through the reader behind capsid_work_jobs action list view digest, over every namespace, gated by portalGate",
  "/portal/api/convergence": "the Portal's convergence view of each site that opted into its operator API: sync_status, the health route and secret names read live, gated by portalGate",
  "/portal/api/maintenance": "the Portal's Maintenance list, the daily pass's stored list that capsid_run_improve action status serves, gated by portalGate",
  "/portal/api/packages/history": "the Portal's on-demand download history of one configured package, cached, gated by portalGate",
  "/portal/api/shared-code": "the Portal's Shared code view: each configured shared package's tags and the pins in the configured sites' repos, read through the GitHub App and cached for an hour, gated by portalGate",
  "/portal/api/library": "the Portal's read-only Library: the knowledge store's shelves, a search and one document with its edges, through the readers behind capsid_find_docs and capsid_read_doc, gated by portalGate",
  "/portal/api/trends": "the Portal's trends for its charts: minutes, the queue, merges and rollbacks from D1, backup slots from R2, default-branch CI from GitHub (cached an hour), read-only, gated by portalGate",
  "/portal/api/push":
    "the Portal's phone alerts: GET lists the devices with alerts on behind portalGate; POST turns one on or off or sends a test behind the preview's checks (portalGate, same-origin, the body cap, CSRF)",
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
  // the registrar for a tool whose TOOL_GRANTS entry is "admin" or "admin_read".
  admin?: boolean;
  // The action is a risky admin action (STEP_UP): an OAuth session needs a recent
  // sign-in. Set by the registrar.
  stepUp?: boolean;
  // Flags whose absence refuses the call. Every one is checked, and the refusal
  // names the FIRST missing one.
  flags?: readonly ScopeFlag[];
  // The job id a jobs call names, for a caller bound to one job (boundJobRefusal).
  jobId?: string;
}

// What a key bound to one job may do with the queue. The work actions need that job's
// id; list may read the queue but not name another job; everything else, including an
// action added later, is refused, so a new action is closed to a runner until listed.
const BOUND_WORK_ACTIONS: readonly string[] = ["claim", "complete", "fail", "block", "resume"];

// The work queue's tool, named once: the job binding and the handlers' re-checks
// (src/tools/jobs.ts, src/jobs-schema.ts, src/ops-session-auth.ts) all ask about it.
export const JOBS_TOOL = "capsid_work_jobs";

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
    // 'capsid_work_jobs' after being minted with capsid_work_jobs in its list would look for the wrong bug.
    const asked = need.action === undefined ? need.tool : `${need.tool}.${need.action}`;
    return `unauthorized: ${agent.actor} is not scoped to the '${asked}' tool. Its tool scope is ${describeScope(scopes.tools)}.`;
  }
  // Binds every capsid_work_jobs call that names an action: the registrar's check, which runs
  // before every handler, and the jobs handler's own re-checks (src/tools/jobs.ts),
  // which name the action too. So every caller that names an action must also name
  // the call's id, or a bound key reads as naming no job. That omission refused every
  // claim in the first two hardened canary runs. A check with no action (the namespace
  // re-checks in src/jobs-schema.ts) is not bound here.
  if (agent.job && need.tool === JOBS_TOOL && need.action !== undefined) {
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
  if (need.stepUp) {
    const stale = stepUpRefusal(agent, need, Date.now());
    if (stale) return stale;
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

// STEP-UP (capsid/rulings/mcp-2026-10-10.md, the rule 9 amendment for Capsid Admin):
// the admin actions that change who may do what, or that cannot be taken back, need a
// recent Access sign-in. A grant lives for weeks and is refreshed without a person;
// this is the point where a person proves they are there. It is a re-authentication,
// not a mid-call confirmation, which the ruling's rule 12 rules out until client
// support is verified. "*" is every action of the tool.
//
// The window slides, as GitHub's sudo mode does: a step-up action is allowed when the
// Access sign-in or the last SUCCESSFUL step-up action was within STEP_UP_IDLE_MS, and
// each success resets that clock. A fixed window refused a working session mid-task.
// STEP_UP_MAX_MS caps it from the sign-in whatever the activity (NIST SP 800-63B-4
// allows an AAL3 session no more than 12 hours overall), so only a new sign-in extends
// past it.
//
// Only an OAuth session carries a sign-in time (Agent.signedInAt). A key holder (the
// seat's operator key at its terminal) has no session to refresh and is not stepped up;
// its key is the credential.
const STEP_UP_IDLE_MS = 2 * 60 * 60 * 1000;
const STEP_UP_MAX_MS = 12 * 60 * 60 * 1000;

export const STEP_UP: Record<string, readonly string[] | "*"> = {
  capsid_admin_manage_namespaces: ["register", "update", "delete_perform"],
  capsid_admin_manage_agents: ["mint", "revoke", "update_scopes"],
  capsid_admin_run_controls: ["perform"],
  capsid_admin_control_improve: "*",
  capsid_admin_set_site_key: "*",
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
const stepUpKey = (actor: string, signedInAt: number): string => `step-up:last:${actor}:${signedInAt}`;

/** The time of this session's last successful step-up action, or undefined when there
 *  is none or KV cannot say. Undefined falls back to the sign-in time alone, so a KV
 *  failure can only narrow access, never widen it; a time after `now` is refused for the
 *  same reason, since it would read as activity that has not happened. */
export async function readLastStepUp(kv: KVNamespace, actor: string, signedInAt: number, now: number = Date.now()): Promise<number | undefined> {
  try {
    const value = Number(await kv.get(stepUpKey(actor, signedInAt)));
    return Number.isFinite(value) && value > 0 && value <= now ? value : undefined;
  } catch (error) {
    logEvent("error", "STEP_UP_READ_FAILED", { message: `STEP_UP_READ_FAILED: ${error instanceof Error ? error.message : String(error)}; using the sign-in time alone` });
    return undefined;
  }
}

// Called only after a step-up action succeeded. The action is already done, so a KV
// failure is logged and never fails it; the cost is that the idle clock is not reset.
async function recordStepUp(kv: KVNamespace, agent: Agent, signedInAt: number, now: number): Promise<void> {
  agent.lastStepUpAt = now;
  try {
    await kv.put(stepUpKey(agent.actor, signedInAt), String(now), { expirationTtl: STEP_UP_MAX_MS / 1000 + 3600 });
  } catch (error) {
    logEvent("error", "STEP_UP_WRITE_FAILED", { message: `STEP_UP_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}; the action succeeded and the idle clock was not reset` });
  }
}

function stepUpRefusal(agent: Agent, need: ScopeNeed, now: number): string | null {
  if (agent.signedInAt === undefined) return null;
  const asked = need.action === undefined ? need.tool : `${need.tool}.${need.action}`;
  const rule =
    `A step-up action needs an Access sign-in or a step-up action within the last ${STEP_UP_IDLE_MS / 3600000} hours, ` +
    `and never more than ${STEP_UP_MAX_MS / 3600000} hours after the sign-in.`;
  const fix = `Reconnect the Capsid Admin connector (disconnect, then connect, and sign in), then call it again. Nothing was done.`;
  if (agent.signedInAt === null) {
    return `step-up required: '${asked}' changes who may do what or cannot be taken back. ${rule} This session signed in before sign-in times were recorded. ${fix}`;
  }
  const sinceSignIn = now - agent.signedInAt;
  const sinceActive = now - Math.max(agent.signedInAt, agent.lastStepUpAt ?? 0);
  if (sinceSignIn <= STEP_UP_MAX_MS && sinceActive <= STEP_UP_IDLE_MS) return null;
  const minutes = (ms: number): string => `${Math.round(ms / 60000)} minutes ago`;
  const why =
    sinceSignIn > STEP_UP_MAX_MS
      ? `this session signed in ${minutes(sinceSignIn)}, past the ${STEP_UP_MAX_MS / 3600000} hour cap`
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
  capsid_admin_manage_agents: "It mints, re-scopes and revokes agents, so a scoped caller that could use it could widen itself.",
  capsid_admin_read_claims:
    "It reads every agent's claims, the Worker's checks of them and every human touch, across every namespace, which is wider than any one caller's scope.",
  capsid_admin_read_ops:
    "It reads the watcher's last pass, the Cloudflare account's Access and Email Routing configuration, and every Workers Build, across every namespace, which is wider than any one caller's scope.",
  capsid_admin_run_controls:
    "It runs the administrator's controls (pause the loop, revoke an agent, resume or fail a job, edit the sites and packages the Portal watches), each of which changes what other callers may do or see, so a scoped caller that could use one could widen itself.",
  capsid_admin_control_improve:
    "It controls the loop rather than doing its work: mode switches it off, pause stops a namespace, budget moves the spend ceiling, mint_operator_key issues a credential, and sign_policy decides whether this Worker may merge without a human, so a caller that could sign one could widen itself. A driver uses capsid_run_improve.",
  capsid_admin_set_site_key: "It mints a site's operator key and sets it as a secret on the site's Worker and on Carrel, so a caller that could use it could hand itself a site's key.",
  capsid_run_improve:
    "That action controls the loop rather than doing its work, which is capsid_admin_control_improve. A driver reads with action 'status', takes its lease with 'claim' and runs with 'run'.",
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

// An omitted namespace means "every namespace" on tools such as capsid_find_docs
// (list, glob, search), capsid_run_improve action status and capsid_work_jobs action list. For a caller scoped to "*" that changes nothing. For a
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
  inputSchema?: Record<string, unknown> | z.ZodObject;
  // A composite tool's actions whose operation takes a namespace (src/tools/surface.ts).
  // The merged schema declares `namespace` when any action takes one, and an action that
  // takes none (capsid_find_docs action namespaces) must not be refused for omitting it.
  // The registrar reads it and does not pass it on.
  namespaceActions?: readonly string[];
}

type ToolHandler = (...args: unknown[]) => unknown;

// Whether a handler's result is a success. An error result is not, and neither is a
// domain refusal, which the tools return as an ordinary result whose JSON says ok:false
// (the call was legitimate and the answer was no, so nothing was done).
function toolSucceeded(result: unknown): boolean {
  const r = result as { isError?: boolean; content?: Array<{ text?: unknown }> } | null;
  if (r?.isError === true) return false;
  const text = r?.content?.[0]?.text;
  if (typeof text !== "string" || !text.startsWith("{")) return true;
  try {
    return (JSON.parse(text) as { ok?: unknown }).ok !== false;
  } catch {
    // Text that looks like JSON and is not is no proof of success: it does not reset the clock.
    return false;
  }
}

// Which argument names what a tool is asked to do. lint spells it `mode`, because its
// modes separate a read (gather) from two writes. The registrar needs this to populate
// need.action, and a per-tool answer scattered across the handlers leaves the
// qualifier unwired. A tool absent here cannot be narrowed below the tool name. `mode` on
// capsid_write_doc and capsid_change_repo is not an action: it already decides a flag
// (can_direct_write) or a write shape, and one setting should not have two authorities.
const ACTION_ARG: Record<string, string> = {
  capsid_find_docs: "action",
  capsid_read_doc: "action",
  capsid_write_doc: "action",
  capsid_lint_namespace: "mode",
  capsid_read_repo: "action",
  capsid_inspect_repo: "action",
  capsid_change_repo: "action",
  capsid_open_pr: "action",
  capsid_close_pr: "action",
  capsid_work_jobs: "action",
  capsid_run_improve: "action",
  capsid_admin_manage_namespaces: "action",
  capsid_admin_manage_agents: "action",
  capsid_admin_read_claims: "action",
  capsid_admin_read_ops: "action",
  capsid_admin_run_controls: "action",
  capsid_admin_control_improve: "action",
};

// The action a tool falls back to when the caller omits an optional one, so a
// narrowed list does not refuse the tool's own default. Every handler default needs
// an entry: an unknown action on a narrowed tool is refused (allowsToolAction), so an
// agent minted ["lint", "lint.gather"] would be refused its own default mode if the
// registrar saw no action where the handler reads "gather".
// test/audit-2026-09-16.test.ts derives the required entries from the served schemas:
// an action argument a tool marks optional is a handler default.
const DEFAULT_ACTION: Record<string, string> = {
  capsid_find_docs: "list",
  capsid_read_doc: "read",
  capsid_write_doc: "write",
  capsid_lint_namespace: "gather",
  capsid_admin_read_claims: "aggregate",
};

/** The action a call means when the caller omits the argument, or undefined. */
export function defaultActionFor(tool: string): string | undefined {
  return Object.hasOwn(DEFAULT_ACTION, tool) ? DEFAULT_ACTION[tool] : undefined;
}

export function actionArgFor(tool: string): string | undefined {
  return Object.hasOwn(ACTION_ARG, tool) ? ACTION_ARG[tool] : undefined;
}

// The action this call asks for, read off the tool's own declared argument so an
// unrelated property spelled "action" cannot narrow it.
// A tool's declared arguments: a raw shape, or the shape of a zod object (the composite
// tools, src/tools/surface.ts, register one so extra arguments reach their handler).
function declaredShape(config: RegisteredConfig): Record<string, unknown> | undefined {
  const schema = config?.inputSchema;
  if (schema instanceof z.ZodObject) return schema.shape as Record<string, unknown>;
  return schema;
}

function actionOf(tool: string, config: RegisteredConfig, args: Record<string, unknown>): string | undefined {
  const key = actionArgFor(tool);
  if (!key) return undefined;
  const shape = declaredShape(config);
  if (!shape || !Object.hasOwn(shape, key)) return undefined;
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
export function guardRegistrations(server: McpServer, agent: Agent, observe?: AdminWriteObserver, stepUpKv?: KVNamespace): void {
  const original = server.registerTool.bind(server) as (name: string, config: unknown, handler: ToolHandler) => unknown;
  const patched = (name: string, config: RegisteredConfig, handler: ToolHandler) => {
    const shape = declaredShape(config);
    const declared = Boolean(shape && Object.hasOwn(shape, "namespace"));
    const namespaceActions = config?.namespaceActions;
    const takesNamespace = (action: string | undefined): boolean =>
      namespaceActions && action !== undefined ? namespaceActions.includes(action) : declared;
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
        jobId: name === JOBS_TOOL && typeof args.id === "string" ? args.id : undefined,
        stepUp: needsStepUp(name, action),
        // An "action" tool outside TOOL_ACTION_GRANTS (jobs, lint) is checked by its
        // handler, where the namespace is known, so the registrar names no grant.
        ...needFor(requiredForAction(name, action)),
      });
      if (refusal) return deny(refusal);
      if (takesNamespace(action) && namespace === undefined) {
        const missing = namespaceRefusal(agent, name);
        if (missing) return deny(missing);
      }
      // Observation only (src/admin-client-audit.ts): after every refusal above, before
      // the handler, and only for the admin and a requirement that is not a plain read.
      // "action" tools (capsid_work_jobs, capsid_lint_namespace) are included, so a
      // capsid_work_jobs action list is recorded too: more
      // than a write, never less.
      const run = (): unknown => {
        const result = handler(...callArgs);
        // A step-up action that succeeded resets the idle clock (STEP_UP). A refused or
        // failed one does not: it proves nothing about the person being there.
        const signedInAt = agent.signedInAt;
        if (!stepUpKv || signedInAt === undefined || signedInAt === null || !needsStepUp(name, action)) return result;
        return Promise.resolve(result).then(async (value) => {
          if (toolSucceeded(value)) await recordStepUp(stepUpKv, agent, signedInAt, Date.now());
          return value;
        });
      };
      if (observe && agent.admin && requiredForAction(name, action) !== "read") {
        return observe({ tool: name, action, namespace }, server.server.getClientVersion()?.name ?? null).then((refusal) =>
          refusal ? deny(refusal) : run()
        );
      }
      return run();
    };
    const { namespaceActions: _namespaceActions, ...served } = config ?? {};
    return original(name, served, guarded);
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
  action: string | undefined,
  args: { path?: string; mode?: string; allow_workflow_write?: boolean; force?: boolean }
): ScopeFlag[] {
  const flags: ScopeFlag[] = [];
  if (args.mode === "direct") flags.push("can_direct_write");
  if (args.allow_workflow_write === true) flags.push("can_write_workflows");
  // close deletes the head branch, so a plain write grant could destroy the only copy
  // of a branch somebody else pushed. That is the same blast radius as merge, so it
  // needs can_merge too. Not deleting on close would leave stale branches behind. A tag
  // or a release can start a deploy as a merge can (capsid/rulings/mcp-2026-10-10.md,
  // amendment answer 2: "extra permission").
  if (tool === "capsid_close_pr" && (action === "merge" || action === "close" || action === "tag" || action === "release")) flags.push("can_merge");
  // A forced branch delete too: force lifts the open-PR refusal, so it could delete
  // another agent's open PR head. A delete without force needs no flag.
  if (tool === "capsid_close_pr" && action === "delete_branch" && args.force === true) flags.push("can_merge");
  // Separate from can_merge so the reviewer role can comment without merging.
  if (tool === "capsid_open_pr" && action === "comment") flags.push("can_comment_pr");
  if (tool === "capsid_run_ci") flags.push("can_dispatch");
  // The same protected list the improve loop enforces (src/improve-schema.ts), not a
  // second copy. Those paths are what measure a repo: its tests, CI, lint and compiler
  // config, lockfiles and manifests, agent steering layer and migrations. The loop may
  // never touch them; a scoped caller may, holding this flag.
  if (args.path && protectedHits([args.path]).length > 0) flags.push("can_touch_protected");
  if (args.path && isMoneyPath(args.path)) flags.push("money_paths");
  return flags;
}
