import type { Env } from "./env";
import { resolveRepo } from "./github/client";
import { logEvent } from "./log";

// THE OVERNIGHT PLAN AND THE MORNING DIGEST (capsid/research/design-automation-for-speed.md,
// D2, ruled by Dustin 2026-10-04). Both are read-only views through `jobs` action `list`
// (view "plan" and view "digest"), so no tool is added and a hand-started VS Code tab reads
// them with the credential it already holds.
//
// THE PLAN says what an overnight run of about eight hours should work, per repo:
//   - queued jobs, in priority order, that fit the budget. A gated job is planned too
//     (conventions 2.3, Dustin 2026-10-07: gates apply to risky steps, not whole jobs):
//     the session does its ordinary work, lists each risky step in the pull request for
//     the seat, and moves on. It is marked `gated` so the session knows to. A parked job
//     is never read: the query takes only queued rows;
//   - one lane, so one session, per repo, however many namespaces map to it;
//   - repos that run heavy suites share one budget, because their sessions run one at a
//     time. With no policy document every repo counts as heavy: unknown fails closed.
// It plans; it starts nothing. A job that blocks stops only itself, and the next job in
// its lane is claimed by the session that was running it.
//
// THE DIGEST says what happened: pull requests ready, what blocked and why, and what each
// job cost, from the outcome row (telemetry) or the agent's own claim.usage, never summed.

const OVERNIGHT_POLICY_NAMESPACE = "capsid";
const OVERNIGHT_POLICY_PATH = "policy/overnight.md";

export const DEFAULT_BUDGET_MINUTES = 480;
// What a job is assumed to take when its namespace has too few unblocked outcomes to
// say. Deliberately on the long side: an estimate that is too short overfills the night.
export const DEFAULT_ESTIMATE_MINUTES = 60;
// Outcomes a namespace needs before its own record is trusted over the default.
export const MIN_SAMPLES = 5;
export const FLOOR_ESTIMATE_MINUTES = 15;
const PLAN_JOBS_MAX = 500;
const DIGEST_ROWS_MAX = 200;
const DIGEST_DEFAULT_HOURS = 24;
const SUMMARY_CHARS = 600;

// THE POLICY DOCUMENT. `- heavy <namespace>` marks a repo whose suites are heavy,
// `- budget-minutes <n>` sets the night, `- estimate <namespace> <minutes>` overrides a
// namespace's estimate. Only lines that begin `- ` and name one of those are read; the
// rest is prose. An unrecognised rule line refuses the document, because a rule that
// silently did not apply reads as a repo that was planned correctly.

export interface OvernightPolicy {
  budget_minutes: number;
  // "all" when no document says otherwise.
  heavy: ReadonlySet<string> | "all";
  estimates: ReadonlyMap<string, number>;
}

export const DEFAULT_POLICY: OvernightPolicy = { budget_minutes: DEFAULT_BUDGET_MINUTES, heavy: "all", estimates: new Map() };

export function parseOvernightPolicy(body: string): { policy: OvernightPolicy } | { error: string } {
  let budget = DEFAULT_BUDGET_MINUTES;
  const heavy = new Set<string>();
  const estimates = new Map<string, number>();
  for (const [index, raw] of body.split(/\r?\n/).entries()) {
    const line = raw.trim();
    const m = /^- (heavy|budget-minutes|estimate)(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    const where = `line ${index + 1} (${line.slice(0, 80)})`;
    const args = (m[2] ?? "").trim().split(/\s+/).filter(Boolean);
    const ns = /^[a-z0-9][a-z0-9-]{0,62}$/;
    if (m[1] === "heavy") {
      if (args.length !== 1 || !ns.test(args[0])) return { error: `${where}: heavy takes one namespace` };
      heavy.add(args[0]);
    } else if (m[1] === "budget-minutes") {
      const n = Number(args[0]);
      if (args.length !== 1 || !Number.isInteger(n) || n < 60 || n > 1440) return { error: `${where}: budget-minutes takes one whole number from 60 to 1440` };
      budget = n;
    } else {
      const n = Number(args[1]);
      if (args.length !== 2 || !ns.test(args[0]) || !Number.isInteger(n) || n < 5 || n > 720) {
        return { error: `${where}: estimate takes a namespace and whole minutes from 5 to 720` };
      }
      estimates.set(args[0], n);
    }
  }
  return { policy: { budget_minutes: budget, heavy: heavy.size > 0 ? heavy : "all", estimates } };
}

// THE PLAN.

export interface PlanJobRow {
  id: string;
  namespace: string;
  title: string;
  priority: number;
  gate_required: number;
  required_scopes: string | null;
  min_record: string | null;
  blocked_count: number;
  created_at: string;
}

export interface Estimate {
  minutes: number;
  // Where the number came from: the policy document, the namespace's own record, or the default.
  source: "policy" | "record" | "default";
}

export interface PlannedJob {
  id: string;
  namespace: string;
  title: string;
  priority: number;
  estimate_minutes: number;
  estimate_source: Estimate["source"];
  /** The job needs a human confirmation for a risky step (gate_required): the session
   *  does the ordinary work and lists that step in the pull request for the seat. */
  gated: boolean;
}

export interface PlanLane {
  repo: string;
  namespaces: string[];
  heavy: boolean;
  jobs: PlannedJob[];
  planned_minutes: number;
}

export interface SkippedJob {
  id: string;
  namespace: string;
  title: string;
  reason: string;
}

export interface OvernightPlan {
  generated: string;
  budget_minutes: number;
  // Where the heavy/light split came from, so "every repo is heavy" is never a surprise.
  policy: "document" | "default" | "invalid";
  policy_note: string | null;
  // Heavy lanes share this budget; their sessions run one at a time.
  heavy_planned_minutes: number;
  lanes: PlanLane[];
  skipped: SkippedJob[];
  // Counts beside the verdict, so an empty plan cannot pass for a clean one.
  queued_read: number;
  truncated: boolean;
}

// A namespace's repo, or why it has none: no mapping, and a corrupt one, are different facts.
export type RepoOf = { repo: string } | { problem: string };

/** Why a queued job is not planned, or null when it is. Order is the order the reasons read best in. */
export function ineligibleReason(job: PlanJobRow, repoOf: ReadonlyMap<string, RepoOf>): string | null {
  if (job.required_scopes !== null && job.required_scopes !== "" && job.required_scopes !== "{}") return `requires flags a driver does not hold (${job.required_scopes.slice(0, 80)})`;
  if (job.min_record !== null && job.min_record !== "" && job.min_record !== "{}") return `requires a track record (min_record ${job.min_record.slice(0, 40)}), which a plan cannot check`;
  if (/^LATER\b/.test(job.title)) return "its title defers it (LATER)";
  const repo = repoOf.get(job.namespace);
  if (!repo) return `namespace ${job.namespace} was not resolved to a repo`;
  if ("problem" in repo) return `namespace ${job.namespace} has no usable repo, so there is no clone to run a session in: ${repo.problem}`;
  return null;
}

export function buildOvernightPlan(input: {
  jobs: readonly PlanJobRow[];
  repoOf: ReadonlyMap<string, RepoOf>;
  estimateOf: (namespace: string) => Estimate;
  policy: OvernightPolicy;
  policyState: { source: OvernightPlan["policy"]; note: string | null };
  now: Date;
  truncated?: boolean;
}): OvernightPlan {
  const { policy } = input;
  const ordered = [...input.jobs].sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at));
  const skipped: SkippedJob[] = [];
  const lanes = new Map<string, PlanLane>();
  const isHeavy = (namespace: string) => policy.heavy === "all" || policy.heavy.has(namespace);
  // Minutes used per budget: one pool for every heavy repo, one per light repo.
  const HEAVY_POOL = "\u0000heavy";
  const used = new Map<string, number>();

  for (const job of ordered) {
    const why = ineligibleReason(job, input.repoOf);
    if (why) {
      skipped.push({ id: job.id, namespace: job.namespace, title: job.title, reason: why });
      continue;
    }
    const repo = (input.repoOf.get(job.namespace) as { repo: string }).repo;
    const heavy = isHeavy(job.namespace);
    const pool = heavy ? HEAVY_POOL : repo;
    const est = input.estimateOf(job.namespace);
    const before = used.get(pool) ?? 0;
    if (before + est.minutes > policy.budget_minutes) {
      skipped.push({
        id: job.id,
        namespace: job.namespace,
        title: job.title,
        reason: `does not fit: ${est.minutes} minutes on top of ${before} already planned in ${heavy ? "the heavy repos' shared budget" : repo} exceeds ${policy.budget_minutes}`,
      });
      continue;
    }
    used.set(pool, before + est.minutes);
    const lane = lanes.get(repo) ?? { repo, namespaces: [], heavy, jobs: [], planned_minutes: 0 };
    if (!lane.namespaces.includes(job.namespace)) lane.namespaces.push(job.namespace);
    // A repo reached by two namespaces is heavy if either says so, because its one session runs both.
    lane.heavy = lane.heavy || heavy;
    lane.jobs.push({ id: job.id, namespace: job.namespace, title: job.title, priority: job.priority, estimate_minutes: est.minutes, estimate_source: est.source, gated: job.gate_required === 1 });
    lane.planned_minutes += est.minutes;
    lanes.set(repo, lane);
  }

  return {
    generated: input.now.toISOString(),
    budget_minutes: policy.budget_minutes,
    policy: input.policyState.source,
    policy_note: input.policyState.note,
    heavy_planned_minutes: used.get(HEAVY_POOL) ?? 0,
    lanes: [...lanes.values()].sort((a, b) => a.repo.localeCompare(b.repo)),
    skipped,
    queued_read: input.jobs.length,
    truncated: input.truncated === true,
  };
}

/** The p75 of a namespace's unblocked-job durations, floored, or null with too few samples. */
export function estimateFromDurations(durations: readonly number[]): number | null {
  if (durations.length < MIN_SAMPLES) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  const p75 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.75) - 1)];
  return Math.max(FLOOR_ESTIMATE_MINUTES, Math.ceil(p75));
}

interface DurationRow {
  namespace: string;
  duration_minutes: number | null;
}

export async function readOvernightPlan(env: Env, args: { namespace?: string }, now: Date): Promise<OvernightPlan & { for_namespace: string | null }> {
  const { results } = await env.DB.prepare(
    `SELECT id, namespace, title, priority, gate_required, required_scopes, min_record, blocked_count, created_at
     FROM jobs WHERE status = 'queued' ORDER BY priority DESC, created_at ASC LIMIT ?1`
  )
    .bind(PLAN_JOBS_MAX + 1)
    .all<PlanJobRow>();
  const rows = results ?? [];
  const truncated = rows.length > PLAN_JOBS_MAX;
  const jobs = truncated ? rows.slice(0, PLAN_JOBS_MAX) : rows;

  // The policy document. Absent is the default, and a document that does not parse is the
  // default too, said aloud: a bad edit must not stop the night from having a plan.
  const doc = await env.DB.prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2 AND status = 'published'")
    .bind(OVERNIGHT_POLICY_NAMESPACE, OVERNIGHT_POLICY_PATH)
    .first<{ body: string | null }>();
  let policy = DEFAULT_POLICY;
  let policyState: { source: OvernightPlan["policy"]; note: string | null } = {
    source: "default",
    note: `No ${OVERNIGHT_POLICY_NAMESPACE}/${OVERNIGHT_POLICY_PATH}: a ${DEFAULT_BUDGET_MINUTES} minute night and every repo treated as heavy, so one session at a time.`,
  };
  if (doc?.body != null) {
    const parsed = parseOvernightPolicy(doc.body);
    if ("policy" in parsed) {
      policy = parsed.policy;
      policyState = { source: "document", note: policy.heavy === "all" ? "The document names no heavy repo, so every repo is treated as heavy." : null };
    } else {
      policyState = { source: "invalid", note: `${OVERNIGHT_POLICY_NAMESPACE}/${OVERNIGHT_POLICY_PATH} was ignored: ${parsed.error}. The default applies.` };
    }
  }

  // Each namespace's repo and estimate, read once.
  const namespaces = [...new Set(jobs.map((j) => j.namespace))];
  const repoOf = new Map<string, RepoOf>();
  for (const ns of namespaces) {
    try {
      const { owner, repo } = await resolveRepo(env, ns);
      repoOf.set(ns, { repo: `${owner}/${repo}` });
    } catch (err) {
      // Said in the skip reason, not swallowed: an unmapped namespace and a corrupt
      // mapping have different fixes.
      const problem = err instanceof Error ? err.message : String(err);
      logEvent("error", "OVERNIGHT_PLAN", { message: `OVERNIGHT_PLAN no repo for ${ns}: ${problem}` });
      repoOf.set(ns, { problem });
    }
  }
  const durations = await env.DB.prepare(
    `SELECT namespace, duration_minutes FROM job_outcomes WHERE blocked_count = 0 AND duration_minutes IS NOT NULL ORDER BY rowid DESC LIMIT ?1`
  )
    .bind(2000)
    .all<DurationRow>();
  const byNamespace = new Map<string, number[]>();
  for (const row of durations.results ?? []) {
    if (row.duration_minutes === null) continue;
    const list = byNamespace.get(row.namespace) ?? [];
    list.push(row.duration_minutes);
    byNamespace.set(row.namespace, list);
  }
  const estimateOf = (namespace: string): Estimate => {
    const fixed = policy.estimates.get(namespace);
    if (fixed !== undefined) return { minutes: fixed, source: "policy" };
    const own = estimateFromDurations(byNamespace.get(namespace) ?? []);
    return own !== null ? { minutes: own, source: "record" } : { minutes: DEFAULT_ESTIMATE_MINUTES, source: "default" };
  };

  const plan = buildOvernightPlan({ jobs, repoOf, estimateOf, policy, policyState, now, truncated });
  if (!args.namespace) return { ...plan, for_namespace: null };
  // The plan is built over every namespace, because the heavy budget is shared across
  // repos, and then narrowed to what the caller asked for.
  const ns = args.namespace;
  return {
    ...plan,
    lanes: plan.lanes.filter((l) => l.namespaces.includes(ns)).map((l) => ({ ...l, jobs: l.jobs.filter((j) => j.namespace === ns) })),
    skipped: plan.skipped.filter((s) => s.namespace === ns),
    for_namespace: ns,
  };
}

// THE DIGEST.

export interface UsageTotals {
  cost_usd: number | null;
  active_seconds: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  tokens_cache_creation: number | null;
}

const NO_USAGE: UsageTotals = { cost_usd: null, active_seconds: null, tokens_input: null, tokens_output: null, tokens_cache_read: null, tokens_cache_creation: null };

export type UsageSource = "telemetry" | "reported" | "none";

export interface DigestJob {
  id: string;
  namespace: string;
  title: string;
  status: string;
  result_kind: string | null;
  duration_minutes: number | null;
  blocked_count: number | null;
  usage: UsageTotals;
  usage_source: UsageSource;
}

export interface DigestBlocked {
  id: string;
  namespace: string;
  title: string;
  at: string;
  // The reason and the command, as the driver wrote them, cut to a readable length.
  summary: string;
  pull_requests: string[];
  usage: UsageTotals;
  usage_source: UsageSource;
}

export interface DigestPr {
  job_id: string;
  namespace: string;
  url: string;
  // merged: GitHub says merged. open: not merged (open or closed). unchecked: never read.
  state: "merged" | "open" | "unchecked";
  source: "outcome" | "blocked summary";
}

export interface OvernightDigest {
  generated: string;
  since: string;
  for_namespace: string | null;
  finished: DigestJob[];
  blocked: DigestBlocked[];
  pull_requests_ready: DigestPr[];
  pull_requests_merged: number;
  // Per source, never one added to the other: a job in both would count twice.
  totals: { telemetry: UsageTotals & { jobs: number }; reported: UsageTotals & { jobs: number }; jobs_without_usage: number };
  truncated: string[];
}

interface OutcomeRow {
  job_id: string;
  namespace: string;
  title: string | null;
  status: string | null;
  result_kind: string | null;
  duration_minutes: number | null;
  blocked_count: number | null;
  cost_usd: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  tokens_cache_creation: number | null;
  active_seconds: number | null;
}

interface BlockedRow {
  id: string;
  namespace: string;
  title: string;
  result_summary: string | null;
  updated_at: string;
}

interface PrRow {
  job_id: string;
  namespace: string;
  pr_url: string;
  merged: number | null;
}

interface ReportedRow extends UsageTotals {
  job_id: string;
}

const PR_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;

export const pullRequestsIn = (text: string | null): string[] => [...new Set(text?.match(PR_URL) ?? [])];

const hasUsage = (u: UsageTotals): boolean => Object.values(u).some((v) => v !== null);

const sum = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

function addUsage(total: UsageTotals, u: UsageTotals): UsageTotals {
  return {
    cost_usd: sum(total.cost_usd, u.cost_usd),
    active_seconds: sum(total.active_seconds, u.active_seconds),
    tokens_input: sum(total.tokens_input, u.tokens_input),
    tokens_output: sum(total.tokens_output, u.tokens_output),
    tokens_cache_read: sum(total.tokens_cache_read, u.tokens_cache_read),
    tokens_cache_creation: sum(total.tokens_cache_creation, u.tokens_cache_creation),
  };
}

/** One job's usage: the telemetry on its outcome row if any, else what the agent reported, else none. */
export function chooseUsage(telemetry: UsageTotals, reported: UsageTotals | undefined): { usage: UsageTotals; source: UsageSource } {
  if (hasUsage(telemetry)) return { usage: telemetry, source: "telemetry" };
  if (reported && hasUsage(reported)) return { usage: reported, source: "reported" };
  return { usage: NO_USAGE, source: "none" };
}

export function digestSinceFrom(since: string | undefined, now: Date): { ok: true; since: string } | { ok: false; refusal: string } {
  if (since === undefined || since.trim() === "") return { ok: true, since: new Date(now.getTime() - DIGEST_DEFAULT_HOURS * 3_600_000).toISOString() };
  const parsed = Date.parse(since);
  if (!/^\d{4}-\d{2}-\d{2}(T|$)/.test(since) || Number.isNaN(parsed)) {
    return { ok: false, refusal: `since must be an ISO 8601 time such as 2026-10-04 or 2026-10-04T22:00:00Z; got '${since}'.` };
  }
  return { ok: true, since: new Date(parsed).toISOString() };
}

export async function readOvernightDigest(env: Env, args: { namespace?: string; since: string }, now: Date): Promise<OvernightDigest> {
  const ns = args.namespace ?? null;
  const bound = DIGEST_ROWS_MAX + 1;
  const [outcomes, blocked, prs, reported] = await Promise.all([
    env.DB.prepare(
      `SELECT o.job_id AS job_id, o.namespace AS namespace, j.title AS title, j.status AS status, o.result_kind AS result_kind,
         o.duration_minutes AS duration_minutes, o.blocked_count AS blocked_count, o.cost_usd AS cost_usd,
         o.tokens_input AS tokens_input, o.tokens_output AS tokens_output, o.tokens_cache_read AS tokens_cache_read,
         o.tokens_cache_creation AS tokens_cache_creation, o.active_seconds AS active_seconds
       FROM job_outcomes o LEFT JOIN jobs j ON j.id = o.job_id
       WHERE o.recorded_at >= ?1 AND (?2 IS NULL OR o.namespace = ?2) ORDER BY o.recorded_at DESC LIMIT ?3`
    )
      .bind(args.since, ns, bound)
      .all<OutcomeRow>(),
    env.DB.prepare(
      `SELECT id, namespace, title, result_summary, updated_at FROM jobs
       WHERE status = 'blocked' AND updated_at >= ?1 AND (?2 IS NULL OR namespace = ?2) ORDER BY updated_at DESC LIMIT ?3`
    )
      .bind(args.since, ns, bound)
      .all<BlockedRow>(),
    env.DB.prepare(
      `SELECT p.job_id AS job_id, o.namespace AS namespace, p.pr_url AS pr_url, p.merged AS merged
       FROM job_outcome_prs p JOIN job_outcomes o ON o.job_id = p.job_id
       WHERE o.recorded_at >= ?1 AND (?2 IS NULL OR o.namespace = ?2) ORDER BY o.recorded_at DESC LIMIT ?3`
    )
      .bind(args.since, ns, bound)
      .all<PrRow>(),
    // What each job's agent reported (claim.usage), summed per job. The job set is a
    // subquery on the same window, never a list of ids: D1 allows 100 bound parameters.
    env.DB.prepare(
      `SELECT job_id,
         SUM(json_extract(raw, '$.claim.usage.cost_usd')) AS cost_usd,
         SUM(json_extract(raw, '$.claim.usage.active_seconds')) AS active_seconds,
         SUM(json_extract(raw, '$.claim.usage.tokens.input')) AS tokens_input,
         SUM(json_extract(raw, '$.claim.usage.tokens.output')) AS tokens_output,
         SUM(json_extract(raw, '$.claim.usage.tokens.cache_read')) AS tokens_cache_read,
         SUM(json_extract(raw, '$.claim.usage.tokens.cache_creation')) AS tokens_cache_creation
       FROM job_claims
       WHERE json_extract(raw, '$.claim.usage') IS NOT NULL
         AND job_id IN (SELECT job_id FROM job_outcomes WHERE recorded_at >= ?1 AND (?2 IS NULL OR namespace = ?2)
                        UNION SELECT id FROM jobs WHERE status = 'blocked' AND updated_at >= ?1 AND (?2 IS NULL OR namespace = ?2))
       GROUP BY job_id LIMIT ?3`
    )
      .bind(args.since, ns, bound)
      .all<ReportedRow>(),
  ]);

  const truncated: string[] = [];
  const within = <T>(name: string, rows: T[] | undefined): T[] => {
    const list = rows ?? [];
    if (list.length <= DIGEST_ROWS_MAX) return list;
    truncated.push(name);
    return list.slice(0, DIGEST_ROWS_MAX);
  };
  const reportedBy = new Map(within("reported", reported.results).map((r) => [r.job_id, r]));
  const reportedOf = (id: string): UsageTotals | undefined => {
    const r = reportedBy.get(id);
    return r ? { cost_usd: r.cost_usd, active_seconds: r.active_seconds, tokens_input: r.tokens_input, tokens_output: r.tokens_output, tokens_cache_read: r.tokens_cache_read, tokens_cache_creation: r.tokens_cache_creation } : undefined;
  };

  const totals = {
    telemetry: { ...NO_USAGE, jobs: 0 },
    reported: { ...NO_USAGE, jobs: 0 },
    jobs_without_usage: 0,
  };
  const tally = (source: UsageSource, usage: UsageTotals) => {
    if (source === "none") {
      totals.jobs_without_usage += 1;
      return;
    }
    totals[source] = { ...addUsage(totals[source], usage), jobs: totals[source].jobs + 1 };
  };

  const finished: DigestJob[] = within("finished", outcomes.results).map((r) => {
    const telemetry: UsageTotals = {
      cost_usd: r.cost_usd,
      active_seconds: r.active_seconds,
      tokens_input: r.tokens_input,
      tokens_output: r.tokens_output,
      tokens_cache_read: r.tokens_cache_read,
      tokens_cache_creation: r.tokens_cache_creation,
    };
    const { usage, source } = chooseUsage(telemetry, reportedOf(r.job_id));
    tally(source, usage);
    return {
      id: r.job_id,
      namespace: r.namespace,
      title: r.title ?? "(job row not found)",
      status: r.status ?? "unknown",
      result_kind: r.result_kind,
      duration_minutes: r.duration_minutes,
      blocked_count: r.blocked_count,
      usage,
      usage_source: source,
    };
  });

  const blockedJobs: DigestBlocked[] = within("blocked", blocked.results).map((r) => {
    const { usage, source } = chooseUsage(NO_USAGE, reportedOf(r.id));
    tally(source, usage);
    return {
      id: r.id,
      namespace: r.namespace,
      title: r.title,
      at: r.updated_at,
      summary: (r.result_summary ?? "").slice(0, SUMMARY_CHARS),
      pull_requests: pullRequestsIn(r.result_summary),
      usage,
      usage_source: source,
    };
  });

  const prRows = within("pull_requests", prs.results);
  const ready: DigestPr[] = prRows
    .filter((p) => p.merged !== 1)
    .map((p) => ({ job_id: p.job_id, namespace: p.namespace, url: p.pr_url, state: p.merged === 0 ? ("open" as const) : ("unchecked" as const), source: "outcome" as const }));
  const seen = new Set(ready.map((p) => p.url));
  for (const b of blockedJobs) {
    for (const url of b.pull_requests) {
      if (seen.has(url)) continue;
      seen.add(url);
      ready.push({ job_id: b.id, namespace: b.namespace, url, state: "unchecked", source: "blocked summary" });
    }
  }

  return {
    generated: now.toISOString(),
    since: args.since,
    for_namespace: ns,
    finished,
    blocked: blockedJobs,
    pull_requests_ready: ready,
    pull_requests_merged: prRows.filter((p) => p.merged === 1).length,
    totals,
    truncated,
  };
}
