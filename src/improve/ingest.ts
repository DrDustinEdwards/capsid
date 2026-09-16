import type { Env } from "../env";
import { monitorAttempt } from "../improve-gates";
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
import { anchorVerdict, compare, type MetricMap } from "../improve-scores";
import { abstractSkill, recordSkill, recordSkillOutcome } from "../improve-skills";
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

// ---- ingest -----------------------------------------------------------------

export interface IngestResult {
  ok: boolean;
  message: string;
  kept?: boolean;
}

// Called from the /improve/score endpoint after the signature has verified.
// Runs in an HTTP request rather than in a tick, so it has room to decide.

/**
 * THE RESERVATION IS REPLACED, NOT ADDED TO. `dispatchScorer` books an estimate
 * against the cap the moment it dispatches, which is what makes a scorer in flight
 * visible to the next check; this is where the reported figure takes its place.
 * Adding instead of replacing would charge every run twice.
 *
 * NO OUTBOUND CALL. Reading the exact billed figure from the Actions API would put
 * a network call on this path, and this path runs on every report including the
 * ones the deterministic guard reverts. Ruled 2026-09-15: a revert that phones out
 * is a revert that can fail for a reason unrelated to the attempt, and that
 * property is worth more than an exact meter.
 *
 * Clamped at zero so an estimate larger than the actual cannot drive the month
 * negative and buy back budget nobody spent.
 */
export function settledMinutes(run: Pick<RunRow, "namespace" | "ci_minutes">, reported: number): number {
  return Math.max(0, run.ci_minutes - estimatedScorerMinutes(run.namespace) + meteredMinutes(run.namespace, reported));
}
export async function ingestScore(env: Env, report: ScoreReport, now: Date): Promise<IngestResult> {
  const run = await runById(env.DB, report.run_id);
  if (!run) return { ok: false, message: `unknown run ${report.run_id}` };
  if (run.namespace !== report.namespace) {
    return { ok: false, message: `report namespace '${report.namespace}' does not match run ${run.id} ('${run.namespace}')` };
  }

  // THE THREE STOPS APPLY HERE TOO (audit 2026-09-07, Grok MAJOR 6, Opus section 5
  // budget note). Pause and mode were checked in openOne, budget in the opener and the
  // tick. None was checked at ingest, so a score POST still kept the change, wrote
  // improve:best, abstracted a skill and advanced the run in a paused namespace, after
  // the mode was switched off, or past the spend cap. A stop that only stops new work
  // is not a stop: the in-flight attempt is the one someone paused the namespace to
  // stop.
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

  // THE HOLDOUT CHECK, before anything is believed. A report that disagrees with
  // the manifest about how many hidden tests exist is refused outright.
  const manifest = await readHoldoutManifest(env, run.namespace);
  const holdout = checkHoldout(manifest, report);

  const anchors: MetricMap = { ...report.anchors, holdout_pass_rate: holdout.passRate };
  const isBaseline = report.attempt_id === baselineId(run.id);

  if (isBaseline) {
    // BIND THE BASELINE LIKE AN ATTEMPT (audit 2026-09-07, Grok MAJOR 5). The baseline
    // branch only had to name `<run>-baseline` and win the CAS. It was not checked
    // against the run's in-flight attempt or the commit it claimed to measure, so a
    // rerun of the baseline Actions job after the run moved on, or a hand dispatch
    // naming that attempt_id with a chosen branch, would overwrite the run's baseline
    // metrics with a measurement of something else. Every later comparison is against
    // those numbers.
    //
    // The baseline branch is created at base_sha and nothing is committed to it, so
    // its head IS base_sha. That is what the report must carry.
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
      // The BASE does not pass its own anchors. Nothing the loop does tonight can be
      // judged, so it stops and says so rather than measuring ten attempts against a
      // broken floor. Checked (audit 2026-09-06): a lost judging CAS means a tick's
      // stale guard reclaimed the run mid-ingest, and pretending the stop landed would
      // report a state the row does not hold.
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

  // BIND THE REPORT TO THE RUN'S IN-FLIGHT ATTEMPT (audit 2026-09-06). Ingest used to
  // look the attempt up by id alone, so a signed report minted by ci_dispatch of the
  // scorer against an arbitrary ref, or a captured report replayed, could score a
  // DIFFERENT attempt, the same run's stale attempt, or the attempt's code at a
  // different commit. Three checks close that:
  //   1. the attempt belongs to this run,
  //   2. the run is still awaiting a score for THIS attempt (else it is a duplicate, a
  //      replay, or a report for an attempt already decided), and
  //   3. the report scored the commit the attempt pushed, not some other ref.
  if (attempt.run_id !== run.id) {
    return { ok: false, message: `attempt ${attempt.id} belongs to run ${attempt.run_id}, not ${run.id}` };
  }
  if (run.status !== "awaiting-score" || run.current_attempt !== report.attempt_id) {
    // A LATE REPORT FOR AN UNJUDGED ATTEMPT IS STILL THE ONLY MEASUREMENT IT WILL
    // EVER HAVE. The run gave up waiting and moved on, so this cannot drive the
    // state machine: its counters have advanced, it may be several attempts further
    // on, and rewinding them to apply a verdict the run already worked around would
    // corrupt the one record of what the run actually did.
    //
    // The ATTEMPT ROW is a different question. It currently says the machine broke,
    // which was true and is no longer the whole truth, and that row is what lineage
    // selection and the skill records read later. Writing the real verdict there
    // costs the state machine nothing and is strictly more information.
    //
    // Only from an unjudged status: an attempt already kept or reverted has a real
    // verdict, and a second report for it is the duplicate this guard was written
    // for. And no write to improve:best, even on a late keep: best is what the next
    // run branches from, and this attempt's base is now several attempts stale.
    if (isUnjudged(attempt.status)) {
      return await recordLateScore(env, run, attempt, report, now);
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

  // A BROKEN MACHINE IS NOT A BAD CHANGE. Checked before the scores are loaded and
  // before the monitor runs, because an attempt that cannot be judged is not worth
  // spending a model call on.
  //
  // Two sources, one verdict. The scorer says its own environment failed (the
  // holdout container never finished, so its "0 of N" is an empty stream rather than
  // a result), or the hidden suite did not arrive at all. Either way nothing about
  // this attempt was measured, so it is left UNJUDGED: not kept, not reverted, not
  // counted against the restore-to-best ceiling, and the skill that proposed it is
  // not marked. See MAX_CONSECUTIVE_UNJUDGED for what stops this repeating forever.
  const environmentFailure = report.environment?.ok === false
    ? report.environment.reason ?? "the scorer reported an environment failure"
    : !holdout.ok && holdout.environmental
      ? holdout.refusal
      : null;
  if (environmentFailure) {
    return await recordUnjudged(env, run, attempt, report, environmentFailure, now);
  }

  const { doc } = await loadScores(env, run.namespace);
  const baseline = await metricsFor(env.DB, run.id, null);
  const comparison = compare(doc.secondary, baseline, report.secondary);
  const anchorsVerdict = anchorVerdict(doc.anchors, anchors);

  // THE MONITOR RUNS BEFORE THE SCORE IS BELIEVED, and its verdict outranks it. A
  // flagged attempt is reverted regardless of how well it scored: a change that games
  // the scorer scores WELL.
  const change = (await readDoc(env.DB, run.namespace, attempt.diff_ref ?? "")) ?? "";
  const monitor = await monitorAttempt(env, {
    changedPaths: changedPathsFrom(change),
    changeSummary: attempt.change_summary ?? "",
    reasoning: change,
    diff: change,
  });

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
        // STATUS-KEYED with RETURNING (audit 2026-09-06). The run-level judging CAS
        // above already serialises ingest, and keying the attempt write on its own
        // awaiting-score status makes a late or duplicated write unable to flip an
        // attempt a timeout already marked timed-out, or score one twice.
        `UPDATE improve_attempts
         SET status = ?2, kept = ?3, reason = ?4, score_before = ?5, score_after = ?6,
             flagged = ?7, flag_reason = ?8, anchors_json = ?9, secondary_json = ?10
         WHERE id = ?1 AND status = 'awaiting-score'
         RETURNING id`
      )
      .bind(
        attempt.id,
        monitor.flagged ? "flagged" : keep ? "kept" : "reverted",
        keep ? 1 : 0,
        reason,
        comparison.scoreBefore,
        comparison.scoreAfter,
        monitor.flagged ? 1 : 0,
        monitor.reason,
        JSON.stringify(anchors),
        JSON.stringify(report.secondary)
      ),
    ...scoreStatements(env.DB, run.id, run.namespace, attempt.id, { ...anchors, ...report.secondary }),
    ...(attempt.skill_id ? recordSkillOutcome(env.DB, attempt.skill_id, keep) : []),
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
  // Checked (audit 2026-09-06): the verdict above is already committed on the
  // attempt row; if a tick's stale guard reclaimed the run while it was being
  // judged, the counters were not advanced here and the caller is told so.
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

// ---- the environment failed --------------------------------------------------

// UNJUDGED: the scorer did not measure this attempt, so nothing is recorded about
// the code. What moves is the unjudged counter and nothing else.
//
// Deliberately NOT written here, each for its own reason:
//   reverts / consecutive_reverts  they mean "measured and rejected", and five of
//                                  them restore the namespace to best. A machine
//                                  that never ran is not evidence about the code.
//   recordSkillOutcome             a skill is not worse for having been proposed on
//                                  a night the runner broke.
//   scoreStatements                the metrics in this report were produced by the
//                                  failure. Storing them would put a 0 into the
//                                  series the next comparison reads as real.
//   writeBest                      an unjudged attempt is never kept.
async function recordUnjudged(
  env: Env,
  run: RunRow,
  attempt: AttemptRow,
  report: ScoreReport,
  why: string,
  now: Date
): Promise<IngestResult> {
  const reason = `unjudged: ${why}`;
  const consecutive = run.consecutive_unjudged + 1;
  const exhausted = consecutive >= MAX_CONSECUTIVE_UNJUDGED;

  await env.DB.batch([
    env.DB
      .prepare(
        // Status-keyed exactly like the judging write, so a late or duplicated call
        // cannot flip an attempt that has since reached a real verdict.
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

// The note a run stops on when the scoring environment keeps failing. It names the
// MACHINE, because that is all that was observed: no attempt reached a verdict, so
// the run learned nothing about the code and there is nothing to restore away from.
export function unjudgedCeilingNote(consecutive: number): string {
  return (
    `${consecutive} attempts in a row could not be scored: the scoring environment failed each time. ` +
    `Nothing was measured, so no attempt was reverted and the namespace was left where it is. ` +
    `Check the scorer workflow before the next run.`
  );
}

// ---- a verdict that arrived after the run gave up ---------------------------

// THE SAME JUDGEMENT AS THE PATH ABOVE, WRITTEN ONLY TO THE ATTEMPT ROW.
//
// It differs from the judging path in exactly four ways, and each is deliberate:
//   the UPDATE is keyed on the unjudged statuses rather than awaiting-score,
//   the run's counters and status are not touched (it has moved on),
//   improve:best is not written even on a keep (this attempt's base is stale now),
//   and no pull request is opened, for the same reason.
//
// The monitor still runs. `kept` on an attempt row makes it a base candidate in
// selectBase, so recording a keep no monitor ever looked at would put an unchecked
// commit into the lineage by a side door.
async function recordLateScore(
  env: Env,
  run: RunRow,
  attempt: AttemptRow,
  report: ScoreReport,
  now: Date
): Promise<IngestResult> {
  const manifest = await readHoldoutManifest(env, run.namespace);
  const holdout = checkHoldout(manifest, report);
  const anchors: MetricMap = { ...report.anchors, holdout_pass_rate: holdout.passRate };

  // A late report that ALSO says the machine broke leaves the row as it is. There is
  // nothing new to record, and the counter already moved when the run gave up.
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
  const change = (await readDoc(env.DB, run.namespace, attempt.diff_ref ?? "")) ?? "";
  const monitor = await monitorAttempt(env, {
    changedPaths: changedPathsFrom(change),
    changeSummary: attempt.change_summary ?? "",
    reasoning: change,
    diff: change,
  });

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
      attempt.id,
      monitor.flagged ? "flagged" : keep ? "kept" : "reverted",
      keep ? 1 : 0,
      reason,
      comparison.scoreBefore,
      comparison.scoreAfter,
      monitor.flagged ? 1 : 0,
      monitor.reason,
      JSON.stringify(anchors),
      JSON.stringify(report.secondary)
    )
    .all<{ id: string }>();

  // Nothing updated means the row left the unjudged statuses between the read and
  // this write. Whatever it says now was written by a path that had the run behind
  // it, so it outranks this one.
  if (results.length === 0) {
    return { ok: true, message: `${attempt.id} is no longer unjudged; the late report was ignored` };
  }

  await env.DB.batch([
    ...(attempt.skill_id ? recordSkillOutcome(env.DB, attempt.skill_id, keep) : []),
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
    // Abstraction is an enhancement, not a gate. A failure here must not undo a
    // change that was already kept on its own merits.
    console.error(`IMPROVE_ABSTRACT_FAILED ${attempt.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
