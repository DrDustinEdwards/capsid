import { resolveAgent, type Agent } from "./agents";
import { checkScope } from "./scope";

// Who is reporting on a Claude Code session, and which job that session is working.
// Shared by the receivers a session posts to on its own (the OTLP receiver in
// src/ops-otlp.ts; the hook receiver may use it too), so the caller and job binding
// is decided in one place.
//
// The bearer is the session's own key. Accepted:
//   - a minted driver (kind driver) or a runner/session key (kind session, row-backed),
//   - the admin (a legacy write operator key), for testing.
// Anything else that resolves is 403; nothing that resolves is 401.
//
// The write grant is asked of checkScope (CLAUDE.md, one enforcement point rule): a
// session's telemetry lands in the job's record, so a read-only caller may not send it.
// The tool named is "jobs", because what these routes write is part of a job's record
// and every caller that works jobs holds it.
//
// The job: a runner key is bound to one job (agent.job). Any other caller is bound to
// the single job it holds claimed, or to none when it holds zero or several.

const SESSION_REALM = "capsid-hooks";

export interface SessionCaller {
  agent: Agent;
  job_id: string | null;
}

function text(message: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "no-store", ...extra } });
}

/** Why this agent may not report on a session, or null. Exported for the unit tests. */
export function sessionCallerRefusal(agent: Agent): string | null {
  const byKind = agent.admin || (agent.row !== null && (agent.kind === "driver" || agent.kind === "session"));
  if (!byKind) {
    return `forbidden: ${agent.actor} is not a driver, a runner key or the admin, so it cannot report on a Claude Code session`;
  }
  return checkScope(agent, { tool: "jobs", grant: "write" });
}

/** The job a caller's session is working, or null. */
async function sessionJobFor(db: D1Database, agent: Agent): Promise<string | null> {
  if (agent.job) return agent.job;
  // LIMIT 2, so "holds several" is told apart from "holds one" without reading them all.
  const { results } = await db
    .prepare("SELECT id FROM jobs WHERE claimed_by = ?1 AND status = 'claimed' ORDER BY id LIMIT 2")
    .bind(agent.actor)
    .all<{ id: string }>();
  const held = results ?? [];
  return held.length === 1 ? held[0].id : null;
}

/** The caller and its job, or the refusal to send. */
export async function resolveSessionCaller(
  request: Request,
  env: { DB: D1Database; OPERATOR_KEY_HASH?: string },
  now: Date = new Date()
): Promise<SessionCaller | Response> {
  const resolved = await resolveAgent(request, env, now);
  if (!resolved) {
    return text("unauthorized: a driver key, a runner key or the admin key is required", 401, {
      "WWW-Authenticate": `Bearer realm="${SESSION_REALM}"`,
    });
  }
  const refusal = sessionCallerRefusal(resolved.agent);
  if (refusal) return text(refusal, 403);
  const job_id = await sessionJobFor(env.DB, resolved.agent);
  return { agent: resolved.agent, job_id };
}
