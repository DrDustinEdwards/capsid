import type { Env } from "./env";
import type { Agent } from "./agents";
import { jobDocPath, outsideJobNamespace, startedNotice, type JobRow } from "./jobs-schema";
import { jobAudit, mirrorStatements } from "./jobs-mirror";
import { callerIsSeat, guardedTransition, readJob, refuse, type JobResult } from "./jobs-transition";
import { verifySignedBody } from "./improve-task";
import { auditStatement } from "./store-guards";
import { logEvent } from "./log";
import { redactText } from "./redact";

// CAPSID STARTS A SESSION ITSELF (job_a7d6f6009242, docs/routines.md). One Claude Code
// routine serves every namespace, created by Dustin at claude.ai/code/routines on Opus,
// with only the Capsid connection through the network secret. Its API trigger is a
// per-routine URL and bearer token. The seat fires it for one queued job, and the
// routine's prompt reads the job id from the routine-fire-payload block the fire text
// arrives in. Nothing here claims the job: the session works it without a claim, and the
// fire marks it started (the label begin sets, src/jobs-begin.ts) so the next session and
// the next fire are told somebody is on it.
//
// Where each piece lives: the fire URL in APP_KV (`routine:<namespace>:url`), set by the
// seat with capsid_work_jobs action "routine", because it is not a secret and a new
// routine should not need a deploy; the token as a Worker secret, ROUTINE_<NS>_TOKEN,
// set by Dustin with `npx wrangler secret put`, read by name and never returned.
//
// One routine for every namespace (job_77b45a741ddc): the seat sets the same fire URL on
// each namespace, and Dustin sets one token. A namespace's own ROUTINE_<NS>_TOKEN wins;
// otherwise the token falls back to the secret of any namespace whose stored fire URL
// names the same routine id. A different routine id never borrows a token, and only the
// secret's name is ever reported or audited, never its value.

export const routineUrlKey = (namespace: string) => `routine:${namespace}:url`;

/** The Worker secret holding a namespace's routine token: ROUTINE_<NS>_TOKEN, dashes as underscores. */
export const routineTokenName = (namespace: string) => `ROUTINE_${namespace.toUpperCase().replace(/-/g, "_")}_TOKEN`;

function routineToken(env: Env, namespace: string): string | null {
  const value = (env as unknown as Record<string, unknown>)[routineTokenName(namespace)];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// The token a fire for this namespace sends, and the name of the secret it came from. The
// namespace's own secret wins. Otherwise, when the namespace's fire URL names a routine,
// the secret of another namespace whose stored fire URL names the same routine is used,
// in namespace order so the answer is deterministic. A token is lent only from a
// namespace the caller may act in, so a seat held to one namespace never fires with
// another's credential. A different routine id never borrows.
async function resolveRoutineToken(env: Env, agent: Agent, namespace: string, routineId: string | null): Promise<{ secret: string; value: string } | null> {
  const own = routineToken(env, namespace);
  if (own !== null) return { secret: routineTokenName(namespace), value: own };
  if (routineId === null) return null;
  const rows = (await env.DB.prepare("SELECT namespace FROM namespaces ORDER BY namespace").all<{ namespace: string }>()).results ?? [];
  for (const { namespace: other } of rows) {
    if (other === namespace || !ROUTINE_NAMESPACE.test(other) || outsideJobNamespace(agent, other)) continue;
    const value = routineToken(env, other);
    if (value === null) continue;
    const url = await env.APP_KV.get(routineUrlKey(other));
    if (url && routineIdOf(url) === routineId) return { secret: routineTokenName(other), value };
  }
  return null;
}

const namespaceRefusal = (action: string, namespace: string) =>
  refuse(action, `${namespace} cannot have a routine: a routine's namespace is lowercase letters and digits joined by single dashes, so its token secret names it alone.`);

// The one shape a fire URL takes (platform.claude.com/docs/en/api/claude-code/routines-fire,
// read 2026-10-11). Anything else is refused, so the token is only ever sent to Anthropic.
const FIRE_URL = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/(trig_[A-Za-z0-9]{8,64})\/fire$/;

// The headers the fire endpoint takes. The beta header is still accepted and named in the
// job, so it is sent; anthropic-version 2023-06-01 is the only value the endpoint accepts.
const ANTHROPIC_VERSION = "2023-06-01";
const ROUTINE_BETA = "experimental-cc-routine-2026-04-01";

// A second fire for the same job inside this window is refused: the endpoint has no
// idempotency key, so each fire is a new session on the subscription.
export const REFIRE_MINUTES = 30;
// A fire reserves itself before it posts, so two fires racing for one job cannot both
// post. The reservation outlives the request's timeout and no longer.
const RESERVE_MINUTES = 2;
const FIRE_TIMEOUT_MS = 15_000;

// Namespaces a routine may serve: lowercase letters and digits in dash-separated runs,
// so ROUTINE_<NS>_TOKEN, which turns each dash into an underscore, names one namespace.
const ROUTINE_NAMESPACE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// What a fire's answer may name (Anthropic documents {"type":"routine_fire",
// "claude_code_session_id":"session_01...","claude_code_session_url":"https://claude.ai/code/session_01..."}).
// The id's charset is wider than the documented example, because the real answer failed
// the strict one. Whatever is stored or returned matches one of these two shapes.
const SESSION_ID = /^session_[A-Za-z0-9_-]{8,128}$/;
const SESSION_URL = /^https:\/\/(?:[a-z0-9-]+\.)*claude\.ai(?:\/[A-Za-z0-9_.-]+)*\/session_[A-Za-z0-9_-]{8,128}\/?$/;
const SESSION_SEGMENT = /^session_[A-Za-z0-9_-]{8,128}$/;
const ANSWER_MAX_CHARS = 64 * 1024;
const DIAG_FIELD_CHARS = 200;
const DIAG_MAX_KEYS = 20;
const DIAG_MAX_STRINGS = 10;

/** A session URL as the answer names it, reduced to origin and path, or null when it is not a claude.ai session URL. */
function readSessionUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "") return null;
  if (url.hostname !== "claude.ai" && !url.hostname.endsWith(".claude.ai")) return null;
  if (!url.pathname.split("/").some((segment) => SESSION_SEGMENT.test(segment))) return null;
  const clean = `https://${url.hostname}${url.pathname}`;
  return SESSION_URL.test(clean) ? clean : null;
}

/** A session id as the answer names it, or null. */
function readSessionId(raw: unknown): string | null {
  return typeof raw === "string" && SESSION_ID.test(raw) ? raw : null;
}

/**
 * The session an answer names. The id and the URL each stand alone: a good id with no
 * readable URL gets the URL built from it, and a good URL with no readable id gives its
 * id back, so a session is recorded whenever either one reads.
 */
function readSession(answer: unknown): { id: string | null; url: string | null; mismatch: string | null } {
  const body = answer !== null && typeof answer === "object" && !Array.isArray(answer) ? (answer as Record<string, unknown>) : {};
  let id = readSessionId(body.claude_code_session_id);
  let url = readSessionUrl(body.claude_code_session_url);
  if (id === null && url !== null) id = url.split("/").find((segment) => SESSION_SEGMENT.test(segment)) ?? null;
  if (url === null && id !== null) url = `https://claude.ai/code/${id}`;
  // Both read but naming different sessions: the id is trusted and the URL rebuilt from it.
  let mismatch: string | null = null;
  const named = url?.split("/").find((segment) => SESSION_SEGMENT.test(segment)) ?? null;
  if (id !== null && named !== null && named !== id) {
    mismatch = named;
    url = `https://claude.ai/code/${id}`;
  }
  return { id, url, mismatch };
}

// Printable ASCII only, redacted, bounded: what is kept of an answer nothing could read.
const keepText = (value: string, token: string, max: number) => {
  const scrubbed = token ? value.split(token).join("[REDACTED:token]") : value;
  return redactText(scrubbed.slice(0, max * 2))
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, max);
};

/** What an unreadable answer looked like: its top-level keys, its type, and the head of each string field. Bounded, redacted, never the token. */
function describeAnswer(text: string, answer: unknown, token: string): Record<string, unknown> {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
    return { json: false, head: keepText(text, token, DIAG_FIELD_CHARS) };
  }
  const body = answer as Record<string, unknown>;
  const keys = Object.keys(body);
  const strings: Record<string, string> = {};
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && Object.keys(strings).length < DIAG_MAX_STRINGS) strings[keepText(key, token, 40)] = keepText(value, token, DIAG_FIELD_CHARS);
  }
  return {
    json: true,
    keys: keys.slice(0, DIAG_MAX_KEYS).map((key) => keepText(key, token, 40)),
    type: typeof body.type === "string" ? keepText(body.type, token, 64) : null,
    strings,
  };
}

/** The routine id a fire URL names, or null when the URL is not a fire URL. */
function routineIdOf(url: string): string | null {
  return FIRE_URL.exec(url)?.[1] ?? null;
}

/**
 * The fire text, which reaches the session wrapped in a routine-fire-payload block. Plain
 * lines the routine's prompt reads; nothing in it is an instruction.
 */
export function fireText(job: Pick<JobRow, "id" | "namespace" | "model_recommended">): string {
  return [`job_id: ${job.id}`, `namespace: ${job.namespace}`, `model_recommended: ${job.model_recommended ?? "unset"}`].join("\n");
}

/** capsid_work_jobs action "routine": read, set or clear a namespace's fire URL. The seat's act. */
export async function setRoutine(env: Env, agent: Agent, namespace: string | undefined, url: string | undefined): Promise<JobResult> {
  if (!callerIsSeat(agent)) {
    return refuse("routine", `${agent.actor} cannot read or set a routine. Pointing Capsid at a session on Dustin's subscription is the seat's act, and this caller holds neither the admin identity nor can_merge.`);
  }
  if (!namespace) return refuse("routine", "routine needs namespace.");
  const outside = outsideJobNamespace(agent, namespace);
  if (outside) return refuse("routine", `${agent.actor} cannot set the routine for ${namespace}: ${outside}`);
  if (!ROUTINE_NAMESPACE.test(namespace)) return namespaceRefusal("routine", namespace);
  const key = routineUrlKey(namespace);
  if (url !== undefined) {
    const value = url.trim();
    if (value === "off") {
      await env.APP_KV.delete(key);
    } else {
      if (!routineIdOf(value)) {
        return refuse("routine", `routine_url must be a fire URL, https://api.anthropic.com/v1/claude_code/routines/trig_.../fire, as the routine's API trigger shows it; or "off" to clear it. Nothing was changed.`);
      }
      await env.APP_KV.put(key, value);
    }
    await env.DB.batch([auditStatement(env.DB, agent.actor, "routine-set", namespace, null, { namespace, routine_id: value === "off" ? null : routineIdOf(value) })]);
  }
  const stored = await env.APP_KV.get(key);
  const routineId = stored ? routineIdOf(stored) : null;
  const token = await resolveRoutineToken(env, agent, namespace, routineId);
  const tokenSecret = token?.secret ?? routineTokenName(namespace);
  return {
    ok: true,
    action: "routine",
    routine: { namespace, routine_id: routineId, token_secret: tokenSecret, token_set: token !== null },
    note: token
      ? undefined
      : `No token is set for ${namespace}. Dustin sets it with: npx wrangler secret put ${tokenSecret}, or the seat sets the same routine's fire URL on a namespace whose token is set.`,
  };
}

// One statement, so two fires for one job cannot both pass the check: a reservation is
// written only while no fire of that job is recorded inside REFIRE_MINUTES and no
// reservation inside RESERVE_MINUTES. Returns the reservation's id, or null when refused.
async function reserveFire(db: D1Database, actor: string, job: JobRow, routineId: string, now: Date): Promise<number | null> {
  const row = await db
    .prepare(
      `INSERT INTO audit_log (actor, action, namespace, path, params)
       SELECT ?1, 'job-routine-firing', ?2, ?3, ?4
       WHERE NOT EXISTS (
         SELECT 1 FROM audit_log WHERE json_extract(params, '$.job_id') = ?5
           AND ((action = 'job-routine-fired' AND at >= datetime(?6)) OR (action = 'job-routine-firing' AND at >= datetime(?7))))
       RETURNING id`
    )
    .bind(
      actor,
      job.namespace,
      jobDocPath(job.id),
      JSON.stringify({ job_id: job.id, routine_id: routineId }),
      job.id,
      new Date(now.getTime() - REFIRE_MINUTES * 60_000).toISOString(),
      new Date(now.getTime() - RESERVE_MINUTES * 60_000).toISOString()
    )
    .first<{ id: number }>();
  return row?.id ?? null;
}

async function lastFire(db: D1Database, jobId: string): Promise<{ at: string; session_url: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT at, json_extract(params, '$.session_url') AS session_url FROM audit_log
       WHERE action IN ('job-routine-fired', 'job-routine-firing') AND json_extract(params, '$.job_id') = ?1
       ORDER BY id DESC LIMIT 1`
    )
    .bind(jobId)
    .first<{ at: string; session_url: string | null }>();
  return row ?? null;
}

/** capsid_work_jobs action "fire": start a session for one queued job by firing its namespace's routine. */
export async function fireRoutine(env: Env, agent: Agent, now: Date, id: string): Promise<JobResult> {
  if (!callerIsSeat(agent)) {
    return refuse("fire", `${agent.actor} cannot fire a routine. Starting work on Dustin's subscription is the seat's act, and this caller holds neither the admin identity nor can_merge.`);
  }
  const job: JobRow | null = await readJob(env.DB, id);
  if (!job) return refuse("fire", `no job ${id}.`);
  const outside = outsideJobNamespace(agent, job.namespace);
  if (outside) return refuse("fire", `${agent.actor} cannot fire for ${id}: ${outside}`);
  if (!ROUTINE_NAMESPACE.test(job.namespace)) return namespaceRefusal("fire", job.namespace);
  if (job.status !== "queued") {
    return refuse("fire", `${id} is ${job.status}, not queued. A routine is fired for a queued job only.`);
  }
  const begun = startedNotice(job);
  if (begun) return refuse("fire", `already_started: ${begun.note} No session was fired.`);
  const verdict = await verifySignedBody(env.IMPROVE_SCORE_SECRET, job.body, "job body");
  if (!verdict.ok) return refuse("fire", `${id} does not verify, so no session is started for it: ${verdict.reason}`);

  const url = await env.APP_KV.get(routineUrlKey(job.namespace));
  const routineId = url ? routineIdOf(url) : null;
  if (!url || !routineId) {
    return refuse("fire", `routine_missing: ${job.namespace} has no routine. Create it at claude.ai/code/routines (docs/routines.md), then the seat sets its fire URL with capsid_work_jobs action "routine".`);
  }
  const resolved = await resolveRoutineToken(env, agent, job.namespace, routineId);
  if (resolved === null) {
    const tokenSecret = routineTokenName(job.namespace);
    return refuse("fire", `routine_token_missing: ${tokenSecret} is not set, and no namespace sharing routine ${routineId} has a token either. The seat sets the same fire URL on a namespace whose token is set (docs/routines.md), or Dustin generates the token on the routine's API trigger and sets it with: npx wrangler secret put ${tokenSecret}`);
  }

  const { secret: tokenSecret, value: token } = resolved;
  if ((await reserveFire(env.DB, agent.actor, job, routineId, now)) === null) {
    const earlier = await lastFire(env.DB, job.id);
    return refuse("fire", `already_fired: ${id} was fired at ${earlier?.at ?? "a moment ago"}${earlier?.session_url ? ` (${earlier.session_url})` : ""}. Each fire is a new session, so a second one inside ${REFIRE_MINUTES} minutes is refused.`);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": ROUTINE_BETA,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: fireText(job) }),
      signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
    });
  } catch (err) {
    // No answer: the session may or may not exist, so the fire is recorded as one and a
    // second fire waits out the window.
    const message = err instanceof Error ? err.message : String(err);
    await env.DB.batch([jobAudit(env.DB, agent.actor, "job-routine-fired", job, { routine_id: routineId, session_id: null, session_url: null, outcome: "unknown", error: message.slice(0, 200) })]);
    return refuse("fire", `routine_unreachable: the fire request for ${routineId} got no answer (${message}). A session may have started; look at claude.ai/code before firing again after ${REFIRE_MINUTES} minutes.`);
  }

  if (res.status === 401) {
    return refuse("fire", `routine_unauthorized: Anthropic refused ${tokenSecret} for ${routineId} (401). The token was revoked or regenerated; Dustin generates a new one on the routine's API trigger and sets it with npx wrangler secret put ${tokenSecret}.`);
  }
  if (res.status === 429) {
    const retry = res.headers.get("Retry-After");
    return refuse("fire", `routine_rate_limited: the hourly fire limit for ${routineId} or the account is reached (429; 30 per routine, 100 per account).${retry ? ` Retry after ${retry} seconds.` : ""}`);
  }
  if (res.status === 404) {
    return refuse("fire", `routine_not_found: Anthropic has no routine ${routineId} (404). It was deleted; create it again and set its fire URL with action "routine".`);
  }
  if (res.status < 200 || res.status > 299) {
    const detail = await errorType(res);
    return refuse("fire", `routine_refused: Anthropic answered ${res.status}${detail ? ` (${detail})` : ""} for ${routineId}. A 400 is often a paused routine. No session was started.`);
  }

  // A 2xx means a session exists. Record it even when the answer is unreadable, so a
  // second fire is still refused and the session is not lost.
  const answerText = (await res.text().catch(() => "")).slice(0, ANSWER_MAX_CHARS);
  let answer: unknown = null;
  try {
    answer = JSON.parse(answerText);
  } catch {
    answer = null;
  }
  const { id: sessionId, url: sessionUrl, mismatch } = readSession(answer);
  // Nothing readable: keep what the answer looked like, so the next failure can be diagnosed.
  const unreadable = sessionId === null && sessionUrl === null ? { answer: describeAnswer(answerText, answer, token) } : {};
  let unrecorded = "";
  try {
    await env.DB.batch([jobAudit(env.DB, agent.actor, "job-routine-fired", job, { routine_id: routineId, session_id: sessionId, session_url: sessionUrl, token_secret: tokenSecret, ...(mismatch ? { session_url_mismatch: mismatch } : {}), ...unreadable })]);
  } catch (err) {
    // The session exists whatever D1 says, so the answer still returns it; the reservation
    // row holds off a second fire for RESERVE_MINUTES.
    const message = err instanceof Error ? err.message : String(err);
    logEvent("error", "ROUTINE_FIRE_UNRECORDED", { message: `ROUTINE_FIRE_UNRECORDED: ${job.id} ${sessionId ?? "(no session id)"}: ${message}` });
    unrecorded = ` The fire could not be recorded (${message}); keep this session URL.`;
  }
  const marked = await markStarted(env, agent, job, now, sessionUrl);
  return {
    ok: true,
    action: "fire",
    job: marked.job,
    started: startedNotice(marked.job) ?? undefined,
    session: { id: sessionId, url: sessionUrl },
    note:
      (sessionUrl
        ? `${routineId} started ${sessionUrl} for ${job.id}. The job stays queued: the session works it without a claim and completes it naming its pull request.`
        : `${routineId} answered ${res.status}, so a session started for ${job.id}, but its answer named no readable session id or URL. What the answer looked like is in the job-routine-fired audit row. Find the session at claude.ai/code.`) +
      unrecorded +
      marked.note,
  };
}

// The started label, set as begin sets it and in one guarded batch with its mirror and
// audit row. A job that moved or was begun since the read keeps what it has: the session
// is already running, so that is said, never refused.
async function markStarted(env: Env, agent: Agent, job: JobRow, now: Date, sessionUrl: string | null): Promise<{ job: JobRow; note: string }> {
  const at = now.toISOString();
  const started: JobRow = { ...job, started_at: at, started_by: agent.actor, updated_at: at };
  const won = await guardedTransition(env, job, [
    env.DB.prepare(
      `UPDATE jobs SET started_at = ?2, started_by = ?3, updated_at = ?2 WHERE id = ?1 AND status = 'queued' AND started_at IS NULL RETURNING id`
    ).bind(job.id, at, agent.actor),
    ...(await mirrorStatements(env, started, "job-started", agent.actor)),
    jobAudit(env.DB, agent.actor, "job-started", started, { started_at: at, session_url: sessionUrl }),
  ]);
  if (won) return { job: started, note: "" };
  const moved = (await readJob(env.DB, job.id)) ?? job;
  return { job: moved, note: ` The job was not marked started: it changed while the routine was fired (now ${moved.status}${moved.started_by ? `, started by ${moved.started_by}` : ""}).` };
}

async function errorType(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => null)) as { error?: { type?: unknown } } | null;
  const type = body?.error?.type;
  return typeof type === "string" && /^[a-z_]{1,64}$/.test(type) ? type : null;
}
