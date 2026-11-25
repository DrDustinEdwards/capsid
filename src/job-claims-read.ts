import { classifyCommand } from "./gate-policy";
import { median } from "capsomer/behavior/format";
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
} from "./ops-types/claims";

// Read side of claims (0023), shared by capsid_admin_read_claims and the Portal so they cannot disagree.
// Read-only; every read takes one row past its bound so a cut is reported in `truncated`.

export const CLAIMS_JOB_ROWS = 200;
const CLAIMS_GROUP_LIMIT = 500;
const EVALUATION_ROWS = 5000;
const TOUCH_ROWS = 5000;

const AGREEMENTS: readonly ClaimsAgreement[] = ["agree", "disagree", "unclaimed", "unchecked"];
const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}(T|$)/;

export type ClaimsFilterResult =
  | { ok: true; filter: ClaimsFilter }
  | { ok: false; refusal: string };

function text(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

// Normalized to the stored shape (ISO with ms, UTC) so text comparison orders correctly.
function isoBound(
  name: string,
  value: string | null,
): { ok: true; value: string | null } | { ok: false; refusal: string } {
  if (value === null) return { ok: true, value: null };
  const parsed = Date.parse(value);
  if (!ISO_PREFIX.test(value) || Number.isNaN(parsed)) {
    return {
      ok: false,
      refusal: `${name} must be an ISO 8601 time such as 2026-09-01 or 2026-09-01T00:00:00Z; got '${value}'.`,
    };
  }
  return { ok: true, value: new Date(parsed).toISOString() };
}

export function claimsFilterFrom(input: {
  namespace?: string | null;
  agent?: string | null;
  since?: string | null;
  until?: string | null;
}): ClaimsFilterResult {
  const since = isoBound("since", text(input.since));
  if (!since.ok) return since;
  const until = isoBound("until", text(input.until));
  if (!until.ok) return until;
  if (since.value !== null && until.value !== null && since.value >= until.value) {
    return { ok: false, refusal: `since (${since.value}) must be before until (${until.value}).` };
  }
  return {
    ok: true,
    filter: {
      namespace: text(input.namespace),
      agent: text(input.agent),
      since: since.value,
      until: until.value,
    },
  };
}

export async function readJobClaims(db: D1Database, id: string): Promise<ClaimsJob | null> {
  const bound = CLAIMS_JOB_ROWS + 1;
  const [job, outcome, claims, evaluations, touches] = await Promise.all([
    db
      .prepare("SELECT id, namespace, title, status, claimed_by FROM jobs WHERE id = ?1")
      .bind(id)
      .first<ClaimsJob["job"]>(),
    db
      .prepare("SELECT * FROM job_outcomes WHERE job_id = ?1")
      .bind(id)
      .first<Record<string, unknown>>(),
    db
      .prepare("SELECT * FROM job_claims WHERE job_id = ?1 ORDER BY id LIMIT ?2")
      .bind(id, bound)
      .all<JobClaimRow>(),
    db
      .prepare("SELECT * FROM job_evaluations WHERE job_id = ?1 ORDER BY id LIMIT ?2")
      .bind(id, bound)
      .all<JobEvaluationRow>(),
    db
      .prepare("SELECT * FROM job_touches WHERE job_id = ?1 ORDER BY id LIMIT ?2")
      .bind(id, bound)
      .all<JobTouchRow>(),
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

const usageTotals = (row: UsageSqlRow): ClaimsUsageTotals => ({
  rows: row.n,
  cost_usd: row.cost_usd,
  active_seconds: row.active_seconds,
  tokens_input: row.tokens_input,
  tokens_output: row.tokens_output,
  tokens_cache_read: row.tokens_cache_read,
  tokens_cache_creation: row.tokens_cache_creation,
});

const WAIT_CLASS_NEEDS_HUMAN = "needs_human";
const WAIT_CLASS_UNREADABLE = "unreadable_gate";

// Class of the gate a wait ended, from the gate detail JSON, using the gate policy's own classifier so "could
// the policy have approved it" is answered by the code that approves. No match or command needs a person.
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
    touches: {
      count: 0,
      by_kind: {},
      by_actor_kind: {},
      waits: 0,
      waited_ms_total: null,
      waited_ms_median: null,
    },
  };
}

// Touches are attributed to every agent that claimed the job (so two drivers both show) and to agent null
// when it has no claim; an evaluation is attributed through its claim_id.
export async function readClaimsAggregate(
  db: D1Database,
  filter: ClaimsFilter,
): Promise<ClaimsAggregate> {
  const { namespace, agent, since, until } = filter;
  const [claimRows, evaluationRows, touchRows, waitRows, usageRows] = await Promise.all([
    db
      .prepare(
        `SELECT agent, namespace, COUNT(DISTINCT job_id) AS jobs, COUNT(*) AS claims FROM job_claims
         WHERE (?1 IS NULL OR namespace = ?1) AND (?2 IS NULL OR agent = ?2)
           AND (?3 IS NULL OR recorded_at >= ?3) AND (?4 IS NULL OR recorded_at < ?4)
         GROUP BY agent, namespace ORDER BY agent, namespace LIMIT ?5`,
      )
      .bind(namespace, agent, since, until, CLAIMS_GROUP_LIMIT + 1)
      .all<ClaimCountRow>(),
    db
      .prepare(
        `SELECT c.agent AS agent, c.namespace AS namespace, e.name AS name, e.agreement AS agreement, COUNT(*) AS n
         FROM job_evaluations e JOIN job_claims c ON c.id = e.claim_id
         WHERE (?1 IS NULL OR c.namespace = ?1) AND (?2 IS NULL OR c.agent = ?2)
           AND (?3 IS NULL OR e.recorded_at >= ?3) AND (?4 IS NULL OR e.recorded_at < ?4)
         GROUP BY c.agent, c.namespace, e.name, e.agreement ORDER BY c.agent, c.namespace, e.name, e.agreement LIMIT ?5`,
      )
      .bind(namespace, agent, since, until, EVALUATION_ROWS + 1)
      .all<EvaluationCountRow>(),
    db
      .prepare(
        `SELECT a.agent AS agent, t.namespace AS namespace, t.kind AS kind, t.actor_kind AS actor_kind, t.waited_ms AS waited_ms
         FROM job_touches t LEFT JOIN (SELECT DISTINCT job_id, agent FROM job_claims) a ON a.job_id = t.job_id
         WHERE (?1 IS NULL OR t.namespace = ?1) AND (?2 IS NULL OR a.agent = ?2)
           AND (?3 IS NULL OR t.at >= ?3) AND (?4 IS NULL OR t.at < ?4)
         ORDER BY t.id LIMIT ?5`,
      )
      .bind(namespace, agent, since, until, TOUCH_ROWS + 1)
      .all<TouchFoldRow>(),
    // Each ended wait once: the latest gate row before the touch (what waited_ms measured from). The agent
    // filter is a test, not a join, so a job two agents claimed is not counted twice.
    db
      .prepare(
        `SELECT t.namespace AS namespace, t.actor_kind AS actor_kind, t.waited_ms AS waited_ms,
           (SELECT g.detail FROM job_touches g WHERE g.job_id = t.job_id AND g.kind = 'gate' AND g.id < t.id
            ORDER BY g.id DESC LIMIT 1) AS gate_detail
         FROM job_touches t
         WHERE t.waited_ms IS NOT NULL AND (?1 IS NULL OR t.namespace = ?1)
           AND (?2 IS NULL OR EXISTS (SELECT 1 FROM job_claims c WHERE c.job_id = t.job_id AND c.agent = ?2))
           AND (?3 IS NULL OR t.at >= ?3) AND (?4 IS NULL OR t.at < ?4)
         ORDER BY t.id LIMIT ?5`,
      )
      .bind(namespace, agent, since, until, TOUCH_ROWS + 1)
      .all<WaitFoldRow>(),
    // claim.usage as sent, whole in job_claims.raw; each claim is one session's total, so claims are summed.
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
         GROUP BY namespace ORDER BY namespace LIMIT ?5`,
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
    const counts: ClaimsAgreementCounts = group.evaluations[row.name] ?? {
      agree: 0,
      disagree: 0,
      unclaimed: 0,
      unchecked: 0,
    };
    // The table's CHECK allows only these four; saying so beats dropping an unknown schema.
    if (!(AGREEMENTS as readonly string[]).includes(row.agreement)) {
      throw new Error(
        `job_evaluations holds agreement '${row.agreement}', which this reader does not know`,
      );
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
    t.waited_ms_median = median(list, { round: true });
  }

  const ordered = [...groups.values()].sort(
    (a, b) =>
      (a.agent ?? "").localeCompare(b.agent ?? "") || a.namespace.localeCompare(b.namespace),
  );

  const ended = new Map<
    string,
    { namespace: string; gate_class: string; ended_by: string; list: number[] }
  >();
  for (const row of within("waits", waitRows.results, TOUCH_ROWS)) {
    const gate_class = gateClassOf(row.gate_detail);
    const key = JSON.stringify([row.namespace, gate_class, row.actor_kind]);
    const entry = ended.get(key) ?? {
      namespace: row.namespace,
      gate_class,
      ended_by: row.actor_kind,
      list: [],
    };
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
      waited_ms_median: median(e.list, { round: true }) as number,
    }))
    .sort(
      (a, b) =>
        b.waited_ms_total - a.waited_ms_total ||
        a.namespace.localeCompare(b.namespace) ||
        a.gate_class.localeCompare(b.gate_class),
    );

  const usage: ClaimsUsageRow[] = within("usage", usageRows.results, CLAIMS_GROUP_LIMIT).map(
    (r) => ({ namespace: r.namespace, ...usageTotals(r) }),
  );

  return { filter, groups: ordered, waits: waitsRanked, usage, truncated };
}
