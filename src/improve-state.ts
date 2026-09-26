import { sha256Hex } from "./auth";
import { normalizeDashes } from "./normalize";
import { auditStatement, snapshotLive } from "./store-guards";
import {
  bestKey,
  BUDGET_DEFAULTS,
  BUDGET_KEY,
  DEFAULT_MODE,
  IMPROVE_MODES,
  MODE_KEY,
  pausedKey,
  type BestRecord,
  type BudgetCaps,
  type ImproveMode,
  type RunCondition,
  type RunStatus,
} from "./improve-schema";

export const IMPROVE_ACTOR = "improve-loop";

// Unset, unrecognised or unreadable all resolve to off. The asymmetry is deliberate:
// wrongly running costs five repos machine-authored branches overnight, and wrongly
// not running costs one quiet night.
export async function readMode(kv: KVNamespace): Promise<{ mode: ImproveMode; reason: string | null }> {
  let raw: string | null;
  try {
    raw = await kv.get(MODE_KEY);
  } catch (err) {
    return { mode: "off", reason: `could not read ${MODE_KEY}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (raw === null) return { mode: DEFAULT_MODE, reason: `${MODE_KEY} is unset` };
  const value = raw.trim().toLowerCase();
  if ((IMPROVE_MODES as readonly string[]).includes(value)) return { mode: value as ImproveMode, reason: null };
  return { mode: "off", reason: `${MODE_KEY} holds an unrecognised value; expected one of ${IMPROVE_MODES.join(", ")}` };
}

// A paused namespace is skipped. A KV error also pauses, for the same reason as readMode.
export async function pausedReason(kv: KVNamespace, namespace: string): Promise<string | null> {
  try {
    return await kv.get(pausedKey(namespace));
  } catch (err) {
    return `could not read the pause key: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// No TTL. A pause is a decision that outlives any run and a human clears it by deleting
// the key: an expiring pause would silently resume a namespace that was stopped for a
// reason nobody has looked at yet.
export async function pauseNamespace(kv: KVNamespace, namespace: string, reason: string): Promise<void> {
  await kv.put(pausedKey(namespace), reason);
}

// Defaults apply per field: a partial value caps what it names and defaults the rest.
// An unreadable or malformed key means the defaults apply rather than no cap at all, so
// a KV outage never uncaps the loop.
export async function readBudget(kv: KVNamespace): Promise<BudgetCaps> {
  try {
    const raw = await kv.get(BUDGET_KEY);
    if (!raw) return { ...BUDGET_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<BudgetCaps>;
    return {
      actions_minutes_month:
        typeof parsed.actions_minutes_month === "number" && Number.isFinite(parsed.actions_minutes_month)
          ? parsed.actions_minutes_month
          : BUDGET_DEFAULTS.actions_minutes_month,
      model_usd_month:
        typeof parsed.model_usd_month === "number" && Number.isFinite(parsed.model_usd_month)
          ? parsed.model_usd_month
          : BUDGET_DEFAULTS.model_usd_month,
      ...(typeof parsed.month === "string" && /^\d{4}-\d{2}$/.test(parsed.month) ? { month: parsed.month } : {}),
    };
  } catch {
    return { ...BUDGET_DEFAULTS };
  }
}

// Spend since the budget month began, from the run rows: cost_usd is the model estimate
// the run recorded, ci_minutes the scorer-reported Actions time. Both accrue on the run
// row as the run advances, so an in-flight run's spend counts too.
export async function monthSpend(
  db: D1Database,
  monthStart: string
): Promise<{ cost_usd: number; ci_minutes: number }> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd, COALESCE(SUM(ci_minutes), 0) AS ci_minutes
       FROM improve_runs WHERE started >= ?1`
    )
    .bind(monthStart)
    .first<{ cost_usd: number; ci_minutes: number }>();
  return { cost_usd: Number(row?.cost_usd ?? 0), ci_minutes: Number(row?.ci_minutes ?? 0) };
}

export async function readBest(kv: KVNamespace, namespace: string): Promise<BestRecord | null> {
  try {
    const raw = await kv.get(bestKey(namespace));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BestRecord;
    return typeof parsed?.sha === "string" && parsed.sha.length > 0 ? parsed : null;
  } catch {
    // Corrupt reads as absent: the run branches from the default branch, a worse base
    // but a safe one. Throwing would wedge every future run on one bad JSON value.
    return null;
  }
}

export async function writeBest(kv: KVNamespace, namespace: string, record: BestRecord): Promise<void> {
  await kv.put(bestKey(namespace), JSON.stringify(record));
}

export interface RunRow {
  id: string;
  namespace: string;
  mode: string;
  started: string;
  finished: string | null;
  attempts: number;
  kept: number;
  reverts: number;
  cost_usd: number;
  ci_minutes: number;
  status: RunStatus;
  consecutive_reverts: number;
  // Environment failures in a row: a scorer that never reported, a container that never
  // finished, a hidden suite that never arrived. Kept apart from consecutive_reverts
  // because they say nothing about the code.
  consecutive_unjudged: number;
  current_attempt: string | null;
  base_sha: string | null;
  pr_url: string | null;
  note: string | null;
  condition: RunCondition;
  advanced_at: string;
}

export interface AttemptRow {
  id: string;
  namespace: string;
  run_id: string;
  change_summary: string | null;
  diff_ref: string | null;
  score_before: number | null;
  score_after: number | null;
  kept: number;
  reason: string | null;
  lineage_parent: string | null;
  status: string;
  branch: string | null;
  head_sha: string | null;
  base_sha: string | null;
  flagged: number;
  flag_reason: string | null;
  skill_id: string | null;
  anchors_json: string | null;
  secondary_json: string | null;
  dispatched_at: string | null;
  ts: string;
}

// Exported so no caller keeps its own copy that falls behind a migration.
export const RUN_COLUMNS =
  "id, namespace, mode, started, finished, attempts, kept, reverts, cost_usd, ci_minutes, status, " +
  "consecutive_reverts, consecutive_unjudged, current_attempt, base_sha, pr_url, note, condition, advanced_at";

const ATTEMPT_COLUMNS =
  "id, namespace, run_id, change_summary, diff_ref, score_before, score_after, kept, reason, lineage_parent, " +
  "status, branch, head_sha, base_sha, flagged, flag_reason, skill_id, anchors_json, secondary_json, dispatched_at, ts";

// The one active run for a namespace, or null. The partial unique index in
// migrations/0003_improve.sql makes "the one" true even when two ticks race; this read
// is the fast path, not the guarantee.
export async function activeRun(db: D1Database, namespace: string): Promise<RunRow | null> {
  return db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM improve_runs
       WHERE namespace = ?1 AND status NOT IN ('done', 'paused')
       ORDER BY started DESC LIMIT 1`
    )
    .bind(namespace)
    .first<RunRow>();
}

export async function runById(db: D1Database, runId: string): Promise<RunRow | null> {
  return db.prepare(`SELECT ${RUN_COLUMNS} FROM improve_runs WHERE id = ?1`).bind(runId).first<RunRow>();
}

// Every run not in a terminal state, oldest first. The tick's work list.
export async function advanceableRuns(db: D1Database, limit: number): Promise<RunRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM improve_runs
       WHERE status NOT IN ('done', 'paused')
       ORDER BY advanced_at ASC LIMIT ?1`
    )
    .bind(limit)
    .all<RunRow>();
  return results;
}

export async function attemptById(db: D1Database, attemptId: string): Promise<AttemptRow | null> {
  return db.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM improve_attempts WHERE id = ?1`).bind(attemptId).first<AttemptRow>();
}

export async function attemptsForRun(db: D1Database, runId: string): Promise<AttemptRow[]> {
  const { results } = await db
    .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM improve_attempts WHERE run_id = ?1 ORDER BY ts ASC`)
    .bind(runId)
    .all<AttemptRow>();
  return results;
}

export interface Transition {
  runId: string;
  // The status the caller believes the run is in. The update fires only if it still
  // is; passing the wrong one is not an error but a no-op, which is what a replayed
  // tick should be.
  expected: RunStatus;
  next: RunStatus;
  patch?: Partial<
    Pick<
      RunRow,
      | "attempts"
      | "kept"
      | "reverts"
      | "cost_usd"
      | "ci_minutes"
      | "consecutive_reverts"
      | "consecutive_unjudged"
      | "current_attempt"
      | "base_sha"
      | "pr_url"
      | "note"
      | "finished"
    >
  >;
}

// True when this call moved the run. False (someone else did) is not an error.
export async function advanceRun(db: D1Database, t: Transition): Promise<boolean> {
  const sets: string[] = ["status = ?1", "advanced_at = datetime('now')"];
  const binds: unknown[] = [t.next];
  for (const [column, value] of Object.entries(t.patch ?? {})) {
    binds.push(value);
    sets.push(`${column} = ?${binds.length}`);
  }
  binds.push(t.runId, t.expected);
  const { results } = await db
    .prepare(
      `UPDATE improve_runs SET ${sets.join(", ")}
       WHERE id = ?${binds.length - 1} AND status = ?${binds.length}
       RETURNING id`
    )
    .bind(...binds)
    .all<{ id: string }>();
  return results.length === 1;
}

// The loop writes documents under the same two invariants as every other write path
// (CLAUDE.md, snapshot rule): the prior row is snapshotted into document_versions and
// audit_log gets a row, in the same batch as the write, so all three land or none do.
// This holds though nothing the loop writes is canon: an archive doc overwriting an
// earlier one with no snapshot is the unrecoverable state the rule exists to prevent.
// Returns statements so a caller can batch them with the row update they belong to.
export async function improveDocStatements(
  db: D1Database,
  doc: {
    namespace: string;
    path: string;
    title: string;
    body: string;
    type: string;
    status?: string;
    tags?: string;
    prior: { id: number; title: string | null; body: string | null } | null;
    action: string;
    // Who the audit row names. Defaults to the loop; the work queue passes the job's
    // actor, because a job document written by an operator key must not read as the
    // loop's work: audit_log is the one place that answers who did it.
    actor?: string;
  }
): Promise<D1PreparedStatement[]> {
  // Server-side dash normalization, as the write tool applies. A model-written document
  // is the likeliest source of an em dash in this store.
  const body = normalizeDashes(doc.body, "prose");
  const title = normalizeDashes(doc.title, "title");

  // The snapshot selects the live row inside the batch rather than binding doc.prior,
  // read earlier: a write landing in between (the job claim path waits on GitHub
  // there) is still snapshotted. With no row it inserts nothing.
  const statements: D1PreparedStatement[] = [snapshotLive(db, doc.namespace, doc.path)];
  statements.push(
    db
      .prepare(
        `INSERT INTO documents (namespace, path, title, body, type, tags, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(namespace, path) DO UPDATE SET
           title = ?3, body = excluded.body, type = ?5, tags = ?6, status = ?7,
           updated_at = datetime('now')`
      )
      .bind(doc.namespace, doc.path, title, body, doc.type, doc.tags ?? "improve", doc.status ?? "published")
  );
  statements.push(
    auditStatement(db, doc.actor ?? IMPROVE_ACTOR, doc.action, doc.namespace, doc.path, {
      bytes: body.length,
      sha256: await sha256Hex(body),
      updated: Boolean(doc.prior),
    })
  );
  return statements;
}

export async function priorDoc(
  db: D1Database,
  namespace: string,
  path: string
): Promise<{ id: number; title: string | null; body: string | null } | null> {
  return db
    .prepare("SELECT id, title, body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(namespace, path)
    .first<{ id: number; title: string | null; body: string | null }>();
}

// An audit row for a loop action that is not a document write (a run opening, a
// namespace pausing, a scorer dispatch), under the same actor, so one query answers
// what the loop did last night.
export function improveAudit(
  db: D1Database,
  action: string,
  namespace: string | null,
  params: unknown
): D1PreparedStatement {
  return auditStatement(db, IMPROVE_ACTOR, action, namespace, null, params);
}
