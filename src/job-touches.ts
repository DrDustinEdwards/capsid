// Each row rides in the same guarded batch as the transition it records (block, resume, release,
// supersede, the seat's fail or complete, a review verdict acted on), so a transition the guard
// refuses writes no touch.

export const TOUCH_KINDS = [
  "gate",
  "resume",
  "approval",
  "correction",
  "note",
  "release",
  "supersede",
  "admin_fail",
  "admin_complete",
  "review",
] as const;
type TouchKind = (typeof TOUCH_KINDS)[number];

export const ACTOR_KINDS = ["human", "seat", "driver", "policy", "reviewer", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

const SEAT_AGENTS = new Set(["agent:seat", "agent:site-seat"]);
// Credentials that act on a schedule rather than for a person: the watcher (src/watcher.ts,
// WATCHER_ACTOR) and the tick's own document writes (src/doc-statements.ts, SYSTEM_ACTOR). Spelled
// here rather than imported, so this stays a pure module the unit tests load without the Worker.
const SYSTEM_ACTORS = new Set(["agent:watcher", "improve-loop"]);

export interface ActorContext {
  // A driver's own resume under the signed gate policy (resumeJob's approved_by_policy by a caller
  // that is not the seat). The approval is the policy's, not a person's.
  policy?: boolean;
  reviewer?: boolean;
  seat?: boolean;
}

export function actorKind(actor: string, context: ActorContext = {}): ActorKind {
  if (context.policy) return "policy";
  if (context.reviewer) return "reviewer";
  if (actor.startsWith("access:") || actor.startsWith("github:")) return "human";
  if (SEAT_AGENTS.has(actor) || context.seat) return "seat";
  if (actor === "agent:reviewer") return "reviewer";
  if (SYSTEM_ACTORS.has(actor)) return "system";
  // `<ns>-driver`. Any other minted agent that holds a job is working it, so it is a driver too.
  if (actor.startsWith("agent:")) return "driver";
  return "system";
}

export interface Touch {
  job_id: string;
  namespace: string;
  kind: TouchKind;
  actor: string;
  actor_kind: ActorKind;
  detail?: Record<string, unknown> | null;
  sinceGate: boolean;
  at: string;
}

/**
 * `at` is bound, not defaulted, so waited_ms is the difference of two times from the same clock
 * the transition used. waited_ms is computed in SQL from the job's latest gate row (by id, in
 * insertion order), so a gate written earlier in the same batch counts;
 */
export function touchStatement(db: D1Database, touch: Touch): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO job_touches (job_id, namespace, kind, actor, actor_kind, waited_ms, detail, at)
       VALUES (?1, ?2, ?3, ?4, ?5,
         CASE WHEN ?8 = 1 THEN (SELECT CAST(ROUND((julianday(?7) - julianday(g.at)) * 86400000.0) AS INTEGER)
           FROM job_touches g WHERE g.job_id = ?1 AND g.kind = 'gate' ORDER BY g.id DESC LIMIT 1) END,
         ?6, ?7)`,
    )
    .bind(
      touch.job_id,
      touch.namespace,
      touch.kind,
      touch.actor,
      touch.actor_kind,
      touch.detail ? JSON.stringify(touch.detail) : null,
      touch.at,
      touch.sinceGate ? 1 : 0,
    );
}
