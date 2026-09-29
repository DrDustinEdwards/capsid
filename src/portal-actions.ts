import { adminAgentForEmail } from "./agents";
import { revokeAgent } from "./agents-admin";
import { agentActor } from "./agents-schema";
import { getCookie, hmacHex, timingSafeEqual } from "./auth";
import { consoleGate } from "./console";
import { ACTIVITY_LIMIT, activityFilterFrom, loadActivity } from "./console-activity";
import { b64urlDecode, b64urlEncode } from "./encoding";
import type { Env } from "./env";
import { improveControl, improveStatus } from "./improve-run";
import { IMPROVE_MODES, onRoster, pausedKey, ROSTER } from "./improve-schema";
import { IMPROVE_ACTOR, pausedReason, readMode } from "./improve-state";
import { adminFailJob, releaseJob, resumeJob } from "./jobs";
import { resumeDestination } from "./jobs-seat";
import { readJob } from "./jobs-transition";
import { readBoundedText } from "./improve-scorer";
import { isoTime, opsFeed, OPS_RETURN_TO, PORTAL_CSRF_COOKIE, type OpsFeedData } from "./ops-feed";
import type { PortalAction, PortalActivity, PortalNamespaces, PortalPerformed, PortalPreview } from "./ops-types";
import { SEAT_START_KEY, seatStartState, setSeatStart } from "./seat-start";
import { auditStatement } from "./store-guards";

// The Portal's controls: the eight actions, what each will do, the one dispatch to the
// shared mutators, and the routes the app calls (the contract is the bottom of
// src/ops-types.ts). The old page (POST /console, src/console-actions.ts) calls the
// same dispatch, so no transition is implemented twice.
//
// No merge (it can start a CI deploy, so it stays behind can_merge) and no mint (a
// mint hands out a key). test/console-actions.test.ts and test/portal-actions.test.ts
// assert both absences.
//
// Two requests per action, as ruled 2026-09-11. The preview reads the current state,
// writes nothing, and returns what will change with a signed token that carries the
// action, its params, the administrator's email and a five-minute expiry. The perform
// carries only that token. A replay inside the five minutes is allowed: every
// transition is guarded on the state it moves from, so a second perform is refused by
// the mutator or changes nothing.
//
// Every route answers to consoleGate, as the feed does. They are routes, not tools, so
// no grant is checked here (CLAUDE.md, one enforcement point rule); src/scope.ts lists
// them among the routes gated some other way.

export const PORTAL_PREVIEW_PATH = "/console/api/actions/preview";
export const PORTAL_PERFORM_PATH = "/console/api/actions/perform";
export const PORTAL_NAMESPACES_PATH = "/console/api/namespaces";
export const PORTAL_ACTIVITY_PATH = "/console/api/activity";
// The double-submit CSRF header: the feed's csrf value, compared with the
// capsid_portal_csrf cookie. A cross-site page can neither read the value nor set the
// header without a preflight this Worker does not answer.
export const PORTAL_CSRF_HEADER = "X-Capsid-CSRF";

// Same cap as the old page's form, applied at the stream before parsing.
const BODY_MAX_BYTES = 65_536;
const TOKEN_TTL_SECONDS = 5 * 60;
// Its own context string, so this key differs from every other key derived from
// COOKIE_ENCRYPTION_KEY, and a version bump retires every outstanding token.
const TOKEN_CONTEXT = "capsid-portal-confirm:v1";

export const PORTAL_ACTIONS: readonly PortalAction[] = [
  "pause",
  "unpause",
  "mode",
  "seat_start",
  "resume_job",
  "fail_job",
  "release_job",
  "revoke_agent",
];

export type ActionParams = Record<string, string | undefined>;

// The click's own audit row is `<prefix><action>`. It stays console- until the Portal
// moves to /portal, when this one line changes.
const CLICK_AUDIT_PREFIX = "console-";

/** What each action is about to do, naming the target, for the confirm step. */
export function describeAction(action: PortalAction, params: ActionParams): string {
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
    case "resume_job":
      return `Resume blocked job ${id}. The job moves back to claimed under the driver that blocked it, with a fresh lease, and that driver continues it. It does not move to you. If that driver already holds another claimed job, or the job was blocked by a shared identity such as your own admin session, it goes back to the queue with your approval instead, and the next free session claims it.`;
    case "release_job":
      return `Release job ${id} back to the queue. Whoever holds it loses the claim, the next free session claims it, and no outcome is recorded against the holder.`;
    case "fail_job":
      return `Mark job ${id} failed. This is the seat stepping in on a job it does not hold, and it is recorded as such.`;
    case "revoke_agent":
      return `Revoke the agent ${params.name ?? ""}. Its key stops resolving immediately. The row stays, so its audit history still reads, and the name can never be minted again.`;
  }
}

function required(params: ActionParams, field: string): string | null {
  const value = params[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// The click's own audit row, naming the admin. The shared mutators' rows do not say
// who asked (improveControl records a pause as `improve-loop`).
async function auditClick(env: Env, actor: string, action: PortalAction, namespace: string | null, params: unknown) {
  await env.DB.batch([auditStatement(env.DB, actor, `${CLICK_AUDIT_PREFIX}${action}`, namespace, null, params)]);
}

export type ActionResult =
  // It happened. warning is set when the click's own audit row was not written.
  | { ok: true; summary: string; warning: string | null }
  // It did not happen, and why.
  | { ok: false; refusal: string };

/** One action, performed by the administrator `email`: the shared mutator the MCP tool
 *  calls, then the click's audit row. Nothing here reimplements a transition. */
export async function performAction(env: Env, email: string, now: Date, action: PortalAction, params: ActionParams): Promise<ActionResult> {
  const agent = adminAgentForEmail(email);
  const actor = agent.actor;
  // Set once the mutator succeeds, so the catch knows whether the action happened.
  let committed = false;
  let summary = "";
  try {
    switch (action) {
      case "pause":
      case "unpause": {
        const namespace = required(params, "namespace");
        if (!namespace) return { ok: false, refusal: `${action} needs a namespace.` };
        const reason = params.reason?.trim() || undefined;
        const result = await improveControl(env, action, { namespace, reason });
        committed = true;
        summary = action === "pause" ? `Paused the improve loop for ${namespace}.` : `Unpaused ${namespace}.`;
        await auditClick(env, actor, action, namespace, result);
        break;
      }
      case "mode": {
        const value = required(params, "value");
        if (!value) return { ok: false, refusal: "mode needs a value." };
        const result = await improveControl(env, "mode", { value });
        committed = true;
        summary = `Set the improve mode to ${value}.`;
        await auditClick(env, actor, action, null, result);
        break;
      }
      case "seat_start": {
        const value = required(params, "value");
        if (!value) return { ok: false, refusal: "seat_start needs a value." };
        const result = await setSeatStart(env, actor, { value });
        committed = true;
        summary = `Turned seat-started sessions ${result.enabled ? "on" : "off"}.`;
        await auditClick(env, actor, action, null, result);
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
        await auditClick(env, actor, action, result.job?.namespace ?? null, { id, reason });
        break;
      }
      case "revoke_agent": {
        const name = required(params, "name");
        if (!name) return { ok: false, refusal: "revoke_agent needs an agent name." };
        const result = await revokeAgent(env.DB, actor, name);
        if (!result.ok) return { ok: false, refusal: result.refusal ?? `revoking ${name} was refused.` };
        committed = true;
        summary = `Revoked the agent ${name}.`;
        await auditClick(env, actor, action, null, { name });
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (committed) {
      // The action happened; only the console's own audit row failed, so no refusal.
      const warning = `${action} completed, but the console audit row naming ${actor} was not written: ${message}`;
      console.error(warning);
      return { ok: true, summary, warning };
    }
    // improveControl throws on a bad value, with a message that says so.
    return { ok: false, refusal: message };
  }
  return { ok: true, summary, warning: null };
}

// ---------------------------------------------------------------------------
// The routes.

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "no-store" } });
}

function jsonResponse(body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

const UNKNOWN_ACTION = (action: string) =>
  `unknown Portal action '${action}'. The Portal does: ${PORTAL_ACTIONS.join(", ")}. Merging a pull request and minting a credential are deliberately not among them: a merge can start a deploy and stays behind can_merge, and a mint hands out a key.`;

function isPortalAction(value: unknown): value is PortalAction {
  return typeof value === "string" && (PORTAL_ACTIONS as readonly string[]).includes(value);
}

// The params each action takes. Anything else is refused rather than carried into a
// token nobody reads.
const FIELDS: Record<PortalAction, readonly string[]> = {
  pause: ["namespace", "reason"],
  unpause: ["namespace"],
  mode: ["value"],
  seat_start: ["value"],
  resume_job: ["id", "reason"],
  release_job: ["id", "reason"],
  fail_job: ["id", "reason"],
  revoke_agent: ["name"],
};

type Gated = { ok: true; email: string; csrf: string; body: Record<string, unknown> } | { ok: false; response: Response };

/** The checks both POSTs run, in order: the session, the fetch metadata, the body cap,
 *  the CSRF pair, then the JSON. Nothing here reads or writes state. */
async function gateActionRequest(request: Request, env: Env, now: Date): Promise<Gated> {
  const gate = await consoleGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate;

  // A browser names where a request came from. Absent (an older browser, or curl with
  // the cookies) is let through to the CSRF check; any other site is refused here.
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin") {
    return {
      ok: false,
      response: textResponse(`forbidden: this request came from ${site}, not from Capsid Portal itself (Sec-Fetch-Site: ${site}). Nothing was read or changed.`, 403),
    };
  }

  const bounded = await readBoundedText(request, BODY_MAX_BYTES);
  if (!bounded.ok) return { ok: false, response: new Response(null, { status: 413, headers: { "Cache-Control": "no-store" } }) };

  const header = request.headers.get(PORTAL_CSRF_HEADER);
  const cookie = getCookie(request, PORTAL_CSRF_COOKIE);
  if (!header || !cookie || !timingSafeEqual(cookie, header)) {
    return { ok: false, response: textResponse("csrf validation failed: reload Capsid Portal and try again.", 403) };
  }

  let body: unknown;
  try {
    body = JSON.parse(bounded.text);
  } catch (err) {
    return { ok: false, response: textResponse(`the body is not JSON: ${err instanceof Error ? err.message : String(err)}`, 400) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: textResponse("the body must be a JSON object.", 400) };
  }
  return { ok: true, email: gate.user.email, csrf: cookie, body: body as Record<string, unknown> };
}

/** The action's params from a preview body: only the fields it takes, each a string,
 *  trimmed, blanks dropped. */
function paramsFrom(action: PortalAction, raw: unknown): { ok: true; params: Record<string, string> } | { ok: false; refusal: string } {
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

type Plan = { ok: true; changes: string[]; audit: string[] } | { ok: false; refusal: string };

const refused = (refusal: string): Plan => ({ ok: false, refusal });

function rosterRefusal(action: "pause" | "unpause", namespace: string | undefined): string | null {
  if (!namespace) return `${action} needs a namespace.`;
  if (namespace === "all") {
    return `the Portal ${action}s one namespace at a time, so "all" is refused here. ${action === "pause" ? "Pause" : "Unpause"} each of ${ROSTER.join(", ")} in turn.`;
  }
  if (!onRoster(namespace)) return `'${namespace}' is not on the improve roster (${ROSTER.join(", ")}).`;
  return null;
}

/** What the action will change, read from the state now. Reads only: no D1 write and
 *  no KV put, which test/portal-actions.test.ts asserts for every action. */
async function planAction(env: Env, email: string, action: PortalAction, p: Record<string, string>): Promise<Plan> {
  const actor = adminAgentForEmail(email).actor;
  const click = `${CLICK_AUDIT_PREFIX}${action} by ${actor}`;
  switch (action) {
    case "pause": {
      const bad = rosterRefusal(action, p.namespace);
      if (bad) return refused(bad);
      if (!p.reason) return refused("pause needs a reason: what you are looking at. The pause has no expiry, and the reason is what whoever unpauses it reads.");
      const current = await pausedReason(env.APP_KV, p.namespace);
      return {
        ok: true,
        changes: [
          current === null
            ? `${pausedKey(p.namespace)} is set to "${p.reason}", with no expiry. The loop opens no run for ${p.namespace} until it is unpaused.`
            : `${pausedKey(p.namespace)} already holds "${current}"; it is replaced with "${p.reason}", with no expiry.`,
        ],
        audit: [`improve-paused by ${IMPROVE_ACTOR}`, click],
      };
    }
    case "unpause": {
      const bad = rosterRefusal(action, p.namespace);
      if (bad) return refused(bad);
      const current = await pausedReason(env.APP_KV, p.namespace);
      return {
        ok: true,
        changes: [
          current === null
            ? `${p.namespace} is not paused: ${pausedKey(p.namespace)} is already absent, so the delete changes nothing.`
            : `${pausedKey(p.namespace)} ("${current}") is deleted. The next opener may open a run for ${p.namespace}.`,
        ],
        audit: [`improve-unpaused by ${IMPROVE_ACTOR}`, click],
      };
    }
    case "mode": {
      if (!p.value || !(IMPROVE_MODES as readonly string[]).includes(p.value)) {
        return refused(`mode must be one of ${IMPROVE_MODES.join(", ")}; got '${p.value ?? ""}'.`);
      }
      const current = await readMode(env.APP_KV);
      return {
        ok: true,
        changes: [
          current.mode === p.value
            ? `improve_mode is already ${p.value}; it is written again unchanged.`
            : `improve_mode: ${current.mode} -> ${p.value}, for every namespace.${current.reason ? ` (It reads ${current.mode} now because ${current.reason}.)` : ""}`,
        ],
        audit: [`improve-mode-set by ${IMPROVE_ACTOR}`, click],
      };
    }
    case "seat_start": {
      if (p.value !== "on" && p.value !== "off") return refused(`seat_start must be "on" or "off"; got '${p.value ?? ""}'.`);
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
interface ConfirmClaims {
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

async function signConfirm(env: Env, claims: ConfirmClaims): Promise<string> {
  const payload = b64urlEncode(canonical(claims));
  return `${payload}.${await hmacHex(await confirmKey(env), payload)}`;
}

type Verified = { ok: true; claims: ConfirmClaims } | { ok: false; status: number; refusal: string };

async function verifyConfirm(env: Env, token: string, email: string, now: Date): Promise<Verified> {
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

/** POST /console/api/actions/preview: what the action will change, and a token to
 *  perform it. Writes nothing. */
export async function handlePortalPreview(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gated = await gateActionRequest(request, env, now);
  if (!gated.ok) return gated.response;
  const { action } = gated.body;
  if (!isPortalAction(action)) return textResponse(UNKNOWN_ACTION(String(action ?? "")), 400);
  const parsed = paramsFrom(action, gated.body.params);
  if (!parsed.ok) return textResponse(parsed.refusal, 400);

  const plan = await planAction(env, gated.email, action, parsed.params);
  if (!plan.ok) return textResponse(plan.refusal, 400);

  const exp = Math.floor(now.getTime() / 1000) + TOKEN_TTL_SECONDS;
  const token = await signConfirm(env, { v: 1, action, params: parsed.params, email: gated.email, exp });
  const preview: PortalPreview = {
    action,
    summary: describeAction(action, parsed.params),
    changes: plan.changes,
    audit: plan.audit,
    token,
    expires_at: new Date(exp * 1000).toISOString(),
  };
  return jsonResponse(preview);
}

// What the perform can be handed in a test in place of the live feed read.
export interface PortalDeps {
  feed?: (env: Env, now: Date) => Promise<OpsFeedData>;
}

/** POST /console/api/actions/perform: the action a preview signed, run through the
 *  shared mutator, then the fresh feed. */
export async function handlePortalPerform(request: Request, env: Env, now: Date = new Date(), deps: PortalDeps = {}): Promise<Response> {
  const gated = await gateActionRequest(request, env, now);
  if (!gated.ok) return gated.response;
  const extra = Object.keys(gated.body).filter((key) => key !== "token");
  if (extra.length) {
    return textResponse(
      `a perform carries only { token }: the action and its params come from the signed preview, never from this body. Refused: ${extra.join(", ")}.`,
      400
    );
  }
  const { token } = gated.body;
  if (typeof token !== "string") return textResponse("a perform needs the token its preview returned.", 400);

  const verified = await verifyConfirm(env, token, gated.email, now);
  if (!verified.ok) return textResponse(verified.refusal, verified.status);
  const { action, params } = verified.claims;

  const result = await performAction(env, gated.email, now, action, params);
  if (!result.ok) return textResponse(result.refusal, 400);

  let data: OpsFeedData;
  try {
    data = await (deps.feed ?? opsFeed)(env, now);
  } catch (err) {
    // The action happened; only the read after it failed. Said as a failure of the
    // read, never as a failure of the action.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`PORTAL_PERFORM_FEED_FAILED ${action}: ${message}`);
    return textResponse(`${result.summary} It completed, but reading the feed afterwards failed (${message}). Reload Capsid Portal.`, 500);
  }
  const performed: PortalPerformed = { action, summary: result.summary, warning: result.warning, feed: { ...data, csrf: gated.csrf } };
  // A header value must be printable Latin-1; the error text is not guaranteed to be.
  return jsonResponse(performed, result.warning ? { "X-Capsid-Warning": result.warning.replace(/[^\x20-\x7e]+/g, " ") } : {});
}

/** GET /console/api/namespaces: every roster namespace as improve_status reports it,
 *  from the same function, so the Portal and the tool agree (ruled 2026-09-11). */
export async function handlePortalNamespaces(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await consoleGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  const status = await improveStatus(env);
  const body: PortalNamespaces = {
    generated: now.toISOString(),
    namespaces: status.namespaces.map((ns) => ({
      namespace: ns.namespace,
      paused: ns.paused,
      anchor_pinned: ns.anchor_pinned,
      anchor_problem: ns.anchor_problem,
      best: ns.best,
      last_run: ns.last_run
        ? { status: ns.last_run.status, started: ns.last_run.started, attempts: ns.last_run.attempts, kept: ns.last_run.kept, reverts: ns.last_run.reverts }
        : null,
      totals: ns.totals,
      latest_report: ns.latest_report ? { integrity: ns.latest_report.integrity, generated: ns.latest_report.generated } : null,
      jobs: { queued: ns.jobs.queued, claimed: ns.jobs.claimed, blocked: ns.jobs.blocked, done_today: ns.jobs.done_today },
      skills: ns.skills,
    })),
  };
  return jsonResponse(body);
}

/** GET /console/api/activity?namespace=&actor=: the old page's activity read. */
export async function handlePortalActivity(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await consoleGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  const filter = activityFilterFrom(new URL(request.url));
  const rows = await loadActivity(env.DB, filter);
  const body: PortalActivity = {
    generated: now.toISOString(),
    filter,
    rows: rows.map((row) => ({ ...row, at: isoTime(row.at) })),
    limit: ACTIVITY_LIMIT,
  };
  return jsonResponse(body);
}
