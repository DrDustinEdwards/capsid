import type { Env } from "./env";
import type { OvernightPlan, PlanLane, SkippedJob } from "./ops-types/views";
import { resolveRepo } from "./github/client";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";

// THE OVERNIGHT PLAN AND THE MORNING DIGEST (capsid/research/design-automation-for-speed.md,
// D2). Both are read-only views through `capsid_work_jobs` action `list`
// (view "plan" and view "digest"), so no tool is added and a hand-started VS Code tab reads
// them with the credential it already holds.
//
// THE PLAN says what an overnight run of about eight hours should work, per repo:
//   - queued jobs, in priority order, that fit the budget. A gated job is planned too
//     (conventions 2.3: gates apply to risky steps, not whole jobs):
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

// THE POLICY DOCUMENT. `- heavy <namespace>` marks a repo whose suites are heavy,
// `- budget-minutes <n>` sets the night, `- estimate <namespace> <minutes>` overrides a
// namespace's estimate. Only lines that begin `- ` and name one of those are read; the
// rest is prose. An unrecognized rule line refuses the document, because a rule that
// silently did not apply reads as a repo that was planned correctly.

export interface OvernightPolicy {
  budget_minutes: number;
  // "all" when no document says otherwise.
  heavy: ReadonlySet<string> | "all";
  estimates: ReadonlyMap<string, number>;
}

export const DEFAULT_POLICY: OvernightPolicy = {
  budget_minutes: DEFAULT_BUDGET_MINUTES,
  heavy: "all",
  estimates: new Map(),
};

export function parseOvernightPolicy(
  body: string,
): { policy: OvernightPolicy } | { error: string } {
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
      if (args.length !== 1 || !ns.test(args[0]))
        return { error: `${where}: heavy takes one namespace` };
      heavy.add(args[0]);
    } else if (m[1] === "budget-minutes") {
      const n = Number(args[0]);
      if (args.length !== 1 || !Number.isInteger(n) || n < 60 || n > 1440)
        return { error: `${where}: budget-minutes takes one whole number from 60 to 1440` };
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

// A namespace's repo, or why it has none: no mapping, and a corrupt one, are different facts.
export type RepoOf = { repo: string } | { problem: string };

/** Why a queued job is not planned, or null when it is. Order is the order the reasons read best in. */
export function ineligibleReason(
  job: PlanJobRow,
  repoOf: ReadonlyMap<string, RepoOf>,
): string | null {
  if (job.required_scopes !== null && job.required_scopes !== "" && job.required_scopes !== "{}")
    return `requires flags a driver does not hold (${job.required_scopes.slice(0, 80)})`;
  if (job.min_record !== null && job.min_record !== "" && job.min_record !== "{}")
    return `requires a track record (min_record ${job.min_record.slice(0, 40)}), which a plan cannot check`;
  if (/^LATER\b/.test(job.title)) return "its title defers it (LATER)";
  const repo = repoOf.get(job.namespace);
  if (!repo) return `namespace ${job.namespace} was not resolved to a repo`;
  if ("problem" in repo)
    return `namespace ${job.namespace} has no usable repo, so there is no clone to run a session in: ${repo.problem}`;
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
  const ordered = [...input.jobs].sort(
    (a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at),
  );
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
    lane.jobs.push({
      id: job.id,
      namespace: job.namespace,
      title: job.title,
      priority: job.priority,
      estimate_minutes: est.minutes,
      estimate_source: est.source,
      gated: job.gate_required === 1,
    });
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

export async function readOvernightPlan(
  env: Env,
  args: { namespace?: string },
  now: Date,
): Promise<OvernightPlan & { for_namespace: string | null }> {
  const { results } = await env.DB.prepare(
    `SELECT id, namespace, title, priority, gate_required, required_scopes, min_record, blocked_count, created_at
     FROM jobs WHERE status = 'queued' ORDER BY priority DESC, created_at ASC LIMIT ?1`,
  )
    .bind(PLAN_JOBS_MAX + 1)
    .all<PlanJobRow>();
  const rows = results ?? [];
  const truncated = rows.length > PLAN_JOBS_MAX;
  const jobs = truncated ? rows.slice(0, PLAN_JOBS_MAX) : rows;

  // The policy document. Absent is the default, and a document that does not parse is the
  // default too, said aloud: a bad edit must not stop the night from having a plan.
  const doc = await env.DB.prepare(
    "SELECT body FROM documents WHERE namespace = ?1 AND path = ?2 AND status = 'published'",
  )
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
      policyState = {
        source: "document",
        note:
          policy.heavy === "all"
            ? "The document names no heavy repo, so every repo is treated as heavy."
            : null,
      };
    } else {
      policyState = {
        source: "invalid",
        note: `${OVERNIGHT_POLICY_NAMESPACE}/${OVERNIGHT_POLICY_PATH} was ignored: ${parsed.error}. The default applies.`,
      };
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
      const problem = errorMessage(err);
      logEvent(
        "OVERNIGHT_PLAN",
        { message: `OVERNIGHT_PLAN no repo for ${ns}: ${problem}` },
        { level: "error" },
      );
      repoOf.set(ns, { problem });
    }
  }
  const durations = await env.DB.prepare(
    `SELECT namespace, duration_minutes FROM job_outcomes WHERE blocked_count = 0 AND duration_minutes IS NOT NULL ORDER BY rowid DESC LIMIT ?1`,
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
    return own !== null
      ? { minutes: own, source: "record" }
      : { minutes: DEFAULT_ESTIMATE_MINUTES, source: "default" };
  };

  const plan = buildOvernightPlan({
    jobs,
    repoOf,
    estimateOf,
    policy,
    policyState,
    now,
    truncated,
  });
  if (!args.namespace) return { ...plan, for_namespace: null };
  // The plan is built over every namespace, because the heavy budget is shared across
  // repos, and then narrowed to what the caller asked for.
  const ns = args.namespace;
  return {
    ...plan,
    lanes: plan.lanes
      .filter((l) => l.namespaces.includes(ns))
      .map((l) => ({ ...l, jobs: l.jobs.filter((j) => j.namespace === ns) })),
    skipped: plan.skipped.filter((s) => s.namespace === ns),
    for_namespace: ns,
  };
}
