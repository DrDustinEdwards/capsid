import type { Env } from "./env";
import { readBoundedText } from "./improve-scorer";
import { resolveSessionCaller } from "./ops-session-auth";

// The hook receiver: POST /ops/hooks. Claude Code's HTTP hooks post each event's input
// JSON here (docs/hooks.md), and this keeps a SUMMARY of each session in agent_sessions
// and a trimmed row per event in session_events (migrations/0025).
//
// What is kept is an allowlist, never a denylist: every stored value is named below,
// read off the body by key, checked against a pattern or capped in length. A hook body
// also carries the prompt, the last assistant message, tool input and output, and the
// transcript path; none of those is read, so none can reach D1. The one exception is
// StopFailure's last_assistant_message, which on that event is the API error string,
// kept capped at 300 characters.
//
// The answer is 200 with an empty body, so Claude Code counts the hook a success and
// never parses a decision out of it. Every refusal is non-2xx, which Claude Code shows
// as a non-blocking error.
//
// Authorization: resolveSessionCaller (src/ops-session-auth.ts), the one caller check
// this route shares with the OTLP receiver. The bearer resolves through resolveAgent,
// and only three callers are admitted: a driver, a runner (a session key, bound to its
// job), or the admin for testing. It is a route, not a tool, and src/scope.ts lists it among
// the routes gated some other way.

export const OPS_HOOKS_PATH = "/ops/hooks";
// A hook body is a few hundred bytes of metadata plus whatever prompt or message the
// event carries, which is read by nobody here. 64KB refuses a body that is trying to
// be something else.
export const HOOK_MAX_BYTES = 65_536;
// session_events older than this are pruned, a bounded batch per call.
const EVENT_RETENTION_DAYS = 30;
const PRUNE_BATCH = 50;

// The six events docs/hooks.md configures. Any other event is refused with 400, so a
// hook pointed here by mistake is visible instead of silently dropped.
export const HOOK_EVENTS = ["SessionStart", "Notification", "StopFailure", "ConfigChange", "SessionEnd", "Stop"] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

// A Notification of one of these types means the session is waiting on a person.
export const NEEDS_INPUT_TYPES: readonly string[] = [
  "agent_needs_input",
  "permission_prompt",
  "idle_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
];

// StopFailure errors a person has to act on. The feed shows a session stopped on one
// as an incident, decided when the feed is read; no job is posted.
export const INCIDENT_FAILURES: readonly string[] = [
  "rate_limit",
  "billing_error",
  "authentication_failed",
  "account_on_hold",
  "oauth_org_not_allowed",
];
// A session waiting on a person for longer than this is an incident too.
export const NEEDS_INPUT_INCIDENT_MS = 10 * 60_000;

// A type word: notification_type, StopFailure's error, a source or a reason. Claude
// Code's values are all lowercase snake case; one that is not is stored as null.
const TOKEN = /^[a-z][a-z0-9_]{0,39}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PERMISSION_MODE = /^[A-Za-z]{1,32}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/[\]-]{0,99}$/;

export interface ParsedHook {
  session_id: string;
  event: HookEventName;
  // The event's type word (see migrations/0025, session_events.subtype).
  subtype: string | null;
  // JSON of the allowlisted, capped fields, or null.
  detail: string | null;
  permission_mode: string | null;
  source: string | null;
  model: string | null;
  notification_type: string | null;
  // 1 sets needs_input, 0 clears it, null leaves it.
  needs_input: 0 | 1 | null;
  // StopFailure's error, which becomes last_failure.
  failure: string | null;
  // A Stop, which is a turn that ended normally, clears last_failure.
  clears_failure: boolean;
  // SessionEnd ends the session; a SessionStart (a resume) reopens it.
  end_mode: "end" | "reopen" | "keep";
  end_reason: string | null;
}

export type HookParse = { ok: true; hook: ParsedHook } | { ok: false; refusal: string };

/** A string field, control characters folded to spaces and capped, or null. */
function capped(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean.length === 0 ? null : clean.slice(0, max);
}

function matching(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function detailJson(fields: Record<string, string | null>): string | null {
  const kept = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));
  return Object.keys(kept).length === 0 ? null : JSON.stringify(kept);
}

/** A hook body to the summary this receiver stores. Reads named keys only. */
export function parseHook(raw: string): HookParse {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, refusal: "the body is not JSON: a Claude Code HTTP hook posts its input JSON" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, refusal: "the body is not a JSON object" };
  const input = body as Record<string, unknown>;
  const sessionId = matching(input.session_id, SESSION_ID);
  if (!sessionId) return { ok: false, refusal: "the body carries no usable session_id" };
  const name = input.hook_event_name;
  if (typeof name !== "string" || !(HOOK_EVENTS as readonly string[]).includes(name)) {
    return { ok: false, refusal: `hook_event_name must be one of ${HOOK_EVENTS.join(", ")}; this receiver records no other event` };
  }
  const event = name as HookEventName;
  const hook: ParsedHook = {
    session_id: sessionId,
    event,
    subtype: null,
    detail: null,
    permission_mode: matching(input.permission_mode, PERMISSION_MODE),
    source: null,
    model: null,
    notification_type: null,
    // Any event other than a Notification means the session moved on.
    needs_input: 0,
    failure: null,
    clears_failure: false,
    end_mode: "keep",
    end_reason: null,
  };
  switch (event) {
    case "SessionStart":
      hook.source = matching(input.source, TOKEN);
      hook.subtype = hook.source;
      hook.model = matching(input.model, MODEL);
      hook.end_mode = "reopen";
      break;
    case "Notification": {
      const type = matching(input.notification_type, TOKEN);
      hook.notification_type = type;
      hook.subtype = type;
      hook.needs_input = type !== null && NEEDS_INPUT_TYPES.includes(type) ? 1 : type === "agent_completed" ? 0 : null;
      hook.detail = detailJson({ title: capped(input.title, 120), message: capped(input.message, 300) });
      break;
    }
    case "StopFailure":
      // An error word this receiver does not know is still a failure; it is kept as
      // "unknown", Claude Code's own catch-all, rather than dropped.
      hook.failure = matching(input.error, TOKEN) ?? "unknown";
      hook.subtype = hook.failure;
      // On this event last_assistant_message is the API error string, not model output.
      hook.detail = detailJson({ error: capped(input.last_assistant_message, 300) });
      break;
    case "ConfigChange":
      hook.subtype = matching(input.source, TOKEN);
      hook.detail = detailJson({ file_path: capped(input.file_path, 300) });
      break;
    case "SessionEnd":
      hook.end_reason = matching(input.reason, TOKEN) ?? "other";
      hook.subtype = hook.end_reason;
      hook.end_mode = "end";
      break;
    case "Stop":
      hook.clears_failure = true;
      break;
  }
  return { ok: true, hook };
}

// The job an event belongs to, as resolveSessionCaller bound it.
export interface HookBinding {
  job_id: string;
  namespace: string;
}

/** The three writes for one event, in one batch: the session upsert (RETURNING, so a
 *  session another key reported first is seen as no row), the event row copied through
 *  the session so it carries the session's bound job, and a bounded prune.
 *
 *  A session keeps the job it was first bound to (COALESCE on job_id). The upsert only
 *  updates a row whose agent is this caller, so one key cannot mark another's session
 *  waiting or ended. */
export function hookStatements(db: D1Database, actor: string, binding: HookBinding | null, hook: ParsedHook, now: Date): D1PreparedStatement[] {
  const at = now.toISOString();
  const cutoff = new Date(now.getTime() - EVENT_RETENTION_DAYS * 86_400_000).toISOString();
  return [
    db
      .prepare(
        `INSERT INTO agent_sessions (session_id, agent, job_id, namespace, source, model, permission_mode, started_at,
           last_event_at, last_event, last_notification_type, needs_input, last_failure, ended_at, end_reason, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?10, COALESCE(?11, 0), ?12,
           CASE ?13 WHEN 'end' THEN ?8 ELSE NULL END, ?14, ?8)
         ON CONFLICT(session_id) DO UPDATE SET
           job_id = COALESCE(agent_sessions.job_id, excluded.job_id),
           namespace = COALESCE(agent_sessions.namespace, excluded.namespace),
           source = COALESCE(excluded.source, agent_sessions.source),
           model = COALESCE(excluded.model, agent_sessions.model),
           permission_mode = COALESCE(excluded.permission_mode, agent_sessions.permission_mode),
           last_event_at = excluded.last_event_at,
           last_event = excluded.last_event,
           last_notification_type = COALESCE(excluded.last_notification_type, agent_sessions.last_notification_type),
           needs_input = COALESCE(?11, agent_sessions.needs_input),
           last_failure = CASE WHEN ?12 IS NOT NULL THEN ?12 WHEN ?15 = 1 THEN NULL ELSE agent_sessions.last_failure END,
           ended_at = CASE ?13 WHEN 'end' THEN ?8 WHEN 'reopen' THEN NULL ELSE agent_sessions.ended_at END,
           end_reason = CASE ?13 WHEN 'end' THEN ?14 WHEN 'reopen' THEN NULL ELSE agent_sessions.end_reason END,
           updated_at = excluded.updated_at
         WHERE agent_sessions.agent = excluded.agent
         RETURNING session_id`
      )
      .bind(
        hook.session_id,
        actor,
        binding?.job_id ?? null,
        binding?.namespace ?? null,
        hook.source,
        hook.model,
        hook.permission_mode,
        at,
        hook.event,
        hook.notification_type,
        hook.needs_input,
        hook.failure,
        hook.end_mode,
        hook.end_reason,
        hook.clears_failure ? 1 : 0
      ),
    db
      .prepare(
        `INSERT INTO session_events (session_id, job_id, agent, event, subtype, detail, at)
         SELECT session_id, job_id, agent, ?3, ?4, ?5, ?6 FROM agent_sessions WHERE session_id = ?1 AND agent = ?2`
      )
      .bind(hook.session_id, actor, hook.event, hook.subtype, hook.detail, at),
    // The oldest PRUNE_BATCH rows by id, of which those past retention go. Bounded
    // whatever the table holds: rows are appended in time order, so the expired ones
    // are the lowest ids, and a table with none expired costs one short index walk.
    db
      .prepare(
        `DELETE FROM session_events WHERE id IN (SELECT id FROM session_events ORDER BY id LIMIT ?1) AND at < ?2`
      )
      .bind(PRUNE_BATCH, cutoff),
  ];
}

function textResponse(message: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "no-store", ...extra } });
}

export async function handleOpsHooks(request: Request, env: Env, ctx: ExecutionContext | null, now: Date = new Date()): Promise<Response> {
  // 401 with realm capsid-hooks, or 403 for a caller that is not a driver, a runner or
  // the admin, or that holds no write grant.
  const caller = await resolveSessionCaller(request, env, now);
  if (caller instanceof Response) return caller;
  // Bounded at the stream, in bytes, before the parse (see handleCspReport in routes.ts).
  const bounded = await readBoundedText(request, HOOK_MAX_BYTES);
  if (!bounded.ok) return textResponse(`the hook body exceeds ${HOOK_MAX_BYTES} bytes`, 413);
  const parsed = parseHook(bounded.text);
  if (!parsed.ok) return textResponse(parsed.refusal, 400);

  const binding: HookBinding | null = caller.job_id && caller.namespace ? { job_id: caller.job_id, namespace: caller.namespace } : null;
  const [session] = await env.DB.batch(hookStatements(env.DB, caller.agent.actor, binding, parsed.hook, now));
  if ((session.results ?? []).length === 0) {
    return textResponse(`session ${parsed.hook.session_id} was first reported by another key, so this event was not recorded`, 409);
  }
  // last_seen is not part of authorizing; see handleOperatorMcp.
  if (ctx) ctx.waitUntil(caller.touch());
  else await caller.touch();
  return new Response(null, { status: 200 });
}
