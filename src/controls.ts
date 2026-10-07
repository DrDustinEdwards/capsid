import { adminAgentForEmail } from "./agents";
import { revokeAgent } from "./agents-admin";
import { agentActor } from "./agents-schema";
import { hmacHex, timingSafeEqual } from "./auth";
import { sourceAddress } from "./portal-auth";
import { b64urlDecode, b64urlEncode } from "./encoding";
import type { Env } from "./env";
import { improveControl } from "./improve-run";
import { breakerState, resetBreaker } from "./job-breaker";
import { addPackage, describePackage, editPackage, readPackageRow, removePackage, validatePackage } from "./ops-packages";
import { IMPROVE_MODES, onRoster, pausedKey, ROSTER } from "./improve-schema";
import { pausedReason, readMode } from "./improve-state";
import { adminFailJob, releaseJob, resumeJob } from "./jobs";
import { resumeDestination } from "./jobs-seat";
import { readJob } from "./jobs-transition";
import { addSite, describeSite, editSite, readSiteRow, removeSite, validateSite, type SiteInput } from "./ops-sites";
import type { PortalAction } from "./ops-types";
import { decisionFor, OVERNIGHT_MODE_KEY, overnightState, overnightValueRefusal, setOvernight, type OvernightMode } from "./overnight";
import { SEAT_START_KEY, seatStartState, setSeatStart } from "./seat-start";
import { auditStatement } from "./store-guards";

// THE CONTROLS' CORE (capsid/research/design-portal-full-controls.md, section 2): what each
// admin control is, what it will do, the one dispatch to the shared mutators, and the
// signed confirmation both surfaces use. It was the body of src/portal-actions.ts; the
// Portal's routes there and the `controls` tool (src/tools/controls.ts) are its two
// callers, so a control is implemented once and parity is a property of this file.

export const TOKEN_TTL_SECONDS = 5 * 60;
// Its own context string, so this key differs from every other key derived from
// COOKIE_ENCRYPTION_KEY, and a version bump retires every outstanding token.
const TOKEN_CONTEXT = "capsid-portal-confirm:v1";

export const PORTAL_ACTIONS: readonly PortalAction[] = [
  "pause",
  "unpause",
  "mode",
  "seat_start",
  "overnight",
  "resume_job",
  "fail_job",
  "release_job",
  "revoke_agent",
  "site_add",
  "site_edit",
  "site_remove",
  "reset_breaker",
  "package_add",
  "package_edit",
  "package_remove",
];

export type ActionParams = Record<string, string | undefined>;

// The click's own audit row is `<prefix><action>`. Rows written before the move to
// /portal say console-<action>; a query across that date names both (docs/schema.md).
const CLICK_AUDIT_PREFIX = "portal-";

// The four automation switches (pause, unpause, mode, seat_start) take a reason in both
// directions, and an Undo from the Portal's result message sends the reverse change with
// undo: "true". Its click row is then `portal-undo-<action>`, so an undo reads as its
// own row, never as a fresh decision (ruled 2026-09-30, DECIDE 5).
const SWITCHES: ReadonlySet<PortalAction> = new Set<PortalAction>(["pause", "unpause", "mode", "seat_start", "overnight"]);
const UNDO_INFIX = "undo-";

/** The click row's action name: `portal-<action>`, or `portal-undo-<action>` for an Undo. */
function clickAuditAction(action: PortalAction, params: ActionParams): string {
  return `${CLICK_AUDIT_PREFIX}${params.undo === "true" ? UNDO_INFIX : ""}${action}`;
}

/** What a switch without a reason is told, at preview and again at perform. */
function switchReasonRefusal(action: PortalAction): string {
  switch (action) {
    case "pause":
      return "pause needs a reason: what you are looking at. The pause has no expiry, and the reason is what whoever unpauses it reads.";
    case "unpause":
      return "unpause needs a reason: why the loop may run for this namespace again. It is recorded in the audit row with the change.";
    case "mode":
      return "mode needs a reason: why the improve loop changes how it runs. It is recorded in the audit row with the change.";
    case "overnight":
      return "overnight needs a reason: why the overnight run goes on, off, or changes what it runs on. It is recorded in the audit row with the change.";
    default:
      return "seat_start needs a reason: why seat-started sessions go on or off. It is recorded in the audit row with the change.";
  }
}

/** What each action is about to do, naming the target, for the confirm step. */
export function describeAction(action: PortalAction, params: ActionParams): string {
  const said = describeOnce(action, params);
  return params.undo === "true" ? `Undo: ${said}` : said;
}

function describeOnce(action: PortalAction, params: ActionParams): string {
  const ns = params.namespace ?? "";
  const id = params.id ?? "";
  switch (action) {
    case "pause":
      return `Pause the improve loop for ${ns}. It stays paused until somebody unpauses it: the pause key has no expiry, deliberately.`;
    case "unpause":
      return `Unpause ${ns}. The loop will open a run for it on the next opener.`;
    case "mode":
      return `Set the improve mode to ${params.value ?? ""} for every namespace.`;
    case "seat_start":
      return params.value === "on"
        ? "Turn seat-started sessions ON. The seat may then start Claude Code sessions on GitHub's runners for queued capsid and dustinedwards jobs, billed to your subscription, up to the cap. Confirm on the Anthropic billing page after the first run that nothing was billed as API usage."
        : "Turn seat-started sessions OFF. No new session starts; one already running finishes.";
    case "overnight":
      return params.value === "off"
        ? "Turn the overnight run OFF. No scheduled run starts; one already running finishes."
        : params.value === "subscription"
          ? "Set the overnight run to run on the SUBSCRIPTION. The scheduler may then start the per-namespace drivers on your machine overnight, billed against your Max plan. This records your decision, its date and its reasoning where the switch is set."
          : "Set the overnight run to run on the API key. The scheduler refuses to start unless it authenticates with ANTHROPIC_API_KEY and no subscription token is in use. Billed per token to your Console account.";
    case "resume_job":
      return `Resume blocked job ${id}. The job moves back to claimed under the driver that blocked it, with a fresh lease, and that driver continues it. It does not move to you. If that driver already holds another claimed job, or the job was blocked by a shared identity such as your own admin session, it goes back to the queue with your approval instead, and the next free session claims it.`;
    case "release_job":
      return `Release job ${id} back to the queue. Whoever holds it loses the claim, the next free session claims it, and no outcome is recorded against the holder.`;
    case "fail_job":
      return `Mark job ${id} failed. This is the seat stepping in on a job it does not hold, and it is recorded as such.`;
    case "revoke_agent":
      return `Revoke the agent ${params.name ?? ""}. Its key stops resolving immediately. The row stays, so its audit history still reads, and the name can never be minted again.`;
    case "site_add":
      return params.origin
        ? `Add ${ns} to the sites Capsid Portal watches. The watcher probes it from its next pass.`
        : `Record that ${ns} serves no site, so the site-map check stops reporting it as unmapped.`;
    case "site_edit":
      return `Change how Capsid Portal watches ${ns}. The watcher reads the new row on its next pass.`;
    case "site_remove":
      return `Remove ${ns} from the Portal's site configuration. The watcher stops probing it on its next pass.`;
    case "reset_breaker":
      return `Reset the queue's circuit breaker for ${ns}. Jobs its drivers failed before now stop counting, so ${ns} hands out work again until the threshold is reached anew.`;
    case "package_add":
      return `Add the npm package ${params.name ?? ""} to the packages Capsid Portal watches. The watcher reads it from its next pass.`;
    case "package_edit":
      return `Change how Capsid Portal watches the package ${params.name ?? ""}. The watcher reads the new row on its next pass.`;
    case "package_remove":
      return `Remove the package ${params.name ?? ""} from the Portal. The watcher stops reading it; its weekly rows are kept.`;
  }
}

function required(params: ActionParams, field: string): string | null {
  const value = params[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// The click's own audit row, naming the admin and the address the click came from
// (sourceAddress). The shared mutators' rows do not say who asked (improveControl
// records a pause as `improve-loop`).
async function auditClick(env: Env, actor: string, source: string | null, action: PortalAction, namespace: string | null, params: object, name = `${CLICK_AUDIT_PREFIX}${action}`) {
  await env.DB.batch([auditStatement(env.DB, actor, name, namespace, null, { ...params, source_address: source })]);
}

export type ActionResult =
  // It happened. warning is set when the click's own audit row was not written.
  | { ok: true; summary: string; warning: string | null }
  // It did not happen, and why.
  | { ok: false; refusal: string };

/** One action, performed by the administrator `email`: the shared mutator the MCP tool
 *  calls, then the click's audit row. Nothing here reimplements a transition. */
export async function performAction(env: Env, email: string, source: string | null, now: Date, action: PortalAction, params: ActionParams): Promise<ActionResult> {
  const agent = adminAgentForEmail(email);
  const actor = agent.actor;
  // Set once the mutator succeeds, so the catch knows whether the action happened.
  let committed = false;
  let summary = "";
  // The switches: a reason in both directions, checked again here because the token
  // binds the params and a token signed before this rule could lack one. The reason and
  // whether this is an Undo go in the click row; the shared mutators for unpause, mode
  // and seat_start record no reason, and their contract is left as it is.
  const switchReason = SWITCHES.has(action) ? required(params, "reason") : null;
  if (SWITCHES.has(action) && !switchReason) return { ok: false, refusal: switchReasonRefusal(action) };
  const undo = params.undo === "true";
  const click = clickAuditAction(action, params);
  const switchDetail = (result: object) => ({ ...result, reason: switchReason, ...(undo ? { undo: true } : {}) });
  try {
    switch (action) {
      case "pause":
      case "unpause": {
        const namespace = required(params, "namespace");
        if (!namespace) return { ok: false, refusal: `${action} needs a namespace.` };
        const reason = switchReason ?? undefined;
        // improveControl records the reason in its improve-paused row; unpause takes none.
        const result = await improveControl(env, action, action === "pause" ? { namespace, reason, actor } : { namespace, actor });
        committed = true;
        summary = action === "pause" ? `Paused the improve loop for ${namespace}.` : `Unpaused ${namespace}.`;
        await auditClick(env, actor, source, action, namespace, switchDetail(result), click);
        break;
      }
      case "mode": {
        const value = required(params, "value");
        if (!value) return { ok: false, refusal: "mode needs a value." };
        const result = await improveControl(env, "mode", { value, actor });
        committed = true;
        summary = `Set the improve mode to ${value}.`;
        await auditClick(env, actor, source, action, null, switchDetail(result), click);
        break;
      }
      case "reset_breaker": {
        const namespace = required(params, "namespace");
        if (!namespace) return { ok: false, refusal: "reset_breaker needs a namespace." };
        const result = await resetBreaker(env, actor, now, { namespace });
        if (!result.ok) return { ok: false, refusal: result.error };
        committed = true;
        summary = `Reset the circuit breaker for ${namespace}.`;
        await auditClick(env, actor, source, action, namespace, result.state);
        break;
      }
      case "seat_start": {
        const value = required(params, "value");
        if (!value) return { ok: false, refusal: "seat_start needs a value." };
        const result = await setSeatStart(env, actor, { value });
        committed = true;
        summary = `Turned seat-started sessions ${result.enabled ? "on" : "off"}.`;
        await auditClick(env, actor, source, action, null, switchDetail(result), click);
        break;
      }
      case "overnight": {
        const value = required(params, "value");
        const bad = overnightValueRefusal(value ?? undefined);
        if (bad) return { ok: false, refusal: bad };
        const result = await setOvernight(env, actor, now, { value: value ?? undefined, reason: switchReason ?? undefined });
        committed = true;
        summary = result.mode === "off" ? "Turned the overnight run off." : `Set the overnight run to run on ${result.mode === "api" ? "the API key" : "the subscription"}.`;
        await auditClick(env, actor, source, action, null, switchDetail({ mode: result.mode, ...(result.decision ? { decision: result.decision } : {}) }), click);
        break;
      }
      case "resume_job":
      case "release_job":
      case "fail_job": {
        const id = required(params, "id");
        const reason = required(params, "reason");
        if (!id) return { ok: false, refusal: `${action} needs a job id.` };
        if (!reason) {
          return {
            ok: false,
            refusal:
              action === "resume_job"
                ? "resume needs a reason: what you approved. A job that came back off a gate with no record of who cleared it is a gate that did not happen."
                : action === "release_job"
                  ? "release needs a reason: why the holder is not coming back."
                  : "fail needs a reason. A failed job with no reason is one nobody can retry or rule on.",
          };
        }
        const result =
          action === "resume_job"
            ? await resumeJob(env, agent, now, id, reason)
            : action === "release_job"
              ? await releaseJob(env, agent, now, id, reason)
              : await adminFailJob(env, agent, now, id, reason);
        if (!result.ok) return { ok: false, refusal: result.refusal ?? `${action} was refused.` };
        committed = true;
        summary =
          action === "resume_job"
            ? result.job?.status === "queued"
              ? `Resumed ${id}; it went back to the queue. ${result.note ?? ""}`.trim()
              : `Resumed ${id}; it is claimed again by ${result.job?.claimed_by ?? "its claimant"}.`
            : action === "release_job"
              ? `Released ${id} back to the queue.`
              : `Marked ${id} failed.`;
        await auditClick(env, actor, source, action, result.job?.namespace ?? null, { id, reason });
        break;
      }
      case "revoke_agent": {
        const name = required(params, "name");
        if (!name) return { ok: false, refusal: "revoke_agent needs an agent name." };
        const result = await revokeAgent(env.DB, actor, name);
        if (!result.ok) return { ok: false, refusal: result.refusal ?? `revoking ${name} was refused.` };
        committed = true;
        summary = `Revoked the agent ${name}.`;
        await auditClick(env, actor, source, action, null, { name });
        break;
      }
      case "site_add":
      case "site_edit":
      case "site_remove": {
        // Checked again here, not only at preview: the token binds the params, and the
        // rules could have changed under a token signed before a deploy.
        let result;
        if (action === "site_remove") {
          const revision = revisionOf(params.revision);
          if (!params.namespace || revision === null) return { ok: false, refusal: "site_remove needs a namespace and the revision it previewed." };
          result = await removeSite(env.DB, actor, params.namespace, revision);
        } else {
          const checked = validateSite(params);
          if (!checked.ok) return { ok: false, refusal: checked.refusal };
          if (action === "site_add") {
            result = await addSite(env.DB, actor, checked.site);
          } else {
            const revision = revisionOf(params.revision);
            if (revision === null) return { ok: false, refusal: "site_edit needs the revision it previewed." };
            result = await editSite(env.DB, actor, checked.site, revision);
          }
        }
        if (!result.ok) return { ok: false, refusal: result.refusal };
        committed = true;
        summary =
          action === "site_add"
            ? `Added ${result.site.namespace}: ${describeSite(result.site)}.`
            : action === "site_edit"
              ? `Changed ${result.site.namespace}: ${describeSite(result.site)}.`
              : `Removed ${result.site.namespace} from the site configuration.`;
        await auditClick(env, actor, source, action, result.site.namespace, params);
        break;
      }
      case "package_add":
      case "package_edit":
      case "package_remove": {
        // Checked again here, as the site controls are: the token binds the params, not
        // the rules they were checked against.
        let result;
        if (action === "package_remove") {
          const revision = revisionOf(params.revision);
          if (!params.name || revision === null) return { ok: false, refusal: "package_remove needs a name and the revision it previewed." };
          result = await removePackage(env.DB, actor, params.name, revision);
        } else {
          const checked = validatePackage(params);
          if (!checked.ok) return { ok: false, refusal: checked.refusal };
          if (action === "package_add") {
            result = await addPackage(env.DB, actor, checked.pkg);
          } else {
            const revision = revisionOf(params.revision);
            if (revision === null) return { ok: false, refusal: "package_edit needs the revision it previewed." };
            result = await editPackage(env.DB, actor, checked.pkg, revision);
          }
        }
        if (!result.ok) return { ok: false, refusal: result.refusal };
        committed = true;
        summary =
          action === "package_add"
            ? `Added ${describePackage(result.pkg)}.`
            : action === "package_edit"
              ? `Changed ${result.pkg.name}: ${describePackage(result.pkg)}.`
              : `Removed ${result.pkg.name} from the packages.`;
        await auditClick(env, actor, source, action, null, params);
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (committed) {
      // The action happened; only the Portal's own audit row failed, so no refusal.
      const warning = `${action} completed, but the Portal audit row naming ${actor} was not written: ${message}`;
      console.error(warning);
      return { ok: true, summary, warning };
    }
    // improveControl throws on a bad value, with a message that says so.
    return { ok: false, refusal: message };
  }
  return { ok: true, summary, warning: null };
}


export const UNKNOWN_ACTION = (action: string) =>
  `unknown Portal action '${action}'. The Portal does: ${PORTAL_ACTIONS.join(", ")}. Merging a pull request and minting a credential are deliberately not among them: a merge can start a deploy and stays behind can_merge, and a mint hands out a key.`;

export function isPortalAction(value: unknown): value is PortalAction {
  return typeof value === "string" && (PORTAL_ACTIONS as readonly string[]).includes(value);
}

// The params each action takes. Anything else is refused rather than carried into a
// token nobody reads.
const FIELDS: Record<PortalAction, readonly string[]> = {
  pause: ["namespace", "reason", "undo"],
  unpause: ["namespace", "reason", "undo"],
  mode: ["value", "reason", "undo"],
  seat_start: ["value", "reason", "undo"],
  overnight: ["value", "reason", "undo"],
  resume_job: ["id", "reason"],
  release_job: ["id", "reason"],
  fail_job: ["id", "reason"],
  revoke_agent: ["name"],
  site_add: ["namespace", "name", "origin", "health_path", "platform", "script"],
  site_edit: ["namespace", "revision", "name", "origin", "health_path", "platform", "script"],
  site_remove: ["namespace", "revision"],
  reset_breaker: ["namespace"],
  package_add: ["name", "repo", "formerly"],
  package_edit: ["name", "revision", "repo", "formerly"],
  package_remove: ["name", "revision"],
};


/** The action's params from a preview body: only the fields it takes, each a string,
 *  trimmed, blanks dropped. */
export function paramsFrom(action: PortalAction, raw: unknown): { ok: true; params: Record<string, string> } | { ok: false; refusal: string } {
  if (raw === undefined) raw = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, refusal: "params must be an object of strings." };
  const allowed = FIELDS[action];
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.includes(key)) {
      return { ok: false, refusal: `${action} takes ${allowed.join(" and ")}; '${key}' is not one of them.` };
    }
    if (typeof value !== "string") return { ok: false, refusal: `${action}'s ${key} must be a string.` };
    if (value.trim()) params[key] = value.trim();
  }
  return { ok: true, params };
}

export type Plan = { ok: true; changes: string[]; audit: string[] } | { ok: false; refusal: string };

/** A revision param as a positive integer, or null. */
function revisionOf(raw: string | undefined): number | null {
  if (!raw || !/^[1-9][0-9]{0,9}$/.test(raw)) return null;
  return Number(raw);
}

const SITE_FIELDS = ["name", "origin", "health_path", "platform", "script"] as const;

function shown(value: string | null): string {
  return value === null ? "(none)" : `"${value}"`;
}

const refused = (refusal: string): Plan => ({ ok: false, refusal });

function rosterRefusal(action: "pause" | "unpause" | "reset_breaker", namespace: string | undefined): string | null {
  if (!namespace) return `${action} needs a namespace.`;
  if (namespace === "all") {
    return `the Portal acts on one namespace at a time, so "all" is refused here. Do each of ${ROSTER.join(", ")} in turn.`;
  }
  if (!onRoster(namespace)) return `'${namespace}' is not on the improve roster (${ROSTER.join(", ")}).`;
  return null;
}

/** What the action will change, read from the state now. Reads only: no D1 write and
 *  no KV put, which test/portal-actions.test.ts asserts for every action. */
export async function planAction(env: Env, email: string, action: PortalAction, p: Record<string, string>): Promise<Plan> {
  const actor = adminAgentForEmail(email).actor;
  const click = `${clickAuditAction(action, p)} by ${actor}`;
  if (p.undo !== undefined && p.undo !== "true") return refused(`${action}'s undo is "true" or absent; got '${p.undo}'.`);
  switch (action) {
    case "pause": {
      const bad = rosterRefusal(action, p.namespace);
      if (bad) return refused(bad);
      if (!p.reason) return refused(switchReasonRefusal(action));
      const current = await pausedReason(env.APP_KV, p.namespace);
      return {
        ok: true,
        changes: [
          current === null
            ? `${pausedKey(p.namespace)} is set to "${p.reason}", with no expiry. The loop opens no run for ${p.namespace} until it is unpaused.`
            : `${pausedKey(p.namespace)} already holds "${current}"; it is replaced with "${p.reason}", with no expiry.`,
        ],
        audit: [`improve-paused by ${actor}`, click],
      };
    }
    case "reset_breaker": {
      const bad = rosterRefusal(action, p.namespace);
      if (bad) return refused(bad);
      const state = await breakerState(env, p.namespace, new Date());
      return {
        ok: true,
        changes: [
          state.open
            ? `The breaker for ${p.namespace} is OPEN: ${state.failed} holder fails since ${state.since} UTC, at or over the threshold of ${state.threshold}. After the reset only failures from now count, and ${p.namespace} hands out work again.`
            : `The breaker for ${p.namespace} is closed (${state.failed} of ${state.threshold} holder fails since ${state.since} UTC). The reset moves its window to now.`,
        ],
        audit: [`job-breaker-reset by ${actor}`, click],
      };
    }
    case "unpause": {
      const bad = rosterRefusal(action, p.namespace);
      if (bad) return refused(bad);
      if (!p.reason) return refused(switchReasonRefusal(action));
      const current = await pausedReason(env.APP_KV, p.namespace);
      return {
        ok: true,
        changes: [
          current === null
            ? `${p.namespace} is not paused: ${pausedKey(p.namespace)} is already absent, so the delete changes nothing.`
            : `${pausedKey(p.namespace)} ("${current}") is deleted. The next opener may open a run for ${p.namespace}.`,
        ],
        audit: [`improve-unpaused by ${actor}`, click],
      };
    }
    case "mode": {
      if (!p.value || !(IMPROVE_MODES as readonly string[]).includes(p.value)) {
        return refused(`mode must be one of ${IMPROVE_MODES.join(", ")}; got '${p.value ?? ""}'.`);
      }
      if (!p.reason) return refused(switchReasonRefusal(action));
      const current = await readMode(env.APP_KV);
      return {
        ok: true,
        changes: [
          current.mode === p.value
            ? `improve_mode is already ${p.value}; it is written again unchanged.`
            : `improve_mode: ${current.mode} -> ${p.value}, for every namespace.${current.reason ? ` (It reads ${current.mode} now because ${current.reason}.)` : ""}`,
        ],
        audit: [`improve-mode-set by ${actor}`, click],
      };
    }
    case "seat_start": {
      if (p.value !== "on" && p.value !== "off") return refused(`seat_start must be "on" or "off"; got '${p.value ?? ""}'.`);
      if (!p.reason) return refused(switchReasonRefusal(action));
      const state = await seatStartState(env);
      const current = state.enabled ? "on" : "off";
      return {
        ok: true,
        changes: [
          current === p.value ? `${SEAT_START_KEY} is already ${p.value}; it is written again unchanged.` : `${SEAT_START_KEY}: ${current} -> ${p.value}.`,
          `The cap stays at ${state.max_sessions} session${state.max_sessions === 1 ? "" : "s"} in flight.`,
        ],
        audit: [`seat-start-set by ${actor}`, click],
      };
    }
    case "overnight": {
      const bad = overnightValueRefusal(p.value);
      if (bad) return refused(bad);
      if (!p.reason) return refused(switchReasonRefusal(action));
      const state = await overnightState(env);
      const value = p.value as OvernightMode;
      const decision = decisionFor(value, actor, new Date(), p.reason);
      return {
        ok: true,
        changes: [
          state.mode === value ? `${OVERNIGHT_MODE_KEY} is already ${value}; it is written again unchanged.` : `${OVERNIGHT_MODE_KEY}: ${state.mode} -> ${value}.`,
          ...(decision
            ? [
                `Recorded with the switch: the decision of ${decision.decided_by} on ${decision.decided_on}, "${decision.ruling}".`,
                `Reasoning recorded: ${decision.reasoning}`,
                "Hand-started VS Code tabs are unaffected and stay the default.",
              ]
            : value === "api"
              ? ["The scheduler will refuse to start a run unless it authenticates with ANTHROPIC_API_KEY and no subscription token is in use."]
              : ["No scheduled run starts. Hand-started VS Code tabs are unaffected."]),
        ],
        audit: [`overnight-set by ${actor}`, click],
      };
    }
    case "resume_job":
    case "release_job":
    case "fail_job": {
      if (!p.id) return refused(`${action} needs a job id.`);
      if (!p.reason) return refused(`${action} needs a reason. It is recorded in the audit row, and a transition with no reason is one nobody can review.`);
      const job = await readJob(env.DB, p.id);
      if (!job) return refused(`no job ${p.id}.`);
      const label = `${job.id} ('${job.title}' in ${job.namespace})`;
      if (action === "resume_job") {
        if (job.status !== "blocked") {
          return refused(`${job.id} is ${job.status}, not blocked. Resume is how a job comes back off a gate; a queued job is claimed and a done or failed one is finished.`);
        }
        const holder = job.claimed_by || actor;
        const { toQueue } = await resumeDestination(env.DB, holder, job.id, false);
        return {
          ok: true,
          changes: [
            toQueue
              ? `${label}: blocked -> queued, claimed by nobody. The resume records why: ${toQueue}`
              : `${label}: blocked -> claimed by ${holder}, with a fresh lease. ${holder} continues it; it does not move to you.`,
            `resumed_count: ${job.resumed_count} -> ${job.resumed_count + 1}.`,
            `Your approval "${p.reason}" is recorded in the resume note the next holder reads.`,
          ],
          audit: [`job-resumed by ${actor}`, click],
        };
      }
      if (action === "release_job") {
        if (job.status !== "claimed") {
          return refused(`${job.id} is ${job.status}, not claimed. Release returns a claimed job to the queue; a blocked job is resumed, a queued one is already free, and a finished one is not reopened.`);
        }
        if (job.claimed_by === actor) return refused(`${job.id} is held by ${actor} itself. A holder ends its own claim with fail or block.`);
        return {
          ok: true,
          changes: [
            `${label}: claimed by ${job.claimed_by} -> queued, claimed by nobody.`,
            `${job.claimed_by}'s lease${job.lease_expires ? ` (until ${job.lease_expires})` : ""} ends, any key bound to ${job.id} is revoked, and no outcome is recorded against ${job.claimed_by}.`,
          ],
          audit: [`job-released by ${actor}`, click],
        };
      }
      if (job.status !== "queued" && job.status !== "claimed" && job.status !== "blocked") {
        return refused(`${job.id} is already ${job.status}; there is nothing to fail.`);
      }
      return {
        ok: true,
        changes: [
          `${label}: ${job.status}${job.claimed_by ? ` (held by ${job.claimed_by})` : ""} -> failed, with the reason "${p.reason}".`,
          job.claimed_by
            ? `An outcome row records the failure against ${job.claimed_by}, and any key bound to ${job.id} is revoked.`
            : `Nobody held it, so no outcome row is written; any key bound to ${job.id} is revoked.`,
        ],
        audit: [`job-admin-fail by ${actor}`, click],
      };
    }
    case "site_add": {
      const checked = validateSite(p);
      if (!checked.ok) return refused(checked.refusal);
      const site = checked.site;
      const registered = await env.DB.prepare("SELECT namespace FROM namespaces WHERE namespace = ?1").bind(site.namespace).first<{ namespace: string }>();
      if (!registered) return refused(`'${site.namespace}' is not a registered namespace. Register it first; a site row for an unregistered namespace is drift the watcher reports.`);
      const existing = await readSiteRow(env.DB, site.namespace);
      if (existing) return refused(`${site.namespace} already has a row (${describeSite(existing)}). Edit it instead.`);
      return {
        ok: true,
        changes: [
          `ops_sites: add ${site.namespace}, ${describeSite(site)}.`,
          site.origin
            ? `The watcher probes it from its next pass, and the Sites view lists it.`
            : `Nothing is probed for ${site.namespace}; the site-map check counts it as decided.`,
        ],
        audit: [`ops-site-added by ${actor}`, click],
      };
    }
    case "site_edit": {
      const revision = revisionOf(p.revision);
      if (revision === null) return refused("site_edit needs the revision of the row it edits.");
      const checked = validateSite(p);
      if (!checked.ok) return refused(checked.refusal);
      const site: SiteInput = checked.site;
      const before = await readSiteRow(env.DB, site.namespace);
      if (!before) return refused(`${site.namespace} has no row to edit. Add it instead.`);
      if (before.revision !== revision) return refused(`${site.namespace} changed since you opened it (revision ${before.revision}, not ${revision}). Reload and edit again.`);
      const diffs = SITE_FIELDS.filter((f) => before[f] !== site[f]).map((f) => `${f}: ${shown(before[f])} -> ${shown(site[f])}`);
      if (diffs.length === 0) return refused(`the edit changes nothing in ${site.namespace}.`);
      const changes = [`ops_sites ${site.namespace}, revision ${revision} -> ${revision + 1}:`, ...diffs.map((d) => `  ${d}`)];
      if (before.self_probe && before.origin !== site.origin) changes.push("The origin changes, so the in-process self-probe is cleared and the site is probed over HTTP.");
      return { ok: true, changes, audit: [`ops-site-edited by ${actor}`, click] };
    }
    case "site_remove": {
      const revision = revisionOf(p.revision);
      if (!p.namespace || revision === null) return refused("site_remove needs a namespace and the revision of the row it removes.");
      const before = await readSiteRow(env.DB, p.namespace);
      if (!before) return refused(`${p.namespace} has no row to remove.`);
      if (before.revision !== revision) return refused(`${p.namespace} changed since you opened it (revision ${before.revision}, not ${revision}). Reload and try again.`);
      const registered = await env.DB.prepare("SELECT namespace FROM namespaces WHERE namespace = ?1").bind(p.namespace).first<{ namespace: string }>();
      return {
        ok: true,
        changes: [
          `ops_sites: remove ${p.namespace} (${describeSite(before)}). The row is kept in the audit row.`,
          before.origin ? `The watcher stops probing ${before.origin}, and its uptime ring leaves the next pass.` : `Nothing was probed for it.`,
          ...(registered ? [`${p.namespace} is still registered, so the site-map check reports it as unmapped until it has a row again.`] : []),
        ],
        audit: [`ops-site-removed by ${actor}`, click],
      };
    }
    case "package_add": {
      const checked = validatePackage(p);
      if (!checked.ok) return refused(checked.refusal);
      const existing = await readPackageRow(env.DB, checked.pkg.name);
      if (existing) return refused(`${checked.pkg.name} is already configured (${describePackage(existing)}). Edit it instead.`);
      return {
        ok: true,
        changes: [
          `ops_packages: add ${describePackage(checked.pkg)}.`,
          "The watcher reads it from its next pass: about nine requests to npm, deps.dev and GitHub per pass. The Packages view appears once a package is configured.",
        ],
        audit: [`ops-package-added by ${actor}`, click],
      };
    }
    case "package_edit": {
      const revision = revisionOf(p.revision);
      if (revision === null) return refused("package_edit needs the revision of the row it edits.");
      const checked = validatePackage(p);
      if (!checked.ok) return refused(checked.refusal);
      const before = await readPackageRow(env.DB, checked.pkg.name);
      if (!before) return refused(`${checked.pkg.name} is not configured. Add it instead.`);
      if (before.revision !== revision) return refused(`${checked.pkg.name} changed since you opened it (revision ${before.revision}, not ${revision}). Reload and edit again.`);
      const diffs = (["repo", "formerly"] as const).filter((k) => before[k] !== checked.pkg[k]).map((k) => `  ${k}: ${shown(before[k])} -> ${shown(checked.pkg[k])}`);
      if (diffs.length === 0) return refused(`the edit changes nothing in ${checked.pkg.name}.`);
      return {
        ok: true,
        changes: [`ops_packages ${checked.pkg.name}, revision ${revision} -> ${revision + 1}:`, ...diffs],
        audit: [`ops-package-edited by ${actor}`, click],
      };
    }
    case "package_remove": {
      const revision = revisionOf(p.revision);
      if (!p.name || revision === null) return refused("package_remove needs a name and the revision of the row it removes.");
      const before = await readPackageRow(env.DB, p.name);
      if (!before) return refused(`${p.name} is not configured.`);
      if (before.revision !== revision) return refused(`${p.name} changed since you opened it (revision ${before.revision}, not ${revision}). Reload and try again.`);
      return {
        ok: true,
        changes: [`ops_packages: remove ${describePackage(before)}. The row is kept in the audit row, and its weekly GitHub rows stay.`],
        audit: [`ops-package-removed by ${actor}`, click],
      };
    }
    case "revoke_agent": {
      if (!p.name) return refused("revoke_agent needs an agent name.");
      const agent = await env.DB.prepare("SELECT name, kind, revoked_at FROM agents WHERE name = ?1")
        .bind(p.name)
        .first<{ name: string; kind: string; revoked_at: string | null }>();
      if (!agent) return refused(`no agent named '${p.name}'.`);
      if (agent.revoked_at) return refused(`'${p.name}' was already revoked at ${agent.revoked_at}.`);
      // Bounded: a live agent holds one claim by rule, so the limit is a guard, not a page.
      const { results } = await env.DB.prepare(
        `SELECT id, title, namespace, status FROM jobs WHERE claimed_by = ?1 AND status IN ('claimed', 'blocked') ORDER BY id LIMIT 50`
      )
        .bind(agentActor(p.name))
        .all<{ id: string; title: string; namespace: string; status: string }>();
      const held = results ?? [];
      return {
        ok: true,
        changes: [
          `agent ${p.name} (${agent.kind}): live -> revoked. Its key stops resolving on the next request, and the name can never be minted again.`,
          held.length === 0
            ? `It holds no claimed or blocked job.`
            : `It holds ${held.length} job${held.length === 1 ? "" : "s"}, which stay as they are until released or failed: ${held
                .map((j) => `${j.id} (${j.status}, '${j.title}' in ${j.namespace})`)
                .join("; ")}.`,
        ],
        audit: [`agent-revoked by ${actor}`, click],
      };
    }
  }
}

// The confirmation token: base64url of the canonical claims, a dot, and the hex
// HMAC-SHA256 of that base64url text under the derived key.
export interface ConfirmClaims {
  v: 1;
  action: PortalAction;
  params: Record<string, string>;
  email: string;
  exp: number;
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/;

function canonical(claims: ConfirmClaims): string {
  const params: Record<string, string> = {};
  for (const key of Object.keys(claims.params).sort()) params[key] = claims.params[key];
  return JSON.stringify({ v: claims.v, action: claims.action, params, email: claims.email, exp: claims.exp });
}

async function confirmKey(env: Env): Promise<string> {
  // Fails closed: with no root secret there is nothing to sign with, and an empty key
  // would sign with a value anybody knows.
  if (!env.COOKIE_ENCRYPTION_KEY) throw new Error("COOKIE_ENCRYPTION_KEY is unset, so no confirmation can be signed or checked");
  return hmacHex(env.COOKIE_ENCRYPTION_KEY, TOKEN_CONTEXT);
}

export async function signConfirm(env: Env, claims: ConfirmClaims): Promise<string> {
  const payload = b64urlEncode(canonical(claims));
  return `${payload}.${await hmacHex(await confirmKey(env), payload)}`;
}

export type Verified = { ok: true; claims: ConfirmClaims } | { ok: false; status: number; refusal: string };

export async function verifyConfirm(env: Env, token: string, email: string, now: Date): Promise<Verified> {
  if (!TOKEN_SHAPE.test(token)) return { ok: false, status: 403, refusal: "the confirmation token is malformed: preview again." };
  const dot = token.indexOf(".");
  const payload = token.slice(0, dot);
  if (!timingSafeEqual(token.slice(dot + 1), await hmacHex(await confirmKey(env), payload))) {
    return { ok: false, status: 403, refusal: "the confirmation token does not verify: preview again." };
  }
  let claims: ConfirmClaims;
  try {
    claims = JSON.parse(b64urlDecode(payload)) as ConfirmClaims;
  } catch (err) {
    // Signed by this Worker and unreadable: a defect, said so.
    return { ok: false, status: 403, refusal: `the confirmation token verifies but does not parse (${err instanceof Error ? err.message : String(err)}): preview again.` };
  }
  const paramsOk =
    claims && typeof claims.params === "object" && claims.params !== null && Object.values(claims.params).every((v) => typeof v === "string");
  if (claims?.v !== 1 || typeof claims.email !== "string" || typeof claims.exp !== "number" || !paramsOk) {
    return { ok: false, status: 403, refusal: "the confirmation token verifies but its claims are not the shape this Worker signs: preview again." };
  }
  if (claims.email !== email) return { ok: false, status: 403, refusal: "the confirmation was issued to another session: preview again." };
  if (claims.exp * 1000 <= now.getTime()) return { ok: false, status: 410, refusal: "the confirmation expired: preview again." };
  if (!isPortalAction(claims.action)) return { ok: false, status: 400, refusal: UNKNOWN_ACTION(String(claims.action)) };
  return { ok: true, claims };
}

