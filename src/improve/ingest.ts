import type { Env } from "../env";
import { monitorAttempt, type MonitorVerdict } from "../improve-gates";
import {
  estimatedScorerMinutes,
  maxAttemptsFor,
  MAX_CONSECUTIVE_REVERTS,
  MAX_CONSECUTIVE_UNJUDGED,
  meteredMinutes,
  isUnjudged,
  UNJUDGED_STATUSES,
  type BestRecord,
} from "../improve-schema";
import { checkHoldout, readHoldoutManifest, type ScoreReport } from "../improve-scorer";
import { anchorVerdict, compare, type Comparison, type MetricMap } from "../improve-scores";
import { abstractSkill, recordSkill } from "../improve-skills";
import { attributionStatements } from "../skills-records";
import {
  advanceRun,
  attemptById,
  improveAudit,
  improveDocStatements,
  pausedReason,
  priorDoc,
  readMode,
  runById,
  writeBest,
  type AttemptRow,
  type RunRow,
} from "../improve-state";
import { changedPathsFrom, renderOutcome } from "./finalize";
import { baselineId, checkBudget, loadScores, metricsFor, readDoc, scoreStatements } from "./open";

export interface IngestResult {
  ok: boolean;
  message: string;
  kept?: boolean;
}

/**
 * Replaces the estimate `dispatchScorer` booked with the reported figure, rather than
 * adding to it, which would charge every run twice. No outbound call: this path runs
 * on every report, and a revert must not fail for a network reason. Clamped at zero
 * so the month cannot go negative. An unknown duration (reported as 0) keeps the
 * estimate, since no real run takes zero minutes.
 */
export function settledMinutes(run: Pick<RunRow, "namespace" | "ci_minutes">, reported: number): number {
  if (!(Number.isFinite(reported) && reported > 0)) return run.ci_minutes;
  return Math.max(0, run.ci_minutes - estimatedScorerMinutes(run.namespace) + meteredMinutes(run.namespace, reported));
}

// Shared by the scored path and the late-report path, whose UPDATEs differ only in
// which statuses they accept.
async function monitorArchivedChange(
  env: Env,
  run: RunRow,
  attempt: AttemptRow
): Promise<{ change: string; monitor: MonitorVerdict }> {
  const change = (await readDoc(env.DB, run.namespace, attempt.diff_ref ?? "")) ?? "";
  const monitor = await monitorAttempt(env, {
    changedPaths: changedPathsFrom(change),
    changeSummary: attempt.change_summary ?? "",
    reasoning: change,
    diff: change,
  });
  return { change, monitor };
}

// Binds ?1 to ?10 of the attempt verdict UPDATE: id, status, kept, reason,
// score_before, score_after, flagged, flag_reason, anchors_json, secondary_json.
function attemptVerdictBinds(
  attempt: AttemptRow,
  v: { keep: boolean; reason: string; monitor: MonitorVerdict; comparison: Comparison; anchors: MetricMap; secondary: MetricMap }
): unknown[] {
  return [
    attempt.id,
    v.monitor.flagged ? "flagged" : v.keep ? "kept" : "reverted",
    v.keep ? 1 : 0,
    v.reason,
    v.comparison.scoreBefore,
    v.comparison.scoreAfter,
    v.monitor.flagged ? 1 : 0,
    v.monitor.reason,
    JSON.stringify(v.anchors),
    JSON.stringify(v.secondary),
  ];
}

// Called from /improve/score after the signature verified. Runs in an HTTP request,
// not a tick, so it has room to decide.
export async function ingestScore(env: Env, report: ScoreReport, now: Date): Promise<IngestResult> {
  const run = await runById(env.DB, report.run_id);
  if (!run) return { ok: false, message: `unknown run ${report.run_id}` };
  if (run.namespace !== report.namespace) {
    return { ok: false, message: `report namespace '${report.namespace}' does not match run ${run.id} ('${run.namespace}')` };
  }

  // Pause, mode off and the budget cap apply here too, so a stop also stops the
  // in-flight attempt, not only new work.
  const paused = await pausedReason(env.APP_KV, run.namespace);
  if (paused) {
    return { ok: false, message: `${run.namespace} is paused (${paused}); this score is not ingested and the attempt is not kept. Delete the pause key to resume.` };
  }
  const { mode: currentMode } = await readMode(env.APP_KV);
  if (currentMode === "off") {
    return { ok: false, message: `improve_mode is off; this score is not ingested and the attempt is not kept.` };
  }
  const budget = await checkBudget(env, now);
  if (budget.exceeded) {
    return { ok: false, message: `${budget.reason}; this score is not ingested and the attempt is not kept.` };
  }

  // The holdout check comes before anything in the report is believed.
  const manifest = await readHoldoutManifest(env, run.namespace);
  const holdout = checkHoldout(manifest, report);

  const anchors: MetricMap = { ...report.anchors, holdout_pass_rate: holdout.passRate };
  const isBaseline = report.attempt_id === baselineId(run.id);

  if (isBaseline) {
    // Bound like an attempt, or a rerun or hand dispatch could overwrite the baseline
    // every later comparison uses. The run must be awaiting it, and the report must
    // carry base_sha, which is the baseline branch's head.
    if (run.current_attempt !== report.attempt_id) {
      return {
        ok: true,
        message: `run ${run.id} is not awaiting its baseline (current attempt: ${run.current_attempt ?? "none"}); ignored as a duplicate or stale baseline report`,
      };
    }
    if ((run.base_sha ?? "") !== report.head_sha) {
      return {
        ok: false,
        message: `baseline report head_sha ${report.head_sha} does not match run ${run.id} base_sha ${run.base_sha ?? "(none)"}: the report measured a different commit`,
      };
    }
    const moved = await advanceRun(env.DB, { runId: run.id, expected: "awaiting-score", next: "judging" });
    if (!moved) return { ok: true, message: "baseline already ingested; nothing to do" };
    await env.DB.batch([
      ...scoreStatements(env.DB, run.id, run.namespace, null, { ...anchors, ...report.secondary }),
      improveAudit(env.DB, "improve-baseline", run.namespace, { run_id: run.id, anchors, holdout: holdout.refusal }),
    ]);
    const verdict = anchorVerdict((await loadScores(env, run.namespace)).doc.anchors, anchors);
    if (!verdict.passed) {
      // The base fails its own anchors, so nothing can be judged and the run stops. A
      // lost CAS means a tick reclaimed the run mid-ingest, and the message says so.
      const stopped = await advanceRun(env.DB, {
        runId: run.id,
        expected: "judging",
        next: "finalizing",
        patch: { note: `the base commit fails its own anchors: ${verdict.reasons.join("; ")}`, ci_minutes: settledMinutes(run, report.ci_minutes) },
      });
      return {
        ok: true,
        message: stopped
          ? "baseline recorded; the base fails its own anchors, so the run stops"
          : "baseline recorded; the base fails its own anchors, but the run moved out of judging mid-ingest and was not transitioned here",
      };
    }
    const resumed = await advanceRun(env.DB, { runId: run.id, expected: "judging", next: "attempting", patch: { current_attempt: null, ci_minutes: settledMinutes(run, report.ci_minutes) } });
    return {
      ok: true,
      message: resumed ? "baseline recorded" : "baseline recorded, but the run moved out of judging mid-ingest and was not transitioned here",
    };
  }

  const attempt = await attemptById(env.DB, report.attempt_id);
  if (!attempt) return { ok: false, message: `unknown attempt ${report.attempt_id}` };

  // Bind the report to the run's in-flight attempt, so a replayed or hand-dispatched
  // report cannot score another attempt or another commit:
  //   1. the attempt belongs to this run,
  //   2. the run is awaiting a score for this attempt, and
  //   3. the report scored the commit the attempt pushed.
  if (attempt.run_id !== run.id) {
    return { ok: false, message: `attempt ${attempt.id} belongs to run ${attempt.run_id}, not ${run.id}` };
  }
  if (run.status !== "awaiting-score" || run.current_attempt !== report.attempt_id) {
    // A late report for an unjudged attempt is its only measurement. The run has moved
    // on, so it is recorded on the attempt row only (see recordLateScore). An attempt
    // with a real verdict gets no second one.
    if (isUnjudged(attempt.status)) {
      return await recordLateScore(env, run, attempt, report);
    }
    return {
      ok: true,
      message: `run ${run.id} is not awaiting a score for ${report.attempt_id}; ignored as a duplicate or stale report`,
    };
  }
  if ((attempt.head_sha ?? "") !== report.head_sha) {
    return {
      ok: false,
      message: `report head_sha ${report.head_sha} does not match attempt ${attempt.id} head_sha ${attempt.head_sha ?? "(none)"}: the report scored a different commit`,
    };
  }

  const moved = await advanceRun(env.DB, { runId: run.id, expected: "awaiting-score", next: "judging" });
  if (!moved) return { ok: true, message: `run ${run.id} is not awaiting a score; this report is a duplicate and was ignored` };

  // A broken machine is not a bad change. When the scorer reports an environment
  // failure or the hidden suite did not arrive, the attempt is left unjudged, before
  // any model call is spent. MAX_CONSECUTIVE_UNJUDGED bounds the repeats.
  const environmentFailure = report.environment?.ok === false
    ? report.environment.reason ?? "the scorer reported an environment failure"
    : !holdout.ok && holdout.environmental
      ? holdout.refusal
      : null;
  if (environmentFailure) {
    return await recordUnjudged(env, run, attempt, report, environmentFailure);
  }

  const { doc } = await loadScores(env, run.namespace);
  const baseline = await metricsFor(env.DB, run.id, null);
  const comparison = compare(doc.secondary, baseline, report.secondary);
  const anchorsVerdict = anchorVerdict(doc.anchors, anchors);

  // The monitor's verdict outranks the score: a change that games the scorer scores well.
  const { change, monitor } = await monitorArchivedChange(env, run, attempt);

  const holdoutFailed = !holdout.ok;
  const keep = !monitor.flagged && !holdoutFailed && anchorsVerdict.passed && comparison.improved;
  const reason = monitor.flagged
    ? `reverted by the reward-hacking monitor (${monitor.source}): ${monitor.reason}`
    : holdoutFailed
      ? `reverted: ${holdout.refusal}`
      : !anchorsVerdict.passed
        ? `reverted on an anchor: ${anchorsVerdict.reasons.join("; ")}`
        : comparison.improved
          ? `kept: ${comparison.reason}`
          : `reverted: ${comparison.reason}`;

  const consecutive = keep ? 0 : run.consecutive_reverts + 1;
  const archive = attempt.diff_ref;

  await env.DB.batch([
    env.DB
      .prepare(
        // Keyed on awaiting-score, so a duplicate write cannot flip a timed-out
        // attempt or score one twice.
        `UPDATE improve_attempts
         SET status = ?2, kept = ?3, reason = ?4, score_before = ?5, score_after = ?6,
             flagged = ?7, flag_reason = ?8, anchors_json = ?9, secondary_json = ?10
         WHERE id = ?1 AND status = 'awaiting-score'
         RETURNING id`
      )
      .bind(
        ...attemptVerdictBinds(attempt, { keep, reason, monitor, comparison, anchors, secondary: report.secondary })
      ),
    ...scoreStatements(env.DB, run.id, run.namespace, attempt.id, { ...anchors, ...report.secondary }),
    // Scored, so the skill was used: kept is a win, reverted a loss.
    ...(attempt.skill_id
      ? attributionStatements(env.DB, {
          offered: [attempt.skill_id],
          used: [attempt.skill_id],
          signal: keep ? "verified-success" : "verified-failure",
        })
      : []),
    ...(archive
      ? await improveDocStatements(env.DB, {
          namespace: run.namespace,
          path: archive,
          title: `improve attempt ${attempt.id}`,
          type: "reference",
          action: "improve-attempt-scored",
          prior: await priorDoc(env.DB, run.namespace, archive),
          body: `${(await readDoc(env.DB, run.namespace, archive)) ?? ""}\n\n${renderOutcome({ keep, reason, monitor, comparison, anchors, report, now })}`,
        })
      : []),
    improveAudit(env.DB, keep ? "improve-kept" : "improve-reverted", run.namespace, {
      run_id: run.id,
      attempt_id: attempt.id,
      reason,
      delta: comparison.delta,
      flagged: monitor.flagged,
    }),
  ]);

  if (keep) {
    const record: BestRecord = {
      sha: attempt.head_sha ?? run.base_sha ?? "",
      run_id: run.id,
      attempt_id: attempt.id,
      recorded_at: now.toISOString(),
      anchors,
      secondary: report.secondary,
      score: comparison.scoreAfter,
    };
    await writeBest(env.APP_KV, run.namespace, record);
    // A kept change is the only thing worth abstracting into a skill.
    await maybeAbstract(env, run, attempt, change, comparison.delta);
  }

  const attemptCap = maxAttemptsFor(run.namespace);
  const ceiling = run.attempts >= attemptCap;
  const exhausted = consecutive >= MAX_CONSECUTIVE_REVERTS;
  // If a tick reclaimed the run mid-judging, the counters are not advanced here and
  // the caller is told so.
  const advanced = await advanceRun(env.DB, {
    runId: run.id,
    expected: "judging",
    next: ceiling || exhausted ? "finalizing" : "attempting",
    patch: {
      kept: run.kept + (keep ? 1 : 0),
      reverts: run.reverts + (keep ? 0 : 1),
      consecutive_reverts: consecutive,
      current_attempt: null,
      cost_usd: run.cost_usd + monitor.costUsd,
      ci_minutes: settledMinutes(run, report.ci_minutes),
      ...(exhausted
        ? { note: `${consecutive} consecutive reverts; restored to the best known commit and stopped` }
        : ceiling
          ? { note: `reached the ${attemptCap} attempt ceiling` }
          : {}),
    },
  });

  return {
    ok: true,
    message: advanced ? reason : `${reason} (the run moved out of judging mid-ingest; its counters were not updated here)`,
    kept: keep,
  };
}

// Nothing was measured, so only the unjudged counter moves. Not written: reverts
// (they mean measured and rejected, and restore to best), skill attribution (a skill
// is not worse for a broken runner), scores (they were produced by the failure), and
// best.
async function recordUnjudged(
  env: Env,
  run: RunRow,
  attempt: AttemptRow,
  report: ScoreReport,
  why: string
): Promise<IngestResult> {
  const reason = `unjudged: ${why}`;
  const consecutive = run.consecutive_unjudged + 1;
  const exhausted = consecutive >= MAX_CONSECUTIVE_UNJUDGED;

  await env.DB.batch([
    env.DB
      .prepare(
        // Status-keyed like the judging write.
        `UPDATE improve_attempts
         SET status = 'unjudged', kept = 0, reason = ?2
         WHERE id = ?1 AND status = 'awaiting-score'
         RETURNING id`
      )
      .bind(attempt.id, reason),
    improveAudit(env.DB, "improve-unjudged", run.namespace, {
      run_id: run.id,
      attempt_id: attempt.id,
      reason: why,
      consecutive_unjudged: consecutive,
    }),
  ]);

  const advanced = await advanceRun(env.DB, {
    runId: run.id,
    expected: "judging",
    next: exhausted || run.attempts >= maxAttemptsFor(run.namespace) ? "finalizing" : "attempting",
    patch: {
      consecutive_unjudged: consecutive,
      current_attempt: null,
      ci_minutes: settledMinutes(run, report.ci_minutes),
      ...(exhausted ? { note: unjudgedCeilingNote(consecutive) } : {}),
    },
  });

  return {
    ok: true,
    message: advanced ? reason : `${reason} (the run moved out of judging mid-ingest; its counters were not updated here)`,
    kept: false,
  };
}

// Names the machine, because no attempt reached a verdict.
export function unjudgedCeilingNote(consecutive: number): string {
  return (
    `${consecutive} attempts in a row could not be scored: the scoring environment failed each time. ` +
    `Nothing was measured, so no attempt was reverted and the namespace was left where it is. ` +
    `Check the scorer workflow before the next run.`
  );
}

// The same judgement as ingestScore, written only to the attempt row: keyed on the
// unjudged statuses, the run untouched (it moved on), and no improve:best or pull
// request (the base is stale). The monitor still runs, because a kept row becomes a
// base candidate in selectBase.
async function recordLateScore(
  env: Env,
  run: RunRow,
  attempt: AttemptRow,
  report: ScoreReport
): Promise<IngestResult> {
  const manifest = await readHoldoutManifest(env, run.namespace);
  const holdout = checkHoldout(manifest, report);
  const anchors: MetricMap = { ...report.anchors, holdout_pass_rate: holdout.passRate };

  // A late report that also says the machine broke adds nothing.
  if (report.environment?.ok === false || (!holdout.ok && holdout.environmental)) {
    return {
      ok: true,
      message: `a late report for ${attempt.id} also reports an environment failure; the attempt stays unjudged`,
    };
  }

  const { doc } = await loadScores(env, run.namespace);
  const baseline = await metricsFor(env.DB, run.id, null);
  const comparison = compare(doc.secondary, baseline, report.secondary);
  const anchorsVerdict = anchorVerdict(doc.anchors, anchors);
  const { monitor } = await monitorArchivedChange(env, run, attempt);

  const keep = !monitor.flagged && holdout.ok && anchorsVerdict.passed && comparison.improved;
  const verdict = monitor.flagged
    ? `flagged by the reward-hacking monitor (${monitor.source}): ${monitor.reason}`
    : !holdout.ok
      ? holdout.refusal ?? "the holdout was refused"
      : !anchorsVerdict.passed
        ? `failed an anchor: ${anchorsVerdict.reasons.join("; ")}`
        : comparison.improved
          ? `improved: ${comparison.reason}`
          : `no improvement: ${comparison.reason}`;
  const reason = `late report, after the run stopped waiting: ${verdict}`;

  const { results } = await env.DB
    .prepare(
      `UPDATE improve_attempts
       SET status = ?2, kept = ?3, reason = ?4, score_before = ?5, score_after = ?6,
           flagged = ?7, flag_reason = ?8, anchors_json = ?9, secondary_json = ?10
       WHERE id = ?1 AND status IN (${UNJUDGED_STATUSES.map((s) => `'${s}'`).join(", ")})
       RETURNING id`
    )
    .bind(
      ...attemptVerdictBinds(attempt, { keep, reason, monitor, comparison, anchors, secondary: report.secondary })
    )
    .all<{ id: string }>();

  // The row left the unjudged statuses since the read; what it says now outranks this.
  if (results.length === 0) {
    return { ok: true, message: `${attempt.id} is no longer unjudged; the late report was ignored` };
  }

  await env.DB.batch([
    // As in ingestScore: scored, so the skill was used.
    ...(attempt.skill_id
      ? attributionStatements(env.DB, {
          offered: [attempt.skill_id],
          used: [attempt.skill_id],
          signal: keep ? "verified-success" : "verified-failure",
        })
      : []),
    improveAudit(env.DB, "improve-late-score", run.namespace, {
      run_id: run.id,
      attempt_id: attempt.id,
      reason,
      kept: keep,
      flagged: monitor.flagged,
      note: "recorded on the attempt row only; the run had already moved on",
    }),
  ]);

  return { ok: true, message: reason, kept: keep };
}

async function maybeAbstract(env: Env, run: RunRow, attempt: AttemptRow, change: string, delta: number): Promise<void> {
  try {
    const abstracted = await abstractSkill(env, {
      namespace: run.namespace,
      summary: attempt.change_summary ?? "",
      reasoning: change,
      change,
      delta,
    });
    if (!abstracted.transferable) return;
    await recordSkill(env, {
      id: `${attempt.id}-skill`,
      sourceNamespace: run.namespace,
      sourceAttempt: attempt.id,
      title: abstracted.title,
      body: abstracted.body,
    });
  } catch (err) {
    // Abstraction is not a gate; a failure must not undo a kept change.
    console.error(`IMPROVE_ABSTRACT_FAILED ${attempt.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
