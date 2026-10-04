import { classifyCommand } from "./gate-policy";
import type {
  ClaimsAggregate,
  ClaimsAgreement,
  ClaimsAgreementCounts,
  ClaimsFilter,
  ClaimsGroup,
  ClaimsJob,
  ClaimsUsageRow,
  ClaimsUsageTotals,
  ClaimsWaitRow,
  JobClaimRow,
  JobEvaluationRow,
  JobTouchRow,
} from "./ops-types";

// The read side of claims apart from verified outcomes (migrations/0023_job_claims.sql,
// roadmap P0). One set of readers, shared by the `claims` tool (src/tools/claims.ts)
// and the Portal's GET /portal/api/claims (src/portal-claims.ts), so the two cannot
// disagree about what the tables say.
//
// Read-only: nothing here writes. Every value a caller supplies is a bound parameter,
// and every read carries a LIMIT, one row past its bound so a cut is reported by name
// in `truncated` rather than passed off as the whole answer.

// The tables the export pages through, and the only names it will read.
export const CLAIMS_EXPORT_TABLES = ["job_claims", "job_evaluations", "job_touches", "job_outcomes"] as const;
export type ClaimsExportTable = (typeof CLAIMS_EXPORT_TABLES)[number];

export const CLAIMS_EXPORT_MAX = 500;
// Rows of each kind the per-job read returns. A job blocked two hundred times is not a
// job anybody reads row by row.
export const CLAIMS_JOB_ROWS = 200;
// Agent and namespace pairs the aggregate returns.
const CLAIMS_GROUP_LIMIT = 500;
// Evaluation count rows: at most seven names by four agreements per group.
const EVALUATION_ROWS = 5000;
// Touch rows the aggregate folds in TypeScript, for the median wait.
const TOUCH_ROWS = 5000;

const AGREEMENTS: readonly ClaimsAgreement[] = ["agree", "disagree", "unclaimed", "unchecked"];
const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}(T|$)/;

export type ClaimsFilterResult = { ok: true; filter: ClaimsFilter } | { ok: false; refusal: string };

function text(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  // An empty value is no filter, not a filter on the empty string.
  return trimmed.length ? trimmed : null;
}

// A time bound, normalized to the stored shape (ISO with milliseconds, UTC) so a
// text comparison against recorded_at and at orders correctly.
function isoBound(name: string, value: string | null): { ok: true; value: string | null } | { ok: false; refusal: string } {
  if (value === null) return { ok: true, value: null };
  const parsed = Date.parse(value);
  if (!ISO_PREFIX.test(value) || Number.isNaN(parsed)) {
    return { ok: false, refusal: `${name} must be an ISO 8601 time such as 2026-09-01 or 2026-09-01T00:00:00Z; got '${value}'.` };
  }
  return { ok: true, value: new Date(parsed).toISOString() };
}

/** The aggregate's filter from loose input (tool arguments or a query string). */
export function claimsFilterFrom(input: { namespace?: string | null; agent?: string | null; since?: string | null; until?: string | null }): ClaimsFilterResult {
  const since = isoBound("since", text(input.since));
  if (!since.ok) return since;
  const until = isoBound("until", text(input.until));
  if (!until.ok) return until;
  if (since.value !== null && until.value !== null && since.value >= until.value) {
    return { ok: false, refusal: `since (${since.value}) must be before until (${until.value}).` };
  }
  return { ok: true, filter: { namespace: text(input.namespace), agent: text(input.agent), since: since.value, until: until.value } };
}

/** The median of a list of numbers, or null for an empty list (no wait is not a zero wait). */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** One job with every claim, evaluation and touch recorded for it, or null when no
 *  such job exists. */
export async function readJobClaims(db: D1Database, id: string): Promise<ClaimsJob | null> {
  const bound = CLAIMS_JOB_ROWS + 1;
  const [job, outcome, claims, evaluations, touches] = await Promise.all([
    db
      .prepare("SELECT id, namespace, title, status, claimed_by FROM jobs WHERE id = ?1")
      .bind(id)
      .first<ClaimsJob["job"]>(),
    db.prepare("SELECT * FROM job_outcomes WHERE job_id = ?1").bind(id).first<Record<string, unknown>>(),
    db.prepare("SELECT * FROM job_claims WHERE job_id = ?1 ORDER BY id LIMIT ?2").bind(id, bound).all<JobClaimRow>(),
    db.prepare("SELECT * FROM job_evaluations WHERE job_id = ?1 ORDER BY id LIMIT ?2").bind(id, bound).all<JobEvaluationRow>(),
    db.prepare("SELECT * FROM job_touches WHERE job_id = ?1 ORDER BY id LIMIT ?2").bind(id, bound).all<JobTouchRow>(),
  ]);
  if (!job) return null;
  const truncated: string[] = [];
  const cut = <T>(name: string, rows: T[] | undefined): T[] => {
    const list = rows ?? [];
    if (list.length <= CLAIMS_JOB_ROWS) return list;
    truncated.push(name);
    return list.slice(0, CLAIMS_JOB_ROWS);
  };
  return {
    job,
    outcome: outcome ?? null,
    claims: cut("claims", claims.results),
    evaluations: cut("evaluations", evaluations.results),
    touches: cut("touches", touches.results),
    limit: CLAIMS_JOB_ROWS,
    truncated,
  };
}

interface ClaimCountRow {
  agent: string;
  namespace: string;
  jobs: number;
  claims: number;
}

interface EvaluationCountRow {
  agent: string;
  namespace: string;
  name: string;
  agreement: string;
  n: number;
}

interface TouchFoldRow {
  agent: string | null;
  namespace: string;
  kind: string;
  actor_kind: string;
  waited_ms: number | null;
}

interface WaitFoldRow {
  namespace: string;
  actor_kind: string;
  waited_ms: number;
  gate_detail: string | null;
}

interface UsageSqlRow {
  namespace: string;
  n: number;
  cost_usd: number | null;
  active_seconds: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  tokens_cache_creation: number | null;
}

const groupKey = (agent: string | null, namespace: string) => JSON.stringify([agent, namespace]);

const NO_USAGE_TOTALS: ClaimsUsageTotals = {
  rows: 0,
  cost_usd: null,
  active_seconds: null,
  tokens_input: null,
  tokens_output: null,
  tokens_cache_read: null,
  tokens_cache_creation: null,
};

const usageTotals = (row: UsageSqlRow | undefined): ClaimsUsageTotals =>
  row
    ? {
        rows: row.n,
        cost_usd: row.cost_usd,
        active_seconds: row.active_seconds,
        tokens_input: row.tokens_input,
        tokens_output: row.tokens_output,
        tokens_cache_read: row.tokens_cache_read,
        tokens_cache_creation: row.tokens_cache_creation,
      }
    : NO_USAGE_TOTALS;

const WAIT_CLASS_NEEDS_HUMAN = "needs_human";
const WAIT_CLASS_UNREADABLE = "unreadable_gate";

/**
 * The class of the gate a wait ended, from the gate row's detail (the JSON a block
 * writes: reason and command). Reuses the gate policy's own classifier, so "which
 * waits could the policy have approved" is answered by the code that approves them.
 * A command that matches no class, or a gate that recorded none, needs a person. A
 * detail that is not JSON is named, not folded into needs_human: it is a row the writer
 * should never have produced.
 */
export function gateClassOf(detail: string | null): string {
  if (detail === null) return WAIT_CLASS_NEEDS_HUMAN;
  let command: unknown;
  try {
    command = (JSON.parse(detail) as { command?: unknown } | null)?.command;
  } catch {
    return WAIT_CLASS_UNREADABLE;
  }
  if (typeof command !== "string") return WAIT_CLASS_NEEDS_HUMAN;
  const match = classifyCommand(command);
  return "refused" in match ? WAIT_CLASS_NEEDS_HUMAN : match.klasses.join("+");
}

function emptyGroup(agent: string | null, namespace: string): ClaimsGroup {
  return {
    agent,
    namespace,
    jobs: 0,
    claims: 0,
    evaluations: {},
    touches: { count: 0, by_kind: {}, by_actor_kind: {}, waits: 0, waited_ms_total: null, waited_ms_median: null },
  };
}

/** Per agent and namespace: jobs and claims, each evaluation's agreement counts, and
 *  the human touches on those jobs with the total and median wait.
 *
 *  An evaluation is attributed through its claim (claim_id), which is how the worker
 *  writes every one. A touch is attributed to every agent that made a claim on its
 *  job, so a job two drivers worked shows its touches under both; a touch on a job
 *  with no claim yet is grouped under agent null. */
export async function readClaimsAggregate(db: D1Database, filter: ClaimsFilter): Promise<ClaimsAggregate> {
  const { namespace, agent, since, until } = filter;
  const [claimRows, evaluationRows, touchRows, waitRows, telemetryRows, reportedRows] = await Promise.all([
    db
      .prepare(
        `SELECT agent, namespace, COUNT(DISTINCT job_id) AS jobs, COUNT(*) AS claims FROM job_claims
         WHERE (?1 IS NULL OR namespace = ?1) AND (?2 IS NULL OR agent = ?2)
           AND (?3 IS NULL OR recorded_at >= ?3) AND (?4 IS NULL OR recorded_at < ?4)
         GROUP BY agent, namespace ORDER BY agent, namespace LIMIT ?5`
      )
      .bind(namespace, agent, since, until, CLAIMS_GROUP_LIMIT + 1)
      .all<ClaimCountRow>(),
    db
      .prepare(
        `SELECT c.agent AS agent, c.namespace AS namespace, e.name AS name, e.agreement AS agreement, COUNT(*) AS n
         FROM job_evaluations e JOIN job_claims c ON c.id = e.claim_id
         WHERE (?1 IS NULL OR c.namespace = ?1) AND (?2 IS NULL OR c.agent = ?2)
           AND (?3 IS NULL OR e.recorded_at >= ?3) AND (?4 IS NULL OR e.recorded_at < ?4)
         GROUP BY c.agent, c.namespace, e.name, e.agreement ORDER BY c.agent, c.namespace, e.name, e.agreement LIMIT ?5`
      )
      .bind(namespace, agent, since, until, EVALUATION_ROWS + 1)
      .all<EvaluationCountRow>(),
    db
      .prepare(
        `SELECT a.agent AS agent, t.namespace AS namespace, t.kind AS kind, t.actor_kind AS actor_kind, t.waited_ms AS waited_ms
         FROM job_touches t LEFT JOIN (SELECT DISTINCT job_id, agent FROM job_claims) a ON a.job_id = t.job_id
         WHERE (?1 IS NULL OR t.namespace = ?1) AND (?2 IS NULL OR a.agent = ?2)
           AND (?3 IS NULL OR t.at >= ?3) AND (?4 IS NULL OR t.at < ?4)
         ORDER BY t.id LIMIT ?5`
      )
      .bind(namespace, agent, since, until, TOUCH_ROWS + 1)
      .all<TouchFoldRow>(),
    // Each ended wait once, with the gate it ended: the latest gate row on the job
    // before the touch, which is the row touchStatement measured waited_ms from. The
    // agent filter is a test, not a join, so a job two agents claimed is not counted
    // twice.
    db
      .prepare(
        `SELECT t.namespace AS namespace, t.actor_kind AS actor_kind, t.waited_ms AS waited_ms,
           (SELECT g.detail FROM job_touches g WHERE g.job_id = t.job_id AND g.kind = 'gate' AND g.id < t.id
            ORDER BY g.id DESC LIMIT 1) AS gate_detail
         FROM job_touches t
         WHERE t.waited_ms IS NOT NULL AND (?1 IS NULL OR t.namespace = ?1)
           AND (?2 IS NULL OR EXISTS (SELECT 1 FROM job_claims c WHERE c.job_id = t.job_id AND c.agent = ?2))
           AND (?3 IS NULL OR t.at >= ?3) AND (?4 IS NULL OR t.at < ?4)
         ORDER BY t.id LIMIT ?5`
      )
      .bind(namespace, agent, since, until, TOUCH_ROWS + 1)
      .all<WaitFoldRow>(),
    // Telemetry: the job_outcomes columns the OTLP receiver fills. A job with none of
    // the six is not a row here, so "rows" counts jobs that reported something.
    db
      .prepare(
        `SELECT namespace, COUNT(*) AS n, SUM(cost_usd) AS cost_usd, SUM(active_seconds) AS active_seconds,
           SUM(tokens_input) AS tokens_input, SUM(tokens_output) AS tokens_output,
           SUM(tokens_cache_read) AS tokens_cache_read, SUM(tokens_cache_creation) AS tokens_cache_creation
         FROM job_outcomes
         WHERE (cost_usd IS NOT NULL OR active_seconds IS NOT NULL OR tokens_input IS NOT NULL OR tokens_output IS NOT NULL
                OR tokens_cache_read IS NOT NULL OR tokens_cache_creation IS NOT NULL)
           AND (?1 IS NULL OR namespace = ?1) AND (?2 IS NULL OR agent = ?2)
           AND (?3 IS NULL OR recorded_at >= ?3) AND (?4 IS NULL OR recorded_at < ?4)
         GROUP BY namespace ORDER BY namespace LIMIT ?5`
      )
      .bind(namespace, agent, since, until, CLAIMS_GROUP_LIMIT + 1)
      .all<UsageSqlRow>(),
    // Reported: claim.usage as the agent sent it, kept whole in job_claims.raw. Each
    // claim is one session's own total, so claims on a job are summed.
    db
      .prepare(
        `SELECT namespace, COUNT(*) AS n,
           SUM(json_extract(raw, '$.claim.usage.cost_usd')) AS cost_usd,
           SUM(json_extract(raw, '$.claim.usage.active_seconds')) AS active_seconds,
           SUM(json_extract(raw, '$.claim.usage.tokens.input')) AS tokens_input,
           SUM(json_extract(raw, '$.claim.usage.tokens.output')) AS tokens_output,
           SUM(json_extract(raw, '$.claim.usage.tokens.cache_read')) AS tokens_cache_read,
           SUM(json_extract(raw, '$.claim.usage.tokens.cache_creation')) AS tokens_cache_creation
         FROM job_claims
         WHERE json_extract(raw, '$.claim.usage') IS NOT NULL
           AND (?1 IS NULL OR namespace = ?1) AND (?2 IS NULL OR agent = ?2)
           AND (?3 IS NULL OR recorded_at >= ?3) AND (?4 IS NULL OR recorded_at < ?4)
         GROUP BY namespace ORDER BY namespace LIMIT ?5`
      )
      .bind(namespace, agent, since, until, CLAIMS_GROUP_LIMIT + 1)
      .all<UsageSqlRow>(),
  ]);

  const truncated: string[] = [];
  const within = <T>(name: string, rows: T[] | undefined, bound: number): T[] => {
    const list = rows ?? [];
    if (list.length <= bound) return list;
    truncated.push(name);
    return list.slice(0, bound);
  };

  const groups = new Map<string, ClaimsGroup>();
  const groupFor = (a: string | null, ns: string): ClaimsGroup => {
    const key = groupKey(a, ns);
    let group = groups.get(key);
    if (!group) {
      group = emptyGroup(a, ns);
      groups.set(key, group);
    }
    return group;
  };

  for (const row of within("groups", claimRows.results, CLAIMS_GROUP_LIMIT)) {
    const group = groupFor(row.agent, row.namespace);
    group.jobs = row.jobs;
    group.claims = row.claims;
  }

  for (const row of within("evaluations", evaluationRows.results, EVALUATION_ROWS)) {
    const group = groupFor(row.agent, row.namespace);
    const counts: ClaimsAgreementCounts = group.evaluations[row.name] ?? { agree: 0, disagree: 0, unclaimed: 0, unchecked: 0 };
    // The table's CHECK allows only these four; anything else is a schema this reader
    // does not know, and saying so beats dropping it.
    if (!(AGREEMENTS as readonly string[]).includes(row.agreement)) {
      throw new Error(`job_evaluations holds agreement '${row.agreement}', which this reader does not know`);
    }
    counts[row.agreement as ClaimsAgreement] += row.n;
    group.evaluations[row.name] = counts;
  }

  const waits = new Map<string, number[]>();
  for (const row of within("touches", touchRows.results, TOUCH_ROWS)) {
    const group = groupFor(row.agent, row.namespace);
    const t = group.touches;
    t.count += 1;
    t.by_kind[row.kind] = (t.by_kind[row.kind] ?? 0) + 1;
    t.by_actor_kind[row.actor_kind] = (t.by_actor_kind[row.actor_kind] ?? 0) + 1;
    if (row.waited_ms !== null) {
      const key = groupKey(row.agent, row.namespace);
      const list = waits.get(key) ?? [];
      list.push(row.waited_ms);
      waits.set(key, list);
    }
  }
  for (const [key, list] of waits) {
    const t = groups.get(key)!.touches;
    t.waits = list.length;
    t.waited_ms_total = list.reduce((sum, v) => sum + v, 0);
    t.waited_ms_median = median(list);
  }

  const ordered = [...groups.values()].sort(
    (a, b) => (a.agent ?? "").localeCompare(b.agent ?? "") || a.namespace.localeCompare(b.namespace)
  );

  const ended = new Map<string, { namespace: string; gate_class: string; ended_by: string; list: number[] }>();
  for (const row of within("waits", waitRows.results, TOUCH_ROWS)) {
    const gate_class = gateClassOf(row.gate_detail);
    const key = JSON.stringify([row.namespace, gate_class, row.actor_kind]);
    const entry = ended.get(key) ?? { namespace: row.namespace, gate_class, ended_by: row.actor_kind, list: [] };
    entry.list.push(row.waited_ms);
    ended.set(key, entry);
  }
  const waitsRanked: ClaimsWaitRow[] = [...ended.values()]
    .map((e) => ({
      namespace: e.namespace,
      gate_class: e.gate_class,
      ended_by: e.ended_by,
      waits: e.list.length,
      waited_ms_total: e.list.reduce((sum, v) => sum + v, 0),
      waited_ms_median: median(e.list) as number,
    }))
    .sort((a, b) => b.waited_ms_total - a.waited_ms_total || a.namespace.localeCompare(b.namespace) || a.gate_class.localeCompare(b.gate_class));

  const telemetry = new Map(within("usage_telemetry", telemetryRows.results, CLAIMS_GROUP_LIMIT).map((r) => [r.namespace, r]));
  const reported = new Map(within("usage_reported", reportedRows.results, CLAIMS_GROUP_LIMIT).map((r) => [r.namespace, r]));
  const usage: ClaimsUsageRow[] = [...new Set([...telemetry.keys(), ...reported.keys()])].sort().map((ns) => ({
    namespace: ns,
    telemetry: usageTotals(telemetry.get(ns)),
    reported: usageTotals(reported.get(ns)),
  }));

  return { filter, groups: ordered, waits: waitsRanked, usage, truncated };
}

export interface ClaimsExportPage {
  table: ClaimsExportTable;
  after: number;
  limit: number;
  rows: Record<string, unknown>[];
  // The cursor for the next page, or null when this page reached the end.
  next_after: number | null;
}

function isClaimsExportTable(value: unknown): value is ClaimsExportTable {
  return typeof value === "string" && (CLAIMS_EXPORT_TABLES as readonly string[]).includes(value);
}

// One statement per table, spelled out, so no table name is ever interpolated into
// SQL and the query-plan walk can read every one. The cursor is the row's id, which
// AUTOINCREMENT never reuses. job_outcomes has a TEXT primary key, so its cursor is the
// rowid, returned as the column `rowid`; its rows are never deleted, so a rowid a page
// has passed is never handed out again.
function exportStatement(db: D1Database, table: ClaimsExportTable): D1PreparedStatement {
  switch (table) {
    case "job_claims":
      return db.prepare("SELECT * FROM job_claims WHERE id > ?1 ORDER BY id LIMIT ?2");
    case "job_evaluations":
      return db.prepare("SELECT * FROM job_evaluations WHERE id > ?1 ORDER BY id LIMIT ?2");
    case "job_touches":
      return db.prepare("SELECT * FROM job_touches WHERE id > ?1 ORDER BY id LIMIT ?2");
    case "job_outcomes":
      return db.prepare("SELECT rowid AS rowid, * FROM job_outcomes WHERE rowid > ?1 ORDER BY rowid LIMIT ?2");
  }
}

/** One page of a table, strictly after the cursor, oldest first. Pages never skip or
 *  repeat a row: each asks for the rows past the last one it was handed. */
export async function exportClaimsPage(db: D1Database, table: ClaimsExportTable, after: number, limit: number): Promise<ClaimsExportPage> {
  if (!isClaimsExportTable(table)) throw new Error(`'${String(table)}' is not an exportable table. One of: ${CLAIMS_EXPORT_TABLES.join(", ")}.`);
  if (!Number.isSafeInteger(after) || after < 0) throw new Error(`after must be a non-negative integer cursor; got ${after}.`);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CLAIMS_EXPORT_MAX) {
    throw new Error(`limit must be an integer from 1 to ${CLAIMS_EXPORT_MAX}; got ${limit}.`);
  }
  const { results } = await exportStatement(db, table).bind(after, limit + 1).all<Record<string, unknown>>();
  const all = results ?? [];
  const rows = all.slice(0, limit);
  const cursorColumn = table === "job_outcomes" ? "rowid" : "id";
  const last = rows.length ? rows[rows.length - 1][cursorColumn] : null;
  if (all.length > limit && typeof last !== "number") {
    throw new Error(`${table} returned a row with no numeric ${cursorColumn}, so the next page cannot be asked for`);
  }
  return { table, after, limit, rows, next_after: all.length > limit ? (last as number) : null };
}
