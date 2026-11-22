import type { Env } from "./env";
import type { Agent } from "./agents";
import { swallowedParamTag, swallowedTagRefusal, type JobRow, type JobStatus } from "./jobs-schema";
import { outcomePrStatements } from "./outcome-prs";
import { isMissingRowAbort, requireJobUnchanged } from "./store-guards";
import {
  outcomeFrom,
  outcomeStatement,
  namedPrUrls,
  verifyEvidence,
  type JobEvidence,
  type JobOutcomeRow,
} from "./job-outcomes";
import {
  claimRow,
  claimStatement,
  evaluationRows,
  evaluationStatements,
  parseClaim,
  workerEvaluatorId,
  type ClaimInput,
  type ClaimRaw,
  type JobClaim,
} from "./job-claims";
import { jobAudit, mirrorStatements } from "./jobs-mirror";
import { signJobText } from "./job-signing";
import { checkOverlaps, overlapLine, type OverlapReport } from "./job-overlaps";
import { guardedTransition, readJob, refuse, type JobResult } from "./jobs-transition";
import { actorKind, touchStatement } from "./job-touches";
import { ciRefusal } from "./complete-ci";
import { type BreakerExemption } from "./fail-exemption";
import { parsePrUrl } from "@dustinedwards/site-runtime/github";

// complete, fail and block share a shape: a keyed UPDATE that fires only for the claimed job
// this caller holds, so a job the seat released cannot be completed out from under its new owner.
function holderRefusal(
  action: string,
  id: string,
  actor: string,
  current: JobRow | null,
): JobResult | null {
  if (!current) return refuse(action, `no job ${id}.`);
  if (current.status !== "claimed") {
    return refuse(
      action,
      `${id} is ${current.status}, not claimed. ${current.status === "queued" ? "It is back in the queue (the seat released it); claim it again." : "It has already been finished."}`,
    );
  }
  if (current.claimed_by !== actor)
    return refuse(action, `${id} is held by ${current.claimed_by}, not by ${actor}.`);
  return null;
}

// The seat completing a blocked job it does not hold. Null when the job is blocked and
// held by someone else; otherwise what the job is and what to do instead.
function seatCloseRefusal(
  action: string,
  id: string,
  seat: string,
  current: JobRow | null,
): JobResult | null {
  if (!current) return refuse(action, `no job ${id}.`);
  if (current.status === "blocked") {
    return current.claimed_by === seat
      ? refuse(
          action,
          `${id} is blocked and held by ${seat} itself. A holder resumes its own gate before it completes; the seat's close is for a job another credential blocked.`,
        )
      : null;
  }
  if (current.status === "queued") {
    return refuse(
      action,
      `${id} is queued: nobody has worked it, so there is nothing to complete. A driver claims it, or the seat supersedes it.`,
    );
  }
  if (current.status === "claimed") {
    return refuse(
      action,
      `${id} is claimed by ${current.claimed_by}. Its holder completes it, or the seat releases the claim first. The seat completes a job only once it is blocked.`,
    );
  }
  return refuse(action, `${id} is already ${current.status}; there is nothing to complete.`);
}

function recordRefusal(action: string, id: string, current: JobRow | null): JobResult | null {
  if (!current) return refuse(action, `no job ${id}.`);
  if (current.status === "queued" && current.claimed_by === null) return null;
  if (current.status === "claimed")
    return refuse(
      action,
      `${id} is claimed by ${current.claimed_by}: its holder completes it. record is for work done on a job nobody claimed.`,
    );
  if (current.status === "blocked")
    return refuse(
      action,
      `${id} is blocked: the seat completes a blocked job with action complete.`,
    );
  return refuse(action, `${id} is ${current.status}; record is for a queued job.`);
}

type Said = { claim?: JobClaim; raw: ClaimRaw };

export async function holderTransition(
  env: Env,
  agent: Agent,
  now: Date,
  action: "complete" | "fail" | "block",
  id: string,
  patch: {
    status: JobStatus;
    result_summary?: string | null;
    result_ref?: string | null;
    // Only block bumps the gate counter. Bound as a number, not interpolated, so the statement
    // stays one static string that test/jobs.test.ts and the query-plan test can read.
    bumpBlocked?: boolean;
    // A holder's fail the breaker does not count, and why (src/fail-exemption.ts).
    breakerExempt?: BreakerExemption | null;
    evidence?: JobEvidence;
    touches?: (job: JobRow) => D1PreparedStatement[];
    said?: Said;
    // The seat completing a BLOCKED job another credential holds (completeAsSeat): the UPDATE
    // leaves claimed_by alone, so the outcome row credits the driver that did the work.
    seatCloses?: boolean;
    // The seat recording the outcome of work on a QUEUED, unheld job (recordAsSeat): the UPDATE
    // credits the recorder as claimed_by. recordVerb is "record" for the seat, or
    // "complete-unclaimed" for a session completing its own work (src/jobs-seat.ts).
    records?: boolean;
    recordVerb?: "record" | "complete-unclaimed";
    overlaps?: OverlapReport | null;
  },
): Promise<JobResult> {
  const actor = agent.actor;
  const read = await readJob(env.DB, id);
  const notHeld = patch.records
    ? recordRefusal(action, id, read)
    : patch.seatCloses
      ? seatCloseRefusal(action, id, actor, read)
      : holderRefusal(action, id, actor, read);
  if (notHeld) return notHeld;
  if (!read) return refuse(action, `no job ${id}.`);
  // What the row must be for this transition to apply, and who holds it. For a holder's
  // own transition that is the claimed row it holds, as it always was.
  const fromStatus = patch.records ? "queued" : patch.seatCloses ? "blocked" : "claimed";
  const verb = patch.records
    ? (patch.recordVerb ?? "record")
    : patch.seatCloses
      ? "admin-complete"
      : action;
  // The row as the UPDATE will leave it, computed from the read so the mirror and outcome can
  // be built first; the guard at the head of the batch keeps the read true.
  const job: JobRow = {
    ...read,
    ...(patch.records ? { claimed_by: actor } : {}),
    status: patch.status,
    result_summary: patch.result_summary ?? read.result_summary,
    result_ref: patch.result_ref ?? read.result_ref,
    updated_at: now.toISOString(),
    blocked_count: read.blocked_count + (patch.bumpBlocked ? 1 : 0),
  };

  // The transition and every record of it (mirror, audit, outcome, pull request and
  // attribution rows) are one batch. The first statement aborts the whole batch unless the row
  // is still claimed by this caller at the updated_at just read, so all of it commits or none,
  // and a throw cannot leave a finished job with no record.
  //
  // The outcome row is written on terminal transitions only, once per job (the primary key
  // enforces it). A failed job gets one too: recording only successes would make every agent
  // look equally good.
  //
  // Verification runs before the batch and cannot fail the transition: verifyEvidence reports
  // its own errors as notes, so an unreachable GitHub costs the verified flags, not the close.
  let outcome: { row: JobOutcomeRow; notes: string[] } | undefined;
  // The summary is signed as it is written, so the command a blocked job shows a person
  // can be told apart from one changed afterwards (src/job-signing.ts).
  const summarySig = patch.result_summary
    ? await signJobText(env.IMPROVE_SCORE_SECRET, "summary", id, { summary: patch.result_summary })
    : null;
  const statements = [
    requireJobUnchanged(env.DB, id, fromStatus, read.claimed_by, read.updated_at),
    env.DB.prepare(
      `UPDATE jobs SET status = ?2, result_summary = COALESCE(?3, result_summary), result_ref = COALESCE(?4, result_ref),
         summary_sig = CASE WHEN ?3 IS NULL THEN summary_sig ELSE ?8 END,
         updated_at = ?5, blocked_count = blocked_count + ?7, claimed_by = COALESCE(?10, claimed_by)
       WHERE id = ?1 AND status = ?9 AND claimed_by IS ?6 RETURNING id`,
    ).bind(
      id,
      patch.status,
      patch.result_summary ?? null,
      patch.result_ref ?? null,
      now.toISOString(),
      read.claimed_by,
      patch.bumpBlocked ? 1 : 0,
      summarySig,
      fromStatus,
      patch.records ? actor : null,
    ),
    ...(await mirrorStatements(env, job, `job-${verb}`, actor)),
    jobAudit(env.DB, actor, `job-${verb}`, job, {
      status: job.status,
      ...(patch.seatCloses ? { held_by: read.claimed_by } : {}),
      ...(patch.result_summary ? { result_summary: patch.result_summary } : {}),
      ...(patch.result_ref ? { result_ref: patch.result_ref } : {}),
      ...(patch.overlaps ? { overlaps: patch.overlaps } : {}),
      ...(patch.breakerExempt ? { breaker_exempt: patch.breakerExempt } : {}),
    }),
  ];
  if (patch.touches) statements.push(...patch.touches(job));
  // The claim row is built here, BEFORE verifyEvidence runs, from the arguments as
  // sent, so nothing GitHub says can reach it (src/job-claims.ts). It rides in this
  // batch, so a transition the guard aborts leaves no claim behind either.
  const claimed =
    patch.said && (action === "complete" || action === "fail" || action === "block")
      ? claimRow({
          job_id: id,
          action,
          agent: actor,
          namespace: job.namespace,
          raw: patch.said.raw,
          claim: patch.said.claim,
          evidence: patch.evidence,
          capsid_sha: env.BUILD_SHA ?? null,
          now,
        })
      : undefined;
  if (claimed) statements.push(claimStatement(env.DB, claimed));
  if (job.status === "done" || job.status === "failed") {
    const verdict = await verifyEvidence(env, job.namespace, patch.evidence, job.result_ref);
    // One evaluation per worker check, the claim and GitHub's value side by side,
    // after the claim row so its claim_id subquery finds it.
    if (claimed) {
      statements.push(
        ...evaluationStatements(
          env.DB,
          evaluationRows(claimed, verdict, { evaluator_id: workerEvaluatorId(env.BUILD_SHA), now }),
        ),
      );
    }
    const row = outcomeFrom(job, verdict, now, undefined, claimed?.model_id ?? null);
    outcome = { row, notes: verdict.notes };
    statements.push(outcomeStatement(env.DB, row));
    // One row per pull request the evidence named, so the outcome's counts can be traced and
    // the merge state corrected later.
    statements.push(
      ...outcomePrStatements(
        env.DB,
        job.id,
        namedPrUrls(patch.evidence, job.result_ref),
        verdict.pr_states,
        now,
        verdict.pr_identity,
      ),
    );
  }
  try {
    await env.DB.batch(statements);
  } catch (err) {
    if (!isMissingRowAbort(err)) throw err;
    // Nothing was written. Say what the row is now, as a lost race would have.
    const current = await readJob(env.DB, id);
    const gone = patch.seatCloses
      ? seatCloseRefusal(action, id, actor, current)
      : holderRefusal(action, id, actor, current);
    return (
      gone ??
      refuse(
        action,
        `${id} changed between reading it and recording the ${action}. Nothing was written; try again.`,
      )
    );
  }
  return {
    ok: true,
    action,
    job,
    ...(outcome ? { outcome } : {}),
    ...(patch.overlaps ? { overlaps: patch.overlaps } : {}),
  };
}

// Binds a claimed job to the pull request a gate read, in result_ref, so a later call
// naming another pull request is still answered for this one. Returns the row as bound,
// or the refusal when the caller does not hold the job or the row moved.
async function bindPullRequest(
  env: Env,
  agent: Agent,
  now: Date,
  action: string,
  current: JobRow,
  pr: string,
  auditAction: "job-ci-bound",
): Promise<JobRow | JobResult> {
  const notHeld = holderRefusal(action, current.id, agent.actor, current);
  if (notHeld) return notHeld;
  const job: JobRow = { ...current, result_ref: pr, updated_at: now.toISOString() };
  const bound = await guardedTransition(env, current, [
    env.DB.prepare(
      `UPDATE jobs SET result_ref = ?2, updated_at = ?3
       WHERE id = ?1 AND status = 'claimed' AND claimed_by = ?4 AND result_ref IS NULL RETURNING id`,
    ).bind(current.id, pr, now.toISOString(), agent.actor),
    ...(await mirrorStatements(env, job, auditAction, agent.actor)),
    jobAudit(env.DB, agent.actor, auditAction, job, { result_ref: pr }),
  ]);
  if (!bound)
    return refuse(
      action,
      `${current.id} moved between reading it and recording its pull request. Ask again.`,
    );
  return job;
}

type CompleteArgs = {
  result_summary: string;
  result_ref?: string;
  evidence?: JobEvidence;
  claim?: ClaimInput;
  raw?: ClaimRaw;
};

export async function completeJob(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  args: CompleteArgs,
): Promise<JobResult> {
  return completeWith(env, agent, now, id, args, false);
}

// The seat completing a blocked job (src/jobs-seat.ts adminCompleteJob checks who may).
// The same checks and records as a holder's complete; only the row it applies to differs.
export async function completeAsSeat(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  args: CompleteArgs,
): Promise<JobResult> {
  return completeWith(env, agent, now, id, args, true);
}

// The seat recording the outcome of a queued job that was worked without a claim. The
// same checks, verification and records as a complete.
export async function recordAsSeat(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  args: CompleteArgs,
): Promise<JobResult> {
  return completeWith(env, agent, now, id, args, true, "record");
}

// A session completing a queued job it worked without a claim, naming the pull request
// (src/jobs-seat.ts completeUnclaimed checks who may). The record path, audited as
// complete-unclaimed so it is not read as the seat recording somebody else's work.
export async function completeWithoutClaim(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  args: CompleteArgs,
): Promise<JobResult> {
  return completeWith(env, agent, now, id, args, true, "complete-unclaimed");
}

async function completeWith(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  args: CompleteArgs,
  seatCloses: boolean,
  records: false | "record" | "complete-unclaimed" = false,
): Promise<JobResult> {
  if (!args.result_summary?.trim()) {
    return refuse(
      "complete",
      "complete needs a result_summary. A done job with no summary is a job the seat has to reconstruct from the diff.",
    );
  }
  // Refused before anything else runs, so a claim that cannot be recorded whole
  // leaves no row of any kind.
  const claim = parseClaim(args.claim);
  if ("error" in claim) return refuse("complete", claim.error);
  // Checked before the write, because the outcome row this call produces cannot be
  // corrected afterwards: a result_ref and evidence swallowed into the summary would
  // leave a row that records nothing.
  const swallowed = swallowedParamTag(args.result_summary);
  if (swallowed) return refuse("complete", swallowedTagRefusal("result_summary", swallowed));
  const completeRaw: ClaimRaw = args.raw ?? {
    evidence: args.evidence,
    claim: args.claim,
    result_summary: args.result_summary,
    result_ref: args.result_ref,
  };
  const held = await readJob(env.DB, id);
  // The CI gate (src/complete-ci.ts): every pull request this complete names, and the one
  // the job is bound to, must show green CI. A refused holder's job is bound to the pull
  // request that was not green, so naming a different one next time does not escape it.
  // The seat's close writes nothing before it is allowed.
  if (held) {
    const bound = parsePrUrl(held.result_ref) ? [held.result_ref!.trim()] : [];
    const ci = await ciRefusal(
      env,
      held.namespace,
      [...new Set([...bound, ...namedPrUrls(args.evidence, args.result_ref)])],
      held.body,
    );
    if (ci) {
      if (!seatCloses && !held.result_ref && ci.pr) {
        const kept = await bindPullRequest(
          env,
          agent,
          now,
          "complete",
          held,
          ci.pr,
          "job-ci-bound",
        );
        if (!("status" in kept)) return kept;
      }
      return refuse("complete", `${id} was not completed: ${ci.why}`);
    }
  }
  // Overlap warning (Track A D1): the pull requests this complete names, against every other
  // open one. The line rides in the summary the seat reads; the check cannot fail the call.
  const overlaps = held
    ? await checkOverlaps(
        env,
        held.namespace,
        namedPrUrls(args.evidence, args.result_ref ?? held.result_ref),
      )
    : null;
  const overlap = overlaps ? overlapLine(overlaps) : null;
  return holderTransition(env, agent, now, "complete", id, {
    status: "done",
    result_summary: overlap
      ? `${args.result_summary}

${overlap}`
      : args.result_summary,
    overlaps,
    result_ref: args.result_ref ?? null,
    evidence: args.evidence,
    said: { claim: claim.claim, raw: completeRaw },
    ...(records
      ? { records: true, recordVerb: records }
      : seatCloses
        ? {
            seatCloses: true,
            // The seat ending a blocked job's wait, in the same batch as the audit row. The job
            // row it is built from still names the driver, so detail.held_by is who did the work.
            touches: (job: JobRow) => [
              touchStatement(env.DB, {
                job_id: job.id,
                namespace: job.namespace,
                kind: "admin_complete",
                actor: agent.actor,
                actor_kind: actorKind(agent.actor, { seat: true }),
                detail: { held_by: job.claimed_by, result_ref: job.result_ref },
                sinceGate: true,
                at: now.toISOString(),
              }),
            ],
          }
        : {}),
  });
}
