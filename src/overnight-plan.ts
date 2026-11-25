import type { Env } from "./env";
import type { OvernightPlan, PlanLane, SkippedJob } from "./ops-types/views";
import { resolveRepo } from "./github/client";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";

// The overnight plan and morning digest (capsid/research/design-automation-for-speed.md, D2): read-only views of
// `capsid_work_jobs` list (view "plan"/"digest"), so no tool is added. The plan names, per repo, queued jobs in priority order that fit
// an eight-hour budget; a gated job is planned too (conventions 2.3) and marked `gated` so the session lists its risky step in the PR.
// One lane per repo; heavy repos share one budget; with no policy every repo is heavy (unknown fails closed). It starts nothing.

const OVERNIGHT_POLICY_NAMESPACE = "capsid";
const OVERNIGHT_POLICY_PATH = "policy/overnight.md";

export const DEFAULT_BUDGET_MINUTES = 480;
// Deliberately long: an estimate that is too short overfills the night.
export const DEFAULT_ESTIMATE_MINUTES = 60;
const MIN_SAMPLES = 5;
export const FLOOR_ESTIMATE_MINUTES = 15;
const PLAN_JOBS_MAX = 500;

// Policy document: `- heavy <ns>`, `- budget-minutes <n>`, `- estimate <ns> <minutes>`; other lines are prose. An unrecognized
// rule line refuses the document, since a rule that silently did not apply reads as a correctly planned repo.

export interface OvernightPolicy {
  budget_minutes: number;
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
  source: "policy" | "record" | "default";
}

export type RepoOf = { repo: string } | { problem: string };

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
    // A repo reached by two namespaces is heavy if either says so: its one session runs both.
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

  // Absent or unparseable is the default (the latter said aloud): a bad edit must not stop the night having a plan.
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

  const namespaces = [...new Set(jobs.map((j) => j.namespace))];
  const repoOf = new Map<string, RepoOf>();
  for (const ns of namespaces) {
    try {
      const { owner, repo } = await resolveRepo(env, ns);
      repoOf.set(ns, { repo: `${owner}/${repo}` });
    } catch (err) {
      // Said in the skip reason: an unmapped namespace and a corrupt mapping have different fixes.
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
  // Built over every namespace because the heavy budget is shared across repos, then narrowed to the caller's.
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
