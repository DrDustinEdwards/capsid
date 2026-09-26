import type { Env } from "../env";
import { dispatchWorkflow } from "../github";
import { autoMergeTick } from "../auto-merge-tick";
import { runEvaluationCycle } from "../skills-evaluate";
import { sweepIfDue } from "../outcome-prs";
import { expireJobLeases } from "../jobs";
import { gatherFindings, watcherTick } from "../watcher";
import { proposeChange, pushAttempt } from "../improve-attempt";
import { pathMonitor } from "../improve-gates";
import {
  estimatedScorerMinutes,
  maxAttemptsFor,
  MAX_CONSECUTIVE_REVERTS,
  MAX_CONSECUTIVE_UNJUDGED,
  RUN_MAX_AGE_MS,
  SCORE_TIMEOUT_MS,
  SCORER_WORKFLOW,
  archivePath,
  attemptId,
  branchName,
  RUN_PROMPT_PATH,
  type RunStatus,
} from "../improve-schema";
import { selectBase } from "../improve-select";
import { candidateSkills, readSkillBody } from "../improve-skills";
import { attributionStatements } from "../skills-records";
import {
  activeRun,
  advanceableRuns,
  advanceRun,
  attemptById,
  attemptsForRun,
  improveAudit,
  improveDocStatements,
  priorDoc,
  readBest,
  type RunRow,
} from "../improve-state";
import { finalizeRun, gatherContext, renderAttemptDoc, renderObjective } from "./finalize";
import { unjudgedCeilingNote } from "./ingest";
import { baselineId, enforceBudget, loadScores, readDoc, recentAttempts } from "./open";

// How many runs one tick advances. Bounded so a tick stays within its invocation
// budget when every namespace is mid-run; the rest are reached on the next tick, five
// minutes later, oldest-advanced first.
const RUNS_PER_TICK = 3;

// Used when capsid/improve/prompts/run.md is missing, so the system prompt is never
// empty. It is not a substitute for that document, and the run document records which
// prompt was used.
export const DEFAULT_RUN_PROMPT = [
  "You are improving one project in a small portfolio, one scoped change at a time.",
  "",
  "Your change is measured by CI: a build, a test suite, a hidden holdout suite, a lint count, an error count, a latency figure and a bundle size. A change is kept only if no anchor regresses and the weighted secondary score strictly improves. A tie reverts.",
  "",
  "Prefer changes whose effect the scorer can actually see. Prefer small. A change you cannot explain the measured effect of is a change that will be reverted.",
].join("\n");

export interface TickOutcome {
  runId: string;
  namespace: string;
  from: string;
  to: string;
  note: string;
}

export async function tickRuns(env: Env, now: Date): Promise<TickOutcome[]> {
  // The steps before the runs spend no model tokens, so they sit outside the budget
  // check: an exhausted budget must not stop them. Each is wrapped so one throw does
  // not stop the rest of the tick.
  //
  // The work queue's lease sweep: one keyed UPDATE. Gated on the budget, it would leave
  // a job held by a dead session for as long as the caps stay exceeded, the state it
  // exists to clear. Reported through console, not TickOutcome, because a requeued job
  // is not a run transition.
  try {
    const expired = await expireJobLeases(env, now);
    if (expired.requeued.length > 0) {
      console.log(`JOB_LEASE_EXPIRED returned ${expired.requeued.length} job(s) to queued: ${expired.requeued.join(", ")}`);
    }
  } catch (err) {
    console.error(`JOB_LEASE_SWEEP_THREW: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Auto-merge. It spends no model tokens and no CI minutes, and an exhausted improve
  // budget says nothing about whether a driver's finished pull request should land.
  // The policy document decides whether it does anything; it ships disabled.
  try {
    const merged = await autoMergeTick(env, now);
    if (merged.ran) console.log(`AUTO_MERGE ${merged.note}`);
  } catch (err) {
    console.error(`AUTO_MERGE_THREW: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The skill evaluation cycle, gated on its own fortnightly cadence: the tick runs every
  // five minutes, so all but about one call in four thousand return after one KV read.
  try {
    const cycle = await runEvaluationCycle(env, now);
    if (cycle.ran) console.log(`SKILL_CYCLE ${cycle.note}`);
  } catch (err) {
    console.error(`SKILL_CYCLE_THREW: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The watcher, on its own half-hourly stamp. It only posts jobs, so the worst a
  // broken pass can do is add a row to the queue.
  try {
    const watched = await watcherTick(env, now, () => gatherFindings(env, now));
    if (watched.ran) console.log(`WATCHER ${watched.note}`);
  } catch (err) {
    console.error(`WATCHER_THREW: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The daily merge-state sweep. Outcome rows record a pull request as unmerged when
  // written, because the driver blocks and the seat merges afterwards. The merge path
  // corrects the rows it can see; this catches the rest (a merge done with gh rather
  // than manage_pr, and rows written before the join table existed). Bounded per
  // sweep, so the cost is fixed however far behind it is.
  try {
    const swept = await sweepIfDue(env, now);
    if (swept) console.log(`OUTCOME_SWEEP checked ${swept.checked}, changed ${swept.changed}, seeded ${swept.seeded}`);
  } catch (err) {
    console.error(`OUTCOME_SWEEP_THREW: ${err instanceof Error ? err.message : String(err)}`);
  }

  const runs = await advanceableRuns(env.DB, RUNS_PER_TICK);
  // An exceeded cap advances nothing. Active runs wait for the caps to rise or the month
  // to turn, and RUN_MAX_AGE finalizes any that age out.
  if (runs.length > 0) {
    const budgetReason = await enforceBudget(env, now);
    if (budgetReason) {
      return runs.map((run) => ({ runId: run.id, namespace: run.namespace, from: run.status, to: run.status, note: budgetReason }));
    }
  }
  const outcomes: TickOutcome[] = [];
  for (const run of runs) {
    // Captured before the step runs, because the claim CAS moves the row's status: by
    // the time the catch reads it, run.status can say 'awaiting-score' about work that
    // began in 'attempting'.
    const entered = run.status;
    try {
      outcomes.push(await advanceOne(env, run, now));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`IMPROVE_TICK_THREW ${run.id} in '${entered}': ${message}`);
      // A throwing step finalizes the run with the error recorded, so it cannot hold
      // the namespace's active-run slot forever. Two CAS attempts: the steps claim the
      // run before their external calls, so the first covers a throw before the claim
      // and the re-read covers a throw after it. A losing tick returns at the failed
      // claim and never reaches here, and a run that went terminal has no active row.
      const finalize = (expected: RunStatus) =>
        advanceRun(env.DB, {
          runId: run.id,
          expected,
          next: "finalizing",
          patch: { note: `a step threw in '${entered}': ${message.slice(0, 400)}` },
        });
      if (!(await finalize(entered))) {
        const current = await activeRun(env.DB, run.namespace);
        if (current && current.id === run.id) await finalize(current.status);
      }
      outcomes.push({ runId: run.id, namespace: run.namespace, from: entered, to: "finalizing", note: message });
    }
  }
  return outcomes;
}

async function advanceOne(env: Env, run: RunRow, now: Date): Promise<TickOutcome> {
  const age = now.getTime() - Date.parse(`${run.started.replace(" ", "T")}Z`);
  if (age > RUN_MAX_AGE_MS && run.status !== "finalizing") {
    const moved = await advanceRun(env.DB, {
      runId: run.id,
      expected: run.status,
      next: "finalizing",
      patch: { note: `run exceeded its ${RUN_MAX_AGE_MS / 3_600_000} hour ceiling in state '${run.status}'` },
    });
    return { runId: run.id, namespace: run.namespace, from: run.status, to: moved ? "finalizing" : run.status, note: "aged out" };
  }

  switch (run.status) {
    case "opening":
      return dispatchBaseline(env, run, now);
    case "attempting":
      return startAttempt(env, run, now);
    case "awaiting-score":
      return checkStaleScore(env, run, now);
    case "judging": {
      // Only held inside an HTTP score ingest. A run found here may mean that request
      // died mid-decision, or that it is alive now: the five-minute tick and an HTTP
      // ingest overlap freely. Moving a live ingest's run back would reopen it to the
      // duplicate report the judging CAS excludes, so judging is left alone until
      // SCORE_TIMEOUT_MS has passed, which no request outlives.
      const heldMs = now.getTime() - Date.parse(`${run.advanced_at.replace(" ", "T")}Z`);
      if (heldMs < SCORE_TIMEOUT_MS) {
        return { runId: run.id, namespace: run.namespace, from: "judging", to: "judging", note: `an ingest holds this run (${Math.round(heldMs / 1000)}s); left alone` };
      }
      await advanceRun(env.DB, { runId: run.id, expected: "judging", next: "awaiting-score" });
      return { runId: run.id, namespace: run.namespace, from: "judging", to: "awaiting-score", note: "a score ingest did not finish; returned to awaiting-score" };
    }
    case "finalizing":
      return finalizeRun(env, run, now);
    default:
      return { runId: run.id, namespace: run.namespace, from: run.status, to: run.status, note: "no transition defined" };
  }
}

async function dispatchBaseline(env: Env, run: RunRow, now: Date): Promise<TickOutcome> {
  if (!run.base_sha) {
    await advanceRun(env.DB, { runId: run.id, expected: "opening", next: "finalizing", patch: { note: "no base commit could be resolved" } });
    return { runId: run.id, namespace: run.namespace, from: "opening", to: "finalizing", note: "no base commit" };
  }
  const id = baselineId(run.id);
  const branch = branchName(id);
  // The claim comes before any GitHub call, so of two overlapping ticks exactly one
  // pushes and dispatches, and the loser spends nothing. Without it both would dispatch
  // the scorer, and the loser's failed transition cannot un-run a duplicate CI job. A
  // throw after the claim is finalized by the tick loop's catch.
  const claimed = await advanceRun(env.DB, {
    runId: run.id,
    expected: "opening",
    next: "awaiting-score",
    patch: { current_attempt: id },
  });
  if (!claimed) {
    return { runId: run.id, namespace: run.namespace, from: "opening", to: run.status, note: "another tick claimed this run first; nothing dispatched" };
  }
  // An empty push: the branch is created at the base commit, to measure the base.
  await pushAttempt(env, { namespace: run.namespace, branch, baseSha: run.base_sha, summary: "baseline", files: [] });
  const refused = await dispatchScorer(env, run, branch, id, now);
  if (refused) {
    // Ended here, or the stale guard would record a baseline that never reported.
    await advanceRun(env.DB, { runId: run.id, expected: "awaiting-score", next: "finalizing", patch: { current_attempt: null, note: refused } });
    return { runId: run.id, namespace: run.namespace, from: "opening", to: "finalizing", note: refused };
  }
  return { runId: run.id, namespace: run.namespace, from: "opening", to: "awaiting-score", note: `baseline dispatched on ${branch}` };
}

// An attempt that ended before its branch was pushed (no proposal, or a flagged path)
// counts as a revert: the run moves back to attempting, or to finalizing once the
// consecutive-revert limit is reached.
async function recordRevertBeforePush(env: Env, run: RunRow, costUsd: number): Promise<void> {
  await advanceRun(env.DB, {
    runId: run.id,
    expected: "awaiting-score",
    next: run.consecutive_reverts + 1 >= MAX_CONSECUTIVE_REVERTS ? "finalizing" : "attempting",
    patch: {
      attempts: run.attempts + 1,
      reverts: run.reverts + 1,
      consecutive_reverts: run.consecutive_reverts + 1,
      cost_usd: run.cost_usd + costUsd,
      current_attempt: null,
    },
  });
}

async function startAttempt(env: Env, run: RunRow, now: Date): Promise<TickOutcome> {
  const cap = maxAttemptsFor(run.namespace);
  if (run.attempts >= cap) {
    await advanceRun(env.DB, {
      runId: run.id,
      expected: "attempting",
      next: "finalizing",
      patch: { note: `reached the ${cap} attempt ceiling` },
    });
    return { runId: run.id, namespace: run.namespace, from: "attempting", to: "finalizing", note: "attempt ceiling reached" };
  }

  const index = run.attempts + 1;
  const id = attemptId(run.id, index);
  const branch = branchName(id);
  // The claim comes before any model or GitHub call, so two overlapping ticks cannot
  // both pay for a proposal and push it. awaiting-score doubles as the working status:
  // the attempt id is claimed as current_attempt, a later tick sees a young
  // awaiting-score and waits, and a claimant that dies mid-work is resolved by the
  // stale guard as "no score report".
  const claimed = await advanceRun(env.DB, {
    runId: run.id,
    expected: "attempting",
    next: "awaiting-score",
    patch: { current_attempt: id },
  });
  if (!claimed) {
    return { runId: run.id, namespace: run.namespace, from: "attempting", to: run.status, note: "another tick claimed this run first; nothing spent" };
  }

  const { doc, refusal } = await loadScores(env, run.namespace);
  if (refusal) {
    await advanceRun(env.DB, { runId: run.id, expected: "awaiting-score", next: "finalizing", patch: { note: refusal } });
    return { runId: run.id, namespace: run.namespace, from: "attempting", to: "finalizing", note: refusal };
  }

  const priorAttempts = await attemptsForRun(env.DB, run.id);
  const best = await readBest(env.APP_KV, run.namespace);
  // Condition 'no-memory': lineage history is withheld, so the run branches from the
  // best record alone. Withholding the input is what makes the condition mean anything.
  const lineage = run.condition === "no-memory" ? [] : await recentAttempts(env.DB, run.namespace, 50);
  const choice = selectBase(best, lineage, run.base_sha);
  const baseSha = choice.sha || run.base_sha || "";

  // A transferred skill is offered on the first attempt only; later attempts build on
  // what this run learned, and spending every attempt on another project's ideas
  // would leave no room for its own. Condition 'no-transfer': none is offered.
  const skills = index === 1 && run.condition !== "no-transfer" ? await candidateSkills(env.DB, run.namespace, 1) : [];
  const skill = skills[0]
    ? { id: skills[0].id, title: skills[0].title, body: await readSkillBody(env.DB, skills[0]) }
    : undefined;

  const runPrompt = (await readDoc(env.DB, "capsid", RUN_PROMPT_PATH)) ?? DEFAULT_RUN_PROMPT;
  const proposal = await proposeChange(env, {
    namespace: run.namespace,
    runPrompt,
    objective: renderObjective(doc),
    context: await gatherContext(env, run.namespace),
    history: priorAttempts
      .map((a) => `- ${a.status}: ${a.change_summary ?? "(no summary)"}${a.reason ? ` [${a.reason}]` : ""}`)
      .join("\n"),
    skill,
  });

  if (proposal.refused || proposal.files.length === 0) {
    const note = proposal.refused ? "the model declined to propose a change" : "the model proposed no file changes";
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO improve_attempts (id, namespace, run_id, change_summary, reason, lineage_parent, status, base_sha, skill_id, kept)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'reverted', ?7, ?8, 0)`
        )
        .bind(id, run.namespace, run.id, proposal.summary || null, note, choice.attemptId, baseSha, skill?.id ?? null),
      // Offered, not used: nothing followed the skill, so attribute() returns "none"
      // and this writes nothing.
      ...(skill ? attributionStatements(env.DB, { offered: [skill.id], used: [], signal: "verified-failure" }) : []),
    ]);
    await recordRevertBeforePush(env, run, proposal.costUsd);
    return { runId: run.id, namespace: run.namespace, from: "attempting", to: "attempting", note };
  }

  // The deterministic path monitor runs before the push, because a pushed change (a
  // package.json postinstall, a new workflow with `on: push`) runs in CI with secrets
  // in scope and a revert cannot undo that. The model half still runs at ingest, for
  // cases a pattern cannot name; this is the half decidable with no push and no key.
  const preflight = pathMonitor(proposal.changedPaths);
  if (preflight.flagged) {
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO improve_attempts (id, namespace, run_id, change_summary, reason, lineage_parent, status, base_sha, skill_id, kept, flagged, flag_reason)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'flagged', ?7, ?8, 0, 1, ?5)`
        )
        .bind(id, run.namespace, run.id, proposal.summary || null, preflight.reason, choice.attemptId, baseSha, skill?.id ?? null),
      // Used and refused: the model proposed following the skill and the monitor rejected
      // it. A verdict on the work itself, so the skill takes the loss.
      ...(skill ? attributionStatements(env.DB, { offered: [skill.id], used: [skill.id], signal: "verified-failure" }) : []),
    ]);
    await recordRevertBeforePush(env, run, proposal.costUsd);
    return { runId: run.id, namespace: run.namespace, from: "attempting", to: "attempting", note: `reverted before push: ${preflight.reason}` };
  }

  const pushed = await pushAttempt(env, {
    namespace: run.namespace,
    branch,
    baseSha,
    summary: proposal.summary,
    files: proposal.files,
  });

  // Written before the score arrives, so a change never scored still leaves a record.
  const archive = archivePath(run.id, id);
  const prior = await priorDoc(env.DB, run.namespace, archive);
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO improve_attempts
           (id, namespace, run_id, change_summary, diff_ref, lineage_parent, status, branch, head_sha, base_sha, skill_id, dispatched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'awaiting-score', ?7, ?8, ?9, ?10, datetime('now'))`
      )
      .bind(id, run.namespace, run.id, proposal.summary, archive, choice.attemptId, branch, pushed.headSha, baseSha, skill?.id ?? null),
    ...(await improveDocStatements(env.DB, {
      namespace: run.namespace,
      path: archive,
      title: `improve attempt ${id}`,
      type: "reference",
      action: "improve-attempt",
      prior,
      body: renderAttemptDoc({ id, run, proposal, pushed, baseWhy: choice.why, skill, now }),
    })),
  ]);

  const refusedAttempt = await dispatchScorer(env, run, branch, id, now, {
    current_attempt: id,
    attempts: run.attempts + 1,
    cost_usd: run.cost_usd + proposal.costUsd,
  });
  if (refusedAttempt) {
    // The budget stopped the dispatch after the push. Marked and ended here, or the
    // stale guard would count it as an environment failure.
    await env.DB.batch([
      env.DB
        .prepare("UPDATE improve_attempts SET status = 'refused-budget', kept = 0, reason = ?2 WHERE id = ?1 AND status = 'awaiting-score'")
        .bind(id, refusedAttempt),
    ]);
    await advanceRun(env.DB, {
      runId: run.id,
      expected: "awaiting-score",
      next: "finalizing",
      patch: { attempts: run.attempts + 1, cost_usd: run.cost_usd + proposal.costUsd, current_attempt: null, note: refusedAttempt },
    });
    return { runId: run.id, namespace: run.namespace, from: "attempting", to: "finalizing", note: refusedAttempt };
  }
  return { runId: run.id, namespace: run.namespace, from: "attempting", to: "awaiting-score", note: `attempt ${index} dispatched on ${branch}` };
}

/**
 * The one place a scorer is dispatched, so the cap is read immediately before the
 * spend and the spend is booked immediately after it.
 *
 * One check per dispatch: the tick reads the cap once and advances up to RUNS_PER_TICK
 * runs, so its check is only a cheap early-out and this is the one that binds.
 *
 * Booked at dispatch, so every run in flight is visible to the next check. The
 * estimate is a lien: `ingest` replaces it with the reported figure rather than adding
 * to it, so nothing is counted twice and ingest makes no outbound call.
 *
 * Returns the refusal reason when the cap is exceeded, or null when it dispatched.
 */
async function dispatchScorer(
  env: Env,
  run: RunRow,
  branch: string,
  attemptId: string,
  now: Date,
  patch: Record<string, unknown> = {}
): Promise<string | null> {
  const refusal = await enforceBudget(env, now);
  if (refusal) return refusal;
  await dispatchWorkflow(env, run.namespace, SCORER_WORKFLOW, { branch, run_id: run.id, attempt_id: attemptId });
  // Also refreshes advanced_at, so the stale guard measures from the dispatch.
  await advanceRun(env.DB, {
    runId: run.id,
    expected: "awaiting-score",
    next: "awaiting-score",
    patch: { ...patch, ci_minutes: run.ci_minutes + estimatedScorerMinutes(run.namespace) },
  });
  return null;
}

// The stale guard. A scorer that has not reported within SCORE_TIMEOUT_MS leaves the
// attempt unjudged and the run continues rather than wedging.
async function checkStaleScore(env: Env, run: RunRow, now: Date): Promise<TickOutcome> {
  const id = run.current_attempt;
  if (!id) {
    await advanceRun(env.DB, { runId: run.id, expected: "awaiting-score", next: "attempting" });
    return { runId: run.id, namespace: run.namespace, from: "awaiting-score", to: "attempting", note: "no attempt was recorded as in flight" };
  }

  const isBaseline = id === baselineId(run.id);
  const attempt = isBaseline ? null : await attemptById(env.DB, id);
  const dispatchedAt = isBaseline ? run.advanced_at : (attempt?.dispatched_at ?? run.advanced_at);
  const waited = now.getTime() - Date.parse(`${dispatchedAt.replace(" ", "T")}Z`);
  if (waited < SCORE_TIMEOUT_MS) {
    return { runId: run.id, namespace: run.namespace, from: "awaiting-score", to: "awaiting-score", note: `waiting (${Math.round(waited / 1000)}s of ${SCORE_TIMEOUT_MS / 1000}s)` };
  }

  const note = `no score report after ${Math.round(waited / 60_000)} minutes; the attempt is left unjudged`;
  if (isBaseline) {
    // Without a baseline no later comparison is provable, so the run ends.
    await advanceRun(env.DB, { runId: run.id, expected: "awaiting-score", next: "finalizing", patch: { note: `the baseline scoring job never reported: ${note}` } });
    return { runId: run.id, namespace: run.namespace, from: "awaiting-score", to: "finalizing", note };
  }

  await env.DB.batch([
    ...(attempt
      ? [
          env.DB
            .prepare("UPDATE improve_attempts SET status = 'timed-out', kept = 0, reason = ?2 WHERE id = ?1 AND status = 'awaiting-score'")
            .bind(id, note),
        ]
      : []),
    // No skill outcome: a scorer that never reported measured nothing, so the skill
    // that proposed this attempt is neither better nor worse for it.
    improveAudit(env.DB, "improve-score-timeout", run.namespace, { run_id: run.id, attempt_id: id, waited_ms: waited }),
  ]);

  // Unjudged, not reverted. As reverts, scorers that never report would restore the
  // namespace to best and record bad changes never measured. The unjudged counter does
  // not restore, and its ceiling sits below the revert ceiling on purpose: a retry into
  // a broken machine buys nothing, and an attempt that crashes its own scorer must not
  // escape the revert counter that way.
  const consecutive = run.consecutive_unjudged + 1;
  const exhausted = consecutive >= MAX_CONSECUTIVE_UNJUDGED;
  await advanceRun(env.DB, {
    runId: run.id,
    expected: "awaiting-score",
    next: exhausted || run.attempts >= maxAttemptsFor(run.namespace) ? "finalizing" : "attempting",
    patch: {
      consecutive_unjudged: consecutive,
      current_attempt: null,
      ...(exhausted ? { note: unjudgedCeilingNote(consecutive) } : {}),
    },
  });
  return { runId: run.id, namespace: run.namespace, from: "awaiting-score", to: exhausted ? "finalizing" : "attempting", note };
}
