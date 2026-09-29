import { resolveAgent, type Agent } from "./agents";
import { checkScope } from "./scope";

// Who is reporting on a Claude Code session, and which job that session is working.
// The one caller check for the receivers a session posts to on its own: the hook
// receiver (src/ops-hooks.ts) and the OTLP receiver (src/ops-otlp.ts).
//
// The bearer is the session's own key. Accepted:
//   - a minted driver (kind driver) or a runner/session key (kind session, row-backed),
//   - the admin (a legacy write operator key), for testing.
// Anything else that resolves is 403; nothing that resolves is 401.
//
// The write grant is asked of checkScope (CLAUDE.md, one enforcement point rule): what
// these routes write is part of a job's record, so a read-only caller may not send it.
// The tool named is "jobs", which every caller that works jobs holds.
//
// The job: a runner key is bound to one job (agent.job). A driver is bound to the single
// job it holds claimed, or to none when it holds zero or several. The admin is bound to
// none.

const SESSION_REALM = "capsid-hooks";

export interface SessionCaller {
  agent: Agent;
  job_id: string | null;
  // The bound job's namespace, or null with no job.
  namespace: string | null;
  // last_seen, best effort, after the answer (see handleOperatorMcp in src/routes.ts).
  touch: () => Promise<void>;
}

function text(message: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "no-store", ...extra } });
}

/** Why this agent may not report on a session, or null. */
export function sessionCallerRefusal(agent: Agent): string | null {
  if (agent.admin) return null;
  if (!agent.row || (agent.kind !== "driver" && agent.kind !== "session")) {
    return `forbidden: ${agent.actor} is not a driver or a runner. Hooks and telemetry are posted with the session's own driver or runner key (docs/hooks.md, docs/telemetry.md).`;
  }
  return checkScope(agent, { tool: "jobs", grant: "write" });
}

/** The job a caller's session is working: a runner key's bound job, or the one job a
 *  driver holds claimed. None, or more than one, is no binding. */
async function sessionJobFor(db: D1Database, agent: Agent): Promise<{ job_id: string; namespace: string } | null> {
  if (agent.job) {
    const row = await db.prepare("SELECT id, namespace FROM jobs WHERE id = ?1").bind(agent.job).first<{ id: string; namespace: string }>();
    return row ? { job_id: row.id, namespace: row.namespace } : null;
  }
  if (!agent.row || agent.kind !== "driver") return null;
  // LIMIT 2, so "holds several" is told apart from "holds one" without reading them all.
  const { results } = await db
    .prepare("SELECT id, namespace FROM jobs WHERE claimed_by = ?1 AND status = 'claimed' LIMIT 2")
    .bind(agent.actor)
    .all<{ id: string; namespace: string }>();
  const held = results ?? [];
  return held.length === 1 ? { job_id: held[0].id, namespace: held[0].namespace } : null;
}

/** The caller and its job, or the refusal to send. */
export async function resolveSessionCaller(
  request: Request,
  env: { DB: D1Database; OPERATOR_KEY_HASH?: string },
  now: Date = new Date()
): Promise<SessionCaller | Response> {
  const resolved = await resolveAgent(request, env, now);
  if (!resolved) {
    return text("unauthorized: a driver or runner key is required as Authorization: Bearer <key>", 401, {
      "WWW-Authenticate": `Bearer realm="${SESSION_REALM}"`,
    });
  }
  const refusal = sessionCallerRefusal(resolved.agent);
  if (refusal) return text(refusal, 403);
  const binding = await sessionJobFor(env.DB, resolved.agent);
  return { agent: resolved.agent, job_id: binding?.job_id ?? null, namespace: binding?.namespace ?? null, touch: resolved.touch };
}
