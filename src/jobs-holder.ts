import type { Env } from "./env";
import type { Agent } from "./agents";
import {
  swallowedParamTag,
  swallowedTagRefusal,
  type JobRow,
  type JobStatus,
  CORRECTION_CAP,
  RETRY_CAP_REASON,
  atCorrectionCap,
  cappedSummary,
} from "./jobs-schema";
import { reviewGate, type GateOutcome } from "./review";
import { outcomePrStatements } from "./outcome-prs";
import { isMissingRowAbort, requireJobUnchanged } from "./store-guards";
import { attributionStatements } from "./skills-records";
import {
  outcomeFrom,
  outcomeStatement,
  signalFor,
  verifyEvidence,
  type JobSkills,
  type JobEvidence,
  type JobOutcomeRow,
} from "./job-outcomes";
import { jobAudit, latestResumeNote, mirrorStatements } from "./jobs-mirror";
import { correctionsForWork, guardedTransition, leaseUntil, readJob, refuse, type JobResult } from "./jobs-transition";

// The transitions the driver holding a job makes: heartbeat, complete, fail and
// block, and the review gate the last three consult.

// The transitions a holder makes. heartbeat, complete, fail and block are the same
// shape: a keyed UPDATE that only fires for the claimed job this caller holds, so an
// expired lease that the tick already returned to the queue cannot be completed out
// from under its new owner.
function holderRefusal(action: string, id: string, actor: string, current: JobRow | null): JobResult | null {
  if (!current) return refuse(action, `no job ${id}.`);
  if (current.status !== "claimed") {
    return refuse(
      action,
      `${id} is ${current.status}, not claimed. ${current.status === "queued" ? "Its lease expired and the tick returned it to the queue; claim it again." : "It has already been finished."}`
    );
  }
  if (current.claimed_by !== actor) return refuse(action, `${id} is held by ${current.claimed_by}, not by ${actor}.`);
  return null;
}

async function holderTransition(
  env: Env,
  agent: Agent,
  now: Date,
  action: "heartbeat" | "complete" | "fail" | "block",
  id: string,
  patch: {
    status: JobStatus;
    result_summary?: string | null;
    result_ref?: string | null;
    lease_expires: string | null;
    // Only block bumps the gate counter. Bound as a number, not interpolated as a SQL
    // fragment: the statement stays one static string, so test/jobs.test.ts can read
    // that it is keyed and test-integration/query-plans.test.ts can reconstruct it and
    // EXPLAIN it. A statement assembled at runtime is invisible to both.
    bumpBlocked?: boolean;
    // What the driver says this job produced. Verified against GitHub and written into
    // job_outcomes below, on the terminal transitions only.
    evidence?: JobEvidence;
    // The skills the driver was offered and used. Names only: the credit direction
    // comes from signalFor(), which reads what the Worker verified on GitHub.
    skills?: JobSkills;
  }
): Promise<JobResult> {
  const actor = agent.actor;
  const read = await readJob(env.DB, id);
  const notHeld = holderRefusal(action, id, actor, read);
  if (notHeld) return notHeld;
  if (!read) return refuse(action, `no job ${id}.`);
  // The row as the UPDATE below will leave it, computed from the read so the mirror
  // and the outcome can be built before anything is written. The guard at the head of
  // the batch is what keeps the read true when the batch commits.
  const job: JobRow = {
    ...read,
    status: patch.status,
    result_summary: patch.result_summary ?? read.result_summary,
    result_ref: patch.result_ref ?? read.result_ref,
    lease_expires: patch.lease_expires,
    updated_at: now.toISOString(),
    blocked_count: read.blocked_count + (patch.bumpBlocked ? 1 : 0),
  };

  // The transition and every record of it (mirror, audit, outcome, pull request and
  // attribution rows) are one batch. The first statement aborts the whole batch unless
  // the row is still claimed by this caller at the updated_at just read, so either all
  // of it commits or none of it does, and a throw cannot leave a finished job with no
  // record. id is the primary key, so the guard passing means the UPDATE moves exactly
  // that one row.
  //
  // The outcome row is written on the terminal transitions only. A running job has no
  // outcome, and one that reached `done` or `failed` will not transition again, so this
  // runs once per job and the primary key enforces that rather than trusting it.
  //
  // A failed job gets a row too. A driver whose jobs mostly fail is what this table
  // exists to show, and recording only successes would make every agent look equally
  // good.
  //
  // Verification runs before the batch and cannot fail the transition. verifyEvidence
  // reports its own errors as notes, so an unreachable GitHub costs the verified flags
  // and not the driver's ability to close a finished job.
  let outcome: { row: JobOutcomeRow; notes: string[] } | undefined;
  const statements = [
    requireJobUnchanged(env.DB, id, "claimed", actor, read.updated_at),
    env.DB.prepare(
      `UPDATE jobs SET status = ?2, result_summary = COALESCE(?3, result_summary), result_ref = COALESCE(?4, result_ref),
         lease_expires = ?5, updated_at = ?6, blocked_count = blocked_count + ?8
       WHERE id = ?1 AND status = 'claimed' AND claimed_by = ?7 RETURNING id`
    ).bind(
      id,
      patch.status,
      patch.result_summary ?? null,
      patch.result_ref ?? null,
      patch.lease_expires,
      now.toISOString(),
      actor,
      patch.bumpBlocked ? 1 : 0
    ),
    ...(await mirrorStatements(env.DB, job, `job-${action}`, actor)),
    jobAudit(env.DB, actor, `job-${action}`, job, {
      status: job.status,
      ...(patch.result_summary ? { result_summary: patch.result_summary } : {}),
      ...(patch.result_ref ? { result_ref: patch.result_ref } : {}),
    }),
  ];
  if (job.status === "done" || job.status === "failed") {
    const verdict = await verifyEvidence(env, job.namespace, patch.evidence);
    const row = outcomeFrom(job, verdict, now, patch.skills);
    outcome = { row, notes: verdict.notes };
    statements.push(outcomeStatement(env.DB, row));
    // One row per pull request the evidence named, in the same batch as the outcome.
    // Without them the outcome keeps counts with no way back to what they counted, and
    // the merge state recorded at complete time could never be corrected.
    statements.push(...outcomePrStatements(env.DB, job.id, patch.evidence?.prs ?? []));
    // The credit comes from the verified signal and nowhere else. The driver names
    // offered and used; signalFor reads merge state and CI as this Worker read them off
    // GitHub. An unverifiable job earns nothing in either direction.
    statements.push(
      ...attributionStatements(env.DB, {
        offered: patch.skills?.offered ?? [],
        used: patch.skills?.used ?? [],
        signal: signalFor(verdict),
      })
    );
  }
  try {
    await env.DB.batch(statements);
  } catch (err) {
    if (!isMissingRowAbort(err)) throw err;
    // Nothing was written. Say what the row is now, as a lost race would have.
    const current = await readJob(env.DB, id);
    return holderRefusal(action, id, actor, current) ?? refuse(action, `${id} changed between reading it and recording the ${action}. Nothing was written; try again.`);
  }
  // The driver a resume returned the job to is already holding it and learns of the
  // resume by its next call, which is usually a heartbeat.
  const heartbeatNote = action === "heartbeat" ? await latestResumeNote(env.DB, job) : null;
  return { ok: true, action, job, ...(outcome ? { outcome } : {}), ...(heartbeatNote ? { resume_note: heartbeatNote } : {}) };
}

export async function heartbeatJob(env: Env, agent: Agent, now: Date, id: string): Promise<JobResult> {
  return holderTransition(env, agent, now, "heartbeat", id, { status: "claimed", lease_expires: leaseUntil(now) });
}

// The review gate, consulted by complete, fail and block alike.
//
// A gate on one of them would not be a gate: a driver that found `complete` refused
// would `block` or `fail` instead, and the bypass would look like ordinary use. So the
// same function answers for all three, and the answer is turned into a JobResult here
// so they cannot describe the same verdict differently.
//
// Only complete demands a pull request, because it hands the work on. A job that stops
// at a gate has usually opened nothing yet, and a job that cannot be done has no pull
// request to review; demanding one would leave the driver unable to close the job at
// all. When a pull request is named, block and fail still consult the gate, so a
// driver cannot walk away from a CHANGES or a BLOCK.
//
// Returns null when the gate does not apply: no review_required, or no pull request on
// a transition that does not demand one. That is the normal path for almost every job.
async function reviewRefusal(
  env: Env,
  agent: Agent,
  now: Date,
  action: string,
  id: string,
  resultRef: string | null,
  opts: { requirePullRequest?: boolean; candidateRefs?: readonly (string | null | undefined)[] } = {}
): Promise<JobResult | null> {
  const current = await readJob(env.DB, id);
  if (!current) return null;
  // The stored reference is the job's bound pull request, if the gate has read one.
  // The references this call names are candidates, so a driver completing with the
  // pull request it just opened has it in its arguments.
  let outcome: GateOutcome | null;
  try {
    outcome = await reviewGate(
      env,
      { namespace: current.namespace, review_required: current.review_required, result_ref: current.result_ref },
      { ...opts, candidateRefs: [resultRef, ...(opts.candidateRefs ?? [])] }
    );
  } catch (err) {
    // A GitHub failure holds the job rather than waving it through. The gate puts a
    // second reader in front of the seat, and an unreadable comment list is not
    // evidence that one looked.
    return refuse(
      action,
      `${id} needs a review and GitHub could not be read: ${err instanceof Error ? err.message : String(err)}. ` +
        `The job stays claimed; try again rather than treating an unreadable review as an approval.`
    );
  }
  if (outcome === null) return null;

  // The first read binds the job to its pull request in the result_ref column. On a
  // claimed job nothing else writes it, and the terminal transition that does runs
  // after this gate. Recorded whatever the verdict, so a CHANGES cannot be escaped by
  // naming another pull request on the next call.
  //
  // Each write below is one guarded batch built from the caller's claimed job as read.
  // The binding moves updated_at, so the CHANGES write after it guards on the row the
  // binding left.
  let read = current;
  if (outcome.pr && !current.result_ref) {
    const notHeld = holderRefusal(action, id, agent.actor, current);
    if (notHeld) return notHeld;
    const job: JobRow = { ...current, result_ref: outcome.pr, updated_at: now.toISOString() };
    const bound = await guardedTransition(env, current, [
      env.DB.prepare(
        `UPDATE jobs SET result_ref = ?2, updated_at = ?3
         WHERE id = ?1 AND status = 'claimed' AND claimed_by = ?4 AND result_ref IS NULL RETURNING id`
      ).bind(id, outcome.pr, now.toISOString(), agent.actor),
      ...(await mirrorStatements(env.DB, job, "job-review-bound", agent.actor)),
      jobAudit(env.DB, agent.actor, "job-review-bound", job, { result_ref: outcome.pr }),
    ]);
    if (!bound) return refuse(action, `${id} moved between reading it and recording its pull request. Ask again.`);
    read = job;
  }

  if (outcome.kind === "proceed") return null;

  if (outcome.kind === "waiting") {
    return refuse(action, `${id} is ${outcome.reason} The job stays claimed and its lease keeps running.`);
  }

  // CHANGES and BLOCK both move the job, so neither is a plain refusal: the row has to
  // record what the reviewer said, or the next reader sees a job that stalled for no
  // stated reason.
  const { review } = outcome;
  const said = review.said ? ` ${review.said}` : "";
  if (outcome.kind === "rework") {
    // The cap is checked before the correction is spent, so the loop it bounds is
    // bounded. If the rework path only incremented and left the job claimed, a third
    // CHANGES would spend a third correction and send the work back again, and a
    // reviewer and a driver disagreeing forever is the loop the cap exists for.
    //
    // At the cap the job goes to the seat through the ordinary block path, so it
    // carries the reviewer's objection and the gate counter behaves as for any other
    // block. fromReview stops blockJob consulting the review that produced it and
    // recursing.
    const spentOnWork = await correctionsForWork(env.DB, current.namespace, current.title);
    if (atCorrectionCap(spentOnWork)) {
      return endedElsewhere(action, await blockJob(env, agent, now, id, {
        reason:
          `review by ${review.by}: CHANGES.${said} This is correction ${spentOnWork + 1} against this work, past the cap of ${CORRECTION_CAP}: ` +
          `${RETRY_CAP_REASON}. The reviewer and the driver have not converged, so what happens next is a person's call rather than another round.`,
        fromReview: true,
      }));
    }
    // Back to the driver, spending a correction from the same budget the retry cap
    // bounds. Counting review rounds separately would exempt them from the cap.
    const summary = `review by ${review.by}: CHANGES.${said}`;
    const notHeld = holderRefusal(action, id, agent.actor, read);
    if (notHeld) return notHeld;
    const job: JobRow = { ...read, result_summary: summary, corrections_count: read.corrections_count + 1, updated_at: now.toISOString() };
    const won = await guardedTransition(env, read, [
      env.DB.prepare(
        `UPDATE jobs SET result_summary = ?2, corrections_count = corrections_count + 1, updated_at = ?3
         WHERE id = ?1 AND status = 'claimed' AND claimed_by = ?4 RETURNING id`
      ).bind(id, summary, now.toISOString(), agent.actor),
      ...(await mirrorStatements(env.DB, job, "job-review-changes", agent.actor)),
      jobAudit(env.DB, agent.actor, "job-review-changes", job, {
        verdict: review.verdict,
        by: review.by,
        at: review.at,
        corrections_count: job.corrections_count,
      }),
    ]);
    if (!won) return refuse(action, `${id} moved between reading it and recording the review. Ask again.`);
    return { ok: false, action, job, refusal: `${summary} The job stays claimed: fix it and hand it on again. This spent a correction (${job.corrections_count} of ${CORRECTION_CAP}).` };
  }

  // BLOCK: blocked for the seat, with the objection as the reason, through the
  // ordinary block path so the gate counter and the mirror document behave as they do
  // for any other block.
  return endedElsewhere(action, await blockJob(env, agent, now, id, { reason: `review by ${review.by}: BLOCK.${said}`, fromReview: true }));
}

// A transition that ended somewhere other than asked is not a success. A complete or
// fail that met a reviewer BLOCK, or a CHANGES at the correction cap, blocks the job
// instead, and passing blockJob's result through would tell a driver that asked for
// something else ok: true with action "block". The block is recorded either way; this
// reports it as a refusal of the caller's own action, with the job as it now stands.
// A caller that asked to block got a block, so its result passes.
function endedElsewhere(action: string, result: JobResult): JobResult {
  if (!result.ok || action === result.action) return result;
  return {
    ok: false,
    action,
    ...(result.job ? { job: result.job } : {}),
    refusal:
      `${result.job?.id ?? "the job"} was not ${action === "complete" ? "completed" : `${action}ed`}: the reviewer's verdict blocked it for the seat instead, and that block is recorded. ` +
      `${result.job?.result_summary ?? ""}`.trim(),
  };
}

/**
 * Every skill id the caller named, checked against the table.
 *
 * Refused, not ignored. A skill that does not exist is a stale id or a typo, and
 * dropping it would record "offered nothing" for a run that was offered something.
 * That is how the offered-to-used rate could be wrong without anybody writing a wrong
 * number. Returns the refusal, or null.
 */
async function unknownSkills(db: D1Database, skills: JobSkills | undefined): Promise<string | null> {
  const named = [...new Set([...(skills?.offered ?? []), ...(skills?.used ?? [])])];
  if (named.length === 0) return null;
  const placeholders = named.map((_, i) => `?${i + 1}`).join(", ");
  const found = await db
    .prepare(`SELECT id FROM improve_skills WHERE id IN (${placeholders})`)
    .bind(...named)
    .all<{ id: string }>();
  const have = new Set((found.results ?? []).map((r) => r.id));
  const missing = named.filter((id) => !have.has(id));
  if (missing.length === 0) return null;
  return `no skill exists with id ${missing.join(", ")}. A named skill that does not exist is refused rather than dropped, because dropping it would record this run as having been offered nothing.`;
}

// Used must be a subset of offered. A skill used but never offered did not come from
// the recommend step, so crediting it would measure something this loop did not do.
function usedNotOffered(skills: JobSkills | undefined): string | null {
  const offered = new Set(skills?.offered ?? []);
  const stray = [...new Set(skills?.used ?? [])].filter((id) => !offered.has(id));
  return stray.length === 0
    ? null
    : `${stray.join(", ")} named as used but not as offered. A skill this run did not receive from the recommend step cannot be credited to it.`;
}

export async function completeJob(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  args: { result_summary: string; result_ref?: string; evidence?: JobEvidence; skills?: JobSkills }
): Promise<JobResult> {
  if (!args.result_summary?.trim()) {
    return refuse("complete", "complete needs a result_summary. A done job with no summary is a job the seat has to reconstruct from the diff.");
  }
  // Checked before the write, because the outcome row this call produces cannot be
  // corrected afterwards: a result_ref and evidence swallowed into the summary would
  // leave a row that records nothing.
  const swallowed = swallowedParamTag(args.result_summary);
  if (swallowed) return refuse("complete", swallowedTagRefusal("result_summary", swallowed));
  // The review gate (see reviewRefusal). complete must name a pull request and carry
  // an APPROVE; evidence.prs counts as naming it, so a driver cannot report its work
  // there with a document key in result_ref and escape the gate.
  const review = await reviewRefusal(env, agent, now, "complete", id, args.result_ref ?? null, {
    requirePullRequest: true,
    candidateRefs: args.evidence?.prs,
  });
  if (review) return review;
  const stray = usedNotOffered(args.skills);
  if (stray) return refuse("complete", stray);
  const unknown = await unknownSkills(env.DB, args.skills);
  if (unknown) return refuse("complete", unknown);
  return holderTransition(env, agent, now, "complete", id, {
    status: "done",
    result_summary: args.result_summary,
    result_ref: args.result_ref ?? null,
    lease_expires: null,
    evidence: args.evidence,
    skills: args.skills,
  });
}

export async function failJob(env: Env, agent: Agent, now: Date, id: string, reason: string, skills?: JobSkills): Promise<JobResult> {
  if (!reason?.trim()) return refuse("fail", "fail needs a reason. A failed job with no reason is one nobody can retry or rule on.");
  const failSwallowed = swallowedParamTag(reason);
  if (failSwallowed) return refuse("fail", swallowedTagRefusal("reason", failSwallowed));
  // The review gate (see reviewRefusal), without demanding a pull request.
  const review = await reviewRefusal(env, agent, now, "fail", id, null);
  if (review) return review;
  const strayOnFail = usedNotOffered(skills);
  if (strayOnFail) return refuse("fail", strayOnFail);
  const unknownOnFail = await unknownSkills(env.DB, skills);
  if (unknownOnFail) return refuse("fail", unknownOnFail);
  return holderTransition(env, agent, now, "fail", id, { status: "failed", result_summary: reason, lease_expires: null, skills });
}

// A blocked job carries the exact command. A job that hit a gate is not a failure; it
// is work waiting on a human, and the human needs the command to run, not a
// description of the situation. The console shows these. blockJob writes this marker
// and commandFromSummary reads it back, so the format cannot drift between the two.
export const RESUME_MARKER = "Run this, then send it back in with jobs action 'resume':";

/** The exact command a blocked job is waiting on, or null when it recorded none. */
export function commandFromSummary(summary: string | null): string | null {
  if (!summary) return null;
  const at = summary.indexOf(RESUME_MARKER);
  if (at === -1) return null;
  const rest = summary.slice(at + RESUME_MARKER.length).trim();
  return rest.length > 0 ? rest : null;
}

export async function blockJob(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  args: { reason: string; command?: string; fromReview?: boolean }
): Promise<JobResult> {
  if (!args.reason?.trim()) return refuse("block", "block needs a reason: what gate was hit.");
  // The review gate (see reviewRefusal). `fromReview` is set when the gate itself
  // blocks, so it does not consult itself again.
  if (!args.fromReview) {
    const review = await reviewRefusal(env, agent, now, "block", id, null);
    if (review) return review;
  }
  const summary = args.command ? `${args.reason}\n\n${RESUME_MARKER}\n\n    ${args.command}` : args.reason;
  // The cap is applied where the block is written, so a capped job says so in the one
  // field every reader already looks at: the console prints result_summary, the driver
  // reads it to continue, and a human deciding reads it there too. The budget is read
  // before the transition, because the transition is what makes this block count.
  const current = await readJob(env.DB, id);
  const capped = current !== null && atCorrectionCap(await correctionsForWork(env.DB, current.namespace, current.title));
  return holderTransition(env, agent, now, "block", id, {
    status: "blocked",
    result_summary: capped ? cappedSummary(summary) : summary,
    lease_expires: null,
    bumpBlocked: true,
  });
}
