import type { Env } from "../env";
import { defaultBranchSha } from "../github";
import {
  parseScoresDoc,
  verifyAnchors,
  type MetricMap,
  type ScoresDoc,
} from "../improve-scores";
import {
  BUDGET_KEY,
  DEFAULT_CONDITION,
  maxAttemptsFor,
  scheduledFor,
  ROSTER,
  SCORES_PATH,
  chicagoDay,
  loopPauseReason,
  runId as makeRunId,
  runTaskPath,
  type ImproveMode,
  type RunCondition,
} from "../improve-schema";
import { selectBase } from "../improve-select";
import { candidateSkills } from "../improve-skills";
import { signTaskBody } from "../improve-task";
import {
  activeRun,
  improveAudit,
  improveDocStatements,
  monthSpend,
  pauseNamespace,
  pausedReason,
  priorDoc,
  readBest,
  readBudget,
  readMode,
  type AttemptRow,
} from "../improve-state";

// A synthetic attempt id with no improve_attempts row. It measures the base and is not
// an attempt at anything; giving it a row would make every attempt count off by one.
export const baselineId = (runIdValue: string) => `${runIdValue}-baseline`;

export async function readDoc(db: D1Database, namespace: string, path: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(namespace, path)
    .first<{ body: string | null }>();
  return row?.body ?? null;
}

export async function loadScores(env: Env, namespace: string): Promise<{ doc: ScoresDoc; refusal: string | null }> {
  const body = await readDoc(env.DB, namespace, SCORES_PATH);
  if (body === null) {
    const empty = parseScoresDoc(namespace, "");
    return { doc: empty, refusal: `${namespace}/${SCORES_PATH} does not exist. The loop cannot score a namespace with no scores document.` };
  }
  const doc = parseScoresDoc(namespace, body);
  const verification = await verifyAnchors(env.APP_KV, namespace, doc);
  return { doc, refusal: verification.refusal };
}

// The metric map for a run's baseline or one attempt. One reader for both sides of a
// comparison, so the two sides can never be assembled two different ways.
export async function metricsFor(db: D1Database, runIdValue: string, attemptIdValue: string | null): Promise<MetricMap> {
  const { results } = await db
    .prepare(
      attemptIdValue === null
        ? "SELECT metric, value FROM improve_scores WHERE run_id = ?1 AND attempt_id IS NULL"
        : "SELECT metric, value FROM improve_scores WHERE run_id = ?1 AND attempt_id = ?2"
    )
    .bind(...(attemptIdValue === null ? [runIdValue] : [runIdValue, attemptIdValue]))
    .all<{ metric: string; value: number | null }>();
  const map: MetricMap = {};
  for (const row of results) map[row.metric] = row.value;
  return map;
}

export function scoreStatements(
  db: D1Database,
  runIdValue: string,
  namespace: string,
  attemptIdValue: string | null,
  metrics: MetricMap
): D1PreparedStatement[] {
  return Object.entries(metrics).map(([metric, value]) =>
    db
      .prepare(
        "INSERT INTO improve_scores (namespace, metric, value, run_id, attempt_id) VALUES (?1, ?2, ?3, ?4, ?5)"
      )
      .bind(namespace, metric, value, runIdValue, attemptIdValue)
  );
}

// The loop's own hard stop, since Cloudflare's budget alerts are informational and
// cannot stop a Worker: monthly caps on Actions minutes and model spend, read from KV
// so they change without a deploy (defaults 300 minutes and $50), and checked by the
// opener and the tick before they open or advance anything.
export interface BudgetStatus {
  month: string;
  caps: { actions_minutes_month: number; model_usd_month: number };
  spend: { ci_minutes: number; cost_usd: number };
  exceeded: boolean;
  reason: string | null;
}

export async function checkBudget(env: Env, now: Date): Promise<BudgetStatus> {
  const caps = await readBudget(env.APP_KV);
  const month = caps.month ?? now.toISOString().slice(0, 7);
  const spend = await monthSpend(env.DB, `${month}-01 00:00:00`);
  const overMinutes = spend.ci_minutes > caps.actions_minutes_month;
  const overUsd = spend.cost_usd > caps.model_usd_month;
  const exceeded = overMinutes || overUsd;
  return {
    month,
    caps: { actions_minutes_month: caps.actions_minutes_month, model_usd_month: caps.model_usd_month },
    spend,
    exceeded,
    reason: exceeded
      ? `budget exceeded for ${month}: ` +
        (overMinutes ? `${spend.ci_minutes.toFixed(1)} of ${caps.actions_minutes_month} Actions minutes` : "") +
        (overMinutes && overUsd ? ", " : "") +
        (overUsd ? `$${spend.cost_usd.toFixed(2)} of $${caps.model_usd_month} model spend` : "") +
        `. Raise the caps in KV ${BUDGET_KEY} or wait for the month to turn.`
      : null,
  };
}

// Returns the refusal reason when a cap is exceeded, after pausing every roster
// namespace not already paused, so a five-minute tick does not rewrite the same KV
// keys forever. The pause is deliberate double coverage: the opener and tick refuse
// on their own, and the pause makes the stop visible in improve_status and holds
// against a code path that forgets to ask.
export async function enforceBudget(env: Env, now: Date): Promise<string | null> {
  const budget = await checkBudget(env, now);
  if (!budget.exceeded) return null;
  console.error(
    `IMPROVE_BUDGET_EXCEEDED month=${budget.month} actions_minutes=${budget.spend.ci_minutes.toFixed(1)}/${budget.caps.actions_minutes_month} model_usd=${budget.spend.cost_usd.toFixed(2)}/${budget.caps.model_usd_month}`
  );
  for (const namespace of ROSTER) {
    if (!(await pausedReason(env.APP_KV, namespace))) {
      await pauseNamespace(env.APP_KV, namespace, loopPauseReason("budget"));
    }
  }
  return budget.reason;
}

export interface OpenOutcome {
  namespace: string;
  opened: boolean;
  runId: string | null;
  // The commit a run would branch from. Set by the dry run only, because that is the
  // question a dry run answers; a real run records it on the row.
  base?: string | null;
  note: string;
}

export interface OpenSummary {
  mode: ImproveMode;
  modeNote: string | null;
  outcomes: OpenOutcome[];
}

// The nightly opener. In "off" it records scores and opens nothing. In
// "subscription" it does all the selection and writes a task document for a
// Claude Code session to execute. In "api" it opens a run for the tick to drive.
export async function openRuns(
  env: Env,
  now: Date,
  only?: string,
  condition: RunCondition = DEFAULT_CONDITION
): Promise<OpenSummary> {
  const { mode, reason } = await readMode(env.APP_KV);
  // One billed namespace per night plus the free one (scheduledFor). Opening every
  // namespace each night costs 19.2 billed minutes per attempt; the rotation costs one
  // namespace's worth. `only` still names a single namespace explicitly.
  const namespaces = only ? [only] : scheduledFor(now);

  // An exceeded cap opens nothing.
  const budgetReason = await enforceBudget(env, now);
  if (budgetReason) {
    return {
      mode,
      modeNote: reason,
      outcomes: namespaces.map((namespace) => ({ namespace, opened: false, runId: null, note: budgetReason })),
    };
  }

  const outcomes: OpenOutcome[] = [];
  for (const namespace of namespaces) {
    outcomes.push(await openOne(env, namespace, mode, now, condition));
  }
  return { mode, modeNote: reason, outcomes };
}

export async function openOne(
  env: Env,
  namespace: string,
  mode: ImproveMode,
  now: Date,
  condition: RunCondition,
  opts: { preview?: boolean } = {}
): Promise<OpenOutcome> {
  const preview = opts.preview === true;
  const paused = await pausedReason(env.APP_KV, namespace);
  if (paused) {
    return { namespace, opened: false, runId: null, note: preview ? `would skip: paused (${paused})` : `paused: ${paused}` };
  }

  const existing = await activeRun(env.DB, namespace);
  if (existing) {
    return {
      namespace,
      opened: false,
      runId: existing.id,
      note: preview
        ? `would skip: run ${existing.id} is active in '${existing.status}'`
        : `a run is already active in state '${existing.status}'`,
    };
  }

  const { doc, refusal } = await loadScores(env, namespace);
  if (refusal) {
    if (preview) return { namespace, opened: false, runId: null, note: `would refuse: ${refusal}` };
    // Written as a task document a human will see, not only logged: where a check
    // cannot run, block and name the reason (capsid/conventions.md).
    await writeTaskDoc(env, namespace, now, `# improve is blocked in ${namespace}\n\n${refusal}\n`);
    await env.DB.batch([improveAudit(env.DB, "improve-refused", namespace, { refusal })]);
    return { namespace, opened: false, runId: null, note: refusal };
  }

  if (preview) {
    const best = await readBest(env.APP_KV, namespace);
    const history = await recentAttempts(env.DB, namespace, 50);
    const defaultSha = await resolveDefaultSha(env, namespace);
    const choice = selectBase(best, history, defaultSha);
    return {
      namespace,
      opened: false,
      runId: null,
      base: choice.sha || null,
      note: `would open a run and baseline ${choice.sha || "(no base resolved)"}: ${choice.why}`,
    };
  }

  if (mode === "off") {
    return { namespace, opened: false, runId: null, note: "improve_mode is off; scores document verified, nothing run" };
  }

  const best = await readBest(env.APP_KV, namespace);
  const history = await recentAttempts(env.DB, namespace, 50);
  const defaultSha = await resolveDefaultSha(env, namespace);
  const choice = selectBase(best, history, defaultSha);

  if (mode === "subscription") {
    const skills = await candidateSkills(env.DB, namespace, 3);
    await writeTaskDoc(env, namespace, now, renderSubscriptionTask(namespace, now, doc, choice.why, choice.sha, skills));
    await env.DB.batch([improveAudit(env.DB, "improve-task-written", namespace, { mode, base: choice.sha })]);
    return { namespace, opened: false, runId: null, note: "subscription mode: task document written for a session to execute" };
  }

  const runIdValue = makeRunId(namespace, now);
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO improve_runs (id, namespace, mode, status, base_sha, condition)
         VALUES (?1, ?2, ?3, 'opening', ?4, ?5)`
      )
      .bind(runIdValue, namespace, mode, choice.sha || null, condition),
    // The condition is in the audit row too, so one audit_log query answers what the
    // loop did and under which condition.
    improveAudit(env.DB, "improve-run-opened", namespace, {
      run_id: runIdValue,
      base: choice.sha,
      why: choice.why,
      condition,
    }),
  ]);
  return { namespace, opened: true, runId: runIdValue, note: choice.why };
}

export async function recentAttempts(db: D1Database, namespace: string, limit: number): Promise<AttemptRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, namespace, run_id, change_summary, diff_ref, score_before, score_after, kept, reason,
              lineage_parent, status, branch, head_sha, base_sha, flagged, flag_reason, skill_id,
              anchors_json, secondary_json, dispatched_at, ts
       FROM improve_attempts WHERE namespace = ?1 ORDER BY ts DESC LIMIT ?2`
    )
    .bind(namespace, limit)
    .all<AttemptRow>();
  return results;
}

export function renderObjective(doc: ScoresDoc): string {
  return [
    "Anchors (must never regress; an anchor CI did not report counts as failed):",
    ...doc.anchors.map((a) => `- ${a.metric}: ${a.kind}${a.bound === null ? "" : ` ${a.bound}`}`),
    "",
    "Secondary (what you are optimising; a tie or a loss reverts the attempt):",
    ...doc.secondary.map(
      (s) => `- ${s.metric}: ${s.direction}, weight ${s.weight}${s.stub ? " (STUB, not scored yet)" : ""}`
    ),
  ].join("\n");
}

function renderSubscriptionTask(
  namespace: string,
  now: Date,
  doc: ScoresDoc,
  baseWhy: string,
  baseSha: string,
  skills: Array<{ id: string; title: string; winRate: number }>
): string {
  return [
    `# improve run ${chicagoDay(now)} - ${namespace}`,
    "",
    "type: task",
    "",
    "**Subscription mode.** The Worker did the selection; a Claude Code session does the work.",
    "It gathered the scores, verified the anchor checksum, and chose the base. Nothing has been",
    "changed in the repo. Execute the attempt list below with the ordinary Capsid tools.",
    "",
    "## Base",
    "",
    `- commit: \`${baseSha || "(none resolved; branch from the default branch)"}\``,
    `- why: ${baseWhy}`,
    "",
    "## What is measured",
    "",
    renderObjective(doc),
    "",
    "## Attempt list",
    "",
    `Up to ${maxAttemptsFor(namespace)} attempts. One scoped change each, on its own branch off the base above.`,
    "After each one, run the scorer and keep it only if no anchor regressed and the weighted",
    "secondary score improved. Revert otherwise. Stop after five consecutive reverts.",
    "",
    ...(skills.length > 0
      ? [
          "Candidate skills transferred from other projects, best first. Try one; do not force a fit:",
          ...skills.map((s) => `- \`${s.id}\` ${s.title} (win rate ${(s.winRate * 100).toFixed(0)}%)`),
        ]
      : ["No transferred skills are pending for this namespace."]),
    "",
    "## What you may not touch",
    "",
    "Tests, CI workflows, lint or compiler configuration, lockfiles, package manifests, anything",
    "under `improve/`, and this namespace's `improve/scores.md`. Those are what measure the work.",
    "",
  ].join("\n");
}

// Every task document is signed, because the `/improve` driver executes it and must
// tell the Worker's plan from anything else. Signing precedes dash normalization,
// which is safe because the rendered bodies contain no wide dashes. Without the
// secret the document is written unsigned, and the driver refuses it by name.
export async function writeTaskDoc(env: Env, namespace: string, now: Date, body: string): Promise<void> {
  const path = runTaskPath(chicagoDay(now));
  const prior = await priorDoc(env.DB, namespace, path);
  const signed = env.IMPROVE_SCORE_SECRET ? await signTaskBody(env.IMPROVE_SCORE_SECRET, body) : body;
  await env.DB.batch(
    await improveDocStatements(env.DB, {
      namespace,
      path,
      title: `improve run ${chicagoDay(now)}`,
      type: "task",
      status: "ready",
      action: "improve-task",
      prior,
      body: signed,
    })
  );
}

async function resolveDefaultSha(env: Env, namespace: string): Promise<string | null> {
  try {
    return await defaultBranchSha(env, namespace);
  } catch (err) {
    console.log(`IMPROVE_DEFAULT_SHA_UNRESOLVED ns=${namespace} ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
