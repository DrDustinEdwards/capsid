// THE HUMAN-TOUCH LOG (migrations/0023, job_touches): one row every time a person, or a
// policy acting for one, touched a job. Without it a job that needed four rescues and
// one that needed none both end "merged", and human effort confounds any comparison of
// agents.
//
// Each row rides in the same guarded batch as the transition it records (block, resume,
// release, supersede, the seat's fail, a review verdict acted on), so a transition the
// guard refuses writes no touch, and a touch never describes a move that did not happen.

export const TOUCH_KINDS = ["gate", "resume", "approval", "correction", "note", "release", "supersede", "admin_fail", "review"] as const;
export type TouchKind = (typeof TOUCH_KINDS)[number];

export const ACTOR_KINDS = ["human", "seat", "driver", "policy", "reviewer", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

// The seat's minted credentials, by agent name (scripts/mint-agents.mjs: `seat`, and
// `site-seat` for dustinedwards). A legacy operator key (`opkey:`) is the seat's too.
const SEAT_AGENTS = new Set(["agent:seat", "agent:site-seat"]);
// Credentials that act on a schedule rather than for a person: the watcher
// (src/watcher.ts, WATCHER_ACTOR), the skills refresh (src/skills-refresh.ts) and the
// improve loop (src/improve-state.ts, IMPROVE_ACTOR). Spelled here rather than imported,
// so this stays a pure module the unit tests load without the Worker.
const SYSTEM_ACTORS = new Set(["agent:watcher", "agent:skills-refresh", "improve-loop"]);

export interface ActorContext {
  // A driver's own resume under the signed gate policy (resumeJob's approved_by_policy
  // by a caller that is not the seat). The approval is the policy's, not a person's.
  policy?: boolean;
  // The touch records a review verdict, whose actor is the login on the comment.
  reviewer?: boolean;
  // The caller is the seat by its flags (callerIsSeat: admin or can_merge), which a
  // seat credential minted under another name still is.
  seat?: boolean;
}

/**
 * Who touched a job, as one of the six kinds job_touches.actor_kind allows. The one
 * place this is decided, so the log and every reader agree.
 *
 * A person first: `access:` is the administrator's Access login (the MCP login and the
 * Portal both), `github:` the same person on rows the old console wrote. Both are
 * human even though they also pass callerIsSeat, because the question here is who
 * acted, not what they were allowed to do.
 */
export function actorKind(actor: string, context: ActorContext = {}): ActorKind {
  if (context.policy) return "policy";
  if (context.reviewer) return "reviewer";
  if (actor.startsWith("access:") || actor.startsWith("github:")) return "human";
  if (actor.startsWith("opkey:") || SEAT_AGENTS.has(actor) || context.seat) return "seat";
  if (actor === "agent:reviewer") return "reviewer";
  if (SYSTEM_ACTORS.has(actor)) return "system";
  // `<ns>-driver`, and a seat-started runner (`runner-<job>-s<n>`, src/runner-key.ts),
  // which is a driver session with a key of its own. Any other minted agent that holds
  // a job is working it, so it is a driver too.
  if (actor.startsWith("agent:")) return "driver";
  return "system";
}

export interface Touch {
  job_id: string;
  namespace: string;
  kind: TouchKind;
  actor: string;
  actor_kind: ActorKind;
  // JSON-serialised as given; undefined keys drop out.
  detail?: Record<string, unknown> | null;
  // The touch ends a wait: waited_ms is measured from the job's latest gate row.
  sinceGate: boolean;
  // ISO with milliseconds, from the same `now` the transition binds.
  at: string;
}

/**
 * The INSERT for one touch. `at` is bound, not defaulted, so waited_ms is the
 * difference of two times from the same clock the transition used. waited_ms is
 * computed in SQL from the latest gate row for the job (by id, which the append-only
 * table keeps in insertion order), so a gate written earlier in the same batch counts,
 * and NULL when the job never hit one or the touch does not end a wait.
 */
export function touchStatement(db: D1Database, touch: Touch): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO job_touches (job_id, namespace, kind, actor, actor_kind, waited_ms, detail, at)
       VALUES (?1, ?2, ?3, ?4, ?5,
         CASE WHEN ?8 = 1 THEN (SELECT CAST(ROUND((julianday(?7) - julianday(g.at)) * 86400000.0) AS INTEGER)
           FROM job_touches g WHERE g.job_id = ?1 AND g.kind = 'gate' ORDER BY g.id DESC LIMIT 1) END,
         ?6, ?7)`
    )
    .bind(
      touch.job_id,
      touch.namespace,
      touch.kind,
      touch.actor,
      touch.actor_kind,
      touch.detail ? JSON.stringify(touch.detail) : null,
      touch.at,
      touch.sinceGate ? 1 : 0
    );
}
