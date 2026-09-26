import type { Env } from "./env";
import type { Agent } from "./agents";
import {
  corruptRequirement,
  missingForJob,
  outsideJobNamespace,
  swallowedParamTag,
  swallowedTagRefusal,
  type JobRow,
  CORRECTION_CAP,
  RETRY_CAP_REASON,
  atCorrectionCap,
} from "./jobs-schema";
import { approveByPolicy, classifyCommand, type GateClass } from "./gate-policy";
import { readRepoFile } from "./github/contents";
import { ghFetch, parsePrUrl, resolveRepo, type PrUrl } from "./github/client";
import { verifySignedBody } from "./improve-task";
import { outcomeFrom, outcomeStatement, verifyEvidence } from "./job-outcomes";
import { jobAudit, mirrorStatements, type ResumeNote } from "./jobs-mirror";
import { commandFromSummary, failJob } from "./jobs-holder";
import type { JobSkills } from "./job-outcomes";
import {
  actorShapeRefusal,
  callerIsSeat,
  correctionsForWork,
  guardedTransition,
  heldClaim,
  leaseUntil,
  markJobFailed,
  movedBeforeFailing,
  readJob,
  recordShortfall,
  refuse,
  type JobResult,
} from "./jobs-transition";

// The transitions made on a job the caller does not hold: the seat's fail and release,
// supersede and resume.

// The seat stepping in, on a job it does not hold.
//
// Every other transition keys on `claimed_by = <caller>`, which stops two drivers
// treading on each other but leaves no way to close a job whose driver is gone: the
// machine was turned off, the session died, the work was superseded from a chat.
//
// The seat only: the admin, or a caller holding can_merge (callerIsSeat), the rule
// supersede and resume use. The seat that decides is routinely not the session that
// held the job, and the seat key holds can_merge without being the admin. No driver
// holds can_merge, so a driver still cannot fail another driver's job.
//
// It refuses a job that is already finished rather than rewriting one, and says so
// rather than reporting a no-op as success. The mirror and audit row ride in the same
// guarded batch as every other transition.
export async function adminFailJob(env: Env, agent: Agent, now: Date, id: string, reason: string): Promise<JobResult> {
  if (!callerIsSeat(agent)) {
    return refuse(
      "admin-fail",
      `${agent.actor} may only fail a job it holds. Failing somebody else's job is the seat's act, and this caller holds neither the admin identity nor can_merge.`
    );
  }
  if (!reason?.trim()) return refuse("admin-fail", "fail needs a reason. A failed job with no reason is one nobody can retry or rule on.");
  const current = await readJob(env.DB, id);
  if (!current) return refuse("admin-fail", `no job ${id}.`);
  // The job's own namespace, since a seat key may be scoped narrower than the admin.
  const outside = outsideJobNamespace(agent, current.namespace);
  if (outside) return refuse("admin-fail", `${agent.actor} cannot fail ${id} ('${current.title}'): ${outside}`);
  if (current.status !== "queued" && current.status !== "claimed" && current.status !== "blocked") {
    return refuse("admin-fail", `${id} is already ${current.status}; there is nothing to fail.`);
  }
  const job: JobRow = { ...current, status: "failed", result_summary: reason, lease_expires: null, updated_at: now.toISOString() };
  const statements = [
    env.DB.prepare(
      `UPDATE jobs SET status = 'failed', result_summary = ?3, lease_expires = NULL, updated_at = ?2
       WHERE id = ?1 AND status IN ('queued', 'claimed', 'blocked') RETURNING id`
    ).bind(id, now.toISOString(), reason),
    ...(await mirrorStatements(env.DB, job, "job-admin-fail", agent.actor)),
    jobAudit(env.DB, agent.actor, "job-admin-fail", job, { status: job.status, reason, held_by: job.claimed_by }),
  ];
  // An outcome row, for the same reason `fail` writes one: a job the seat had to close
  // because its driver never came back is the kind of ending the record should show.
  //
  // Only when somebody held it. A queued job the seat cancelled was never worked, and
  // inventing an agent would put a failure on a credential that had not touched the
  // job. No evidence argument either: the seat did not do the work.
  if (job.claimed_by) {
    const verdict = await verifyEvidence(env, job.namespace, undefined);
    statements.push(outcomeStatement(env.DB, outcomeFrom(job, verdict, now)));
  }
  if (!(await guardedTransition(env, current, statements))) {
    const moved = await readJob(env.DB, id);
    return refuse(
      "admin-fail",
      `${id} changed between reading it and failing it: it is now ${moved?.status ?? "gone"}${moved?.claimed_by ? `, held by ${moved.claimed_by}` : ""}. Nothing was written; look again before failing it.`
    );
  }
  return { ok: true, action: "admin-fail", job };
}

// fail through the jobs tool. The holder failing its own job is an ordinary fail. The
// seat failing a job somebody else holds, or nobody holds, is adminFailJob. Anyone else
// gets failJob's own refusal for a job it does not hold.
export async function failAsCaller(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  reason: string,
  skills?: JobSkills
): Promise<JobResult> {
  const current = await readJob(env.DB, id);
  if (current && current.claimed_by !== agent.actor && callerIsSeat(agent)) {
    return adminFailJob(env, agent, now, id, reason);
  }
  return failJob(env, agent, now, id, reason, skills);
}

// Release: the seat returning a claimed job to the queue when its holder is gone (the
// session ended, the machine was turned off). Without it the job waits out its lease,
// and a driver can hold only one claim, so nothing else reaches that driver meanwhile.
//
// Not an ending, so no outcome row: the job is worked again and ends with a real one.
// A job whose work already landed is released too, and the next session completes it
// with the pull request as evidence, which the Worker verifies. The seat did not do
// the work, so it does not report it done.
//
// claimed_at is kept, so the job's duration runs from its first claim. The UPDATE is
// keyed on the holder read, so a lease that changed hands in between is not released
// out from under the new holder.
export async function releaseJob(env: Env, agent: Agent, now: Date, id: string, reason: string): Promise<JobResult> {
  if (!callerIsSeat(agent)) {
    return refuse(
      "release",
      `${agent.actor} cannot release a job. Releasing a claim somebody else holds is the seat's act, and this caller holds neither the admin identity nor can_merge.`
    );
  }
  if (!reason?.trim()) {
    return refuse("release", "release needs a reason: why the holder is not coming back. It is recorded in the audit row.");
  }
  const swallowed = swallowedParamTag(reason);
  if (swallowed) return refuse("release", swallowedTagRefusal("reason", swallowed));
  const current = await readJob(env.DB, id);
  if (!current) return refuse("release", `no job ${id}.`);
  const outside = outsideJobNamespace(agent, current.namespace);
  if (outside) return refuse("release", `${agent.actor} cannot release ${id} ('${current.title}'): ${outside}`);
  if (current.status !== "claimed") {
    return refuse(
      "release",
      `${id} is ${current.status}, not claimed. Release returns a claimed job to the queue; a blocked job is resumed, a queued one is already free, and a finished one is not reopened.`
    );
  }
  if (current.claimed_by === agent.actor) {
    return refuse("release", `${id} is held by ${agent.actor} itself. A holder ends its own claim with fail or block.`);
  }
  const job: JobRow = { ...current, status: "queued", claimed_by: null, lease_expires: null, updated_at: now.toISOString() };
  const won = await guardedTransition(env, current, [
    env.DB.prepare(
      `UPDATE jobs SET status = 'queued', claimed_by = NULL, lease_expires = NULL, updated_at = ?2
       WHERE id = ?1 AND status = 'claimed' AND claimed_by = ?3 RETURNING id`
    ).bind(id, now.toISOString(), current.claimed_by),
    ...(await mirrorStatements(env.DB, job, "job-released", agent.actor)),
    jobAudit(env.DB, agent.actor, "job-released", job, { reason, held_by: current.claimed_by }),
  ]);
  if (!won) {
    const moved = await readJob(env.DB, id);
    return refuse(
      "release",
      `${id} changed between reading it and releasing it: it is now ${moved?.status ?? "gone"}${moved?.claimed_by ? `, held by ${moved.claimed_by}` : ""}. Nothing was written.`
    );
  }
  return { ok: true, action: "release", job };
}

// Supersede: the seat replacing a job before any work was done on it, for a corrected
// or reposted body, a reorder or a withdrawal. Without it the only way to close such a
// job is to claim it and fail it, and the history fills with failures that never
// happened.
//
// No outcome row, no pull request rows, no attribution. Nothing was attempted, so a
// row here would put a failure on a credential that did no work.
//
// Allowed from `queued` by any caller that may write the job's namespace, since nobody
// holds it. From `claimed`, only while the row records no work (no gate hit, no
// resume, no correction, no result_ref), and only by the holder or the seat
// (callerIsSeat). Anything later is ended by `fail` or the console's admin fail.
//
// The whole rule is in the one keyed UPDATE. The checks before it only choose the
// refusal message; a driver that hits a gate between the read and the write leaves no
// row to supersede, rather than being superseded out from under its work.

/** Why a job's row shows work was done on it, or null. */
function workRecorded(job: JobRow): string | null {
  const done: string[] = [];
  if (job.blocked_count > 0) done.push(`it has hit a gate ${job.blocked_count} time${job.blocked_count === 1 ? "" : "s"}`);
  if (job.resumed_count > 0) done.push(`it has been resumed ${job.resumed_count} time${job.resumed_count === 1 ? "" : "s"}`);
  if (job.corrections_count > 0) done.push(`it has been sent back for correction ${job.corrections_count} time${job.corrections_count === 1 ? "" : "s"}`);
  if (job.result_ref) done.push(`it records a result_ref (${job.result_ref})`);
  return done.length ? done.join(", ") : null;
}

export async function supersedeJob(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  args: { reason: string; replaced_by?: string }
): Promise<JobResult> {
  const reason = args.reason?.trim();
  if (!reason) {
    return refuse("supersede", "supersede needs a reason: what replaced this job, or why it was withdrawn.");
  }
  const swallowed = swallowedParamTag(args.reason);
  if (swallowed) return refuse("supersede", swallowedTagRefusal("reason", swallowed));

  const current = await readJob(env.DB, id);
  if (!current) return refuse("supersede", `no job ${id}.`);
  // The job's own namespace, asked here for the reason resume asks it: the tool's
  // check saw only the namespace argument, which an id-based call may omit.
  const outside = outsideJobNamespace(agent, current.namespace);
  if (outside) return refuse("supersede", `${agent.actor} cannot supersede ${id} ('${current.title}'): ${outside}`);

  const replacedBy = args.replaced_by?.trim() || null;
  if (replacedBy) {
    if (replacedBy === id) return refuse("supersede", `${id} cannot be replaced by itself.`);
    const replacement = await env.DB.prepare("SELECT id, namespace FROM jobs WHERE id = ?1")
      .bind(replacedBy)
      .first<{ id: string; namespace: string }>();
    if (!replacement) return refuse("supersede", `no job ${replacedBy}. replaced_by names the job that replaces this one, and it must exist.`);
    if (replacement.namespace !== current.namespace) {
      return refuse(
        "supersede",
        `${replacedBy} is in ${replacement.namespace} and ${id} is in ${current.namespace}. A job is replaced by work in its own namespace.`
      );
    }
  }

  if (current.status !== "queued" && current.status !== "claimed") {
    return refuse(
      "supersede",
      `${id} is ${current.status}. Supersede closes a queued job, or a claimed one with no work recorded; ${current.status === "blocked" ? "a blocked job has hit a gate, so it is failed instead" : "a finished job is not rewritten"}.`
    );
  }
  if (current.status === "claimed") {
    const isSeat = callerIsSeat(agent);
    if (current.claimed_by !== agent.actor && !isSeat) {
      return refuse(
        "supersede",
        `${id} is held by ${current.claimed_by}, not by ${agent.actor}. Superseding a job somebody else holds is the seat's act, and this caller holds neither the admin identity nor can_merge.`
      );
    }
    const work = workRecorded(current);
    if (work) return refuse("supersede", `${id} has work recorded on it: ${work}. Fail it instead; supersede is for a job replaced before any work was done.`);
  }

  const summary = replacedBy ? `Superseded by ${replacedBy}: ${reason}` : `Superseded: ${reason}`;
  // ?4 is the holder read above, so a lease that expired and went to another driver
  // between the read and this write is not superseded out from under the new one.
  const job: JobRow = { ...current, status: "superseded", result_summary: summary, lease_expires: null, updated_at: now.toISOString() };
  // The guard makes the mirror and audit row commit only with the UPDATE: a row that
  // changed since the read (a gate hit, a claim) aborts all three.
  const won = await guardedTransition(env, current, [
    env.DB.prepare(
      `UPDATE jobs SET status = 'superseded', result_summary = ?2, lease_expires = NULL, updated_at = ?3
       WHERE id = ?1 AND (status = 'queued' OR (status = 'claimed' AND claimed_by = ?4 AND blocked_count = 0
         AND resumed_count = 0 AND corrections_count = 0 AND result_ref IS NULL)) RETURNING id`
    ).bind(id, summary, now.toISOString(), current.claimed_by),
    ...(await mirrorStatements(env.DB, job, "job-superseded", agent.actor)),
    jobAudit(env.DB, agent.actor, "job-superseded", job, {
      reason,
      replaced_by: replacedBy,
      from: current.status,
      held_by: current.claimed_by,
    }),
  ]);
  if (!won) {
    const moved = await readJob(env.DB, id);
    const work = moved ? workRecorded(moved) : null;
    return refuse(
      "supersede",
      `${id} changed between reading it and superseding it: it is now ${moved?.status ?? "gone"}${moved?.claimed_by ? `, held by ${moved.claimed_by}` : ""}${work ? `, and ${work}` : ""}. Nothing was written.`
    );
  }
  return { ok: true, action: "supersede", job };
}

// Resume. A gate is a pause, not an ending. If `blocked` were terminal, a job the
// driver stopped at a gate could never be picked back up: the human would run the
// command, the work would land, and the row would still describe the state before the
// gate, because `claim` refuses anything that is not queued.
//
// The signature is checked again. `claim` verifies the body before handing a job to a
// driver, but a blocked job then sits in the table for as long as a human takes, which
// is the window in which a row could be edited. Resume hands that body back to a
// session holding local shell and repo credentials, so it re-verifies on the same
// terms and marks a tampered job failed rather than returning it.
//
// Any write-grant caller may resume, which the tool layer has already checked. It is
// not restricted to the original claimer, because the point is that a human approved
// something, and the seat that approves is routinely not the session that blocked. The
// reason is required and lands in the audit row, so what was approved is recorded
// rather than implied.
//
// Except the claimant itself, on a plain resume. A driver that blocked a job on a
// deploy, a secret or a force push could otherwise resume it with any reason, and the
// audit row would read "approved: <reason>" as though a human had said yes. The
// claimant may still resume its own job as the admin, with can_merge, or through
// approved_by_policy for a branch push or a pull request.
//
// The lease goes back to the driver that blocked it, not to the caller that resumed
// it: a blocked row keeps claimed_by. A seat that took the lease would hold a job it
// has no shell to finish. `take` is the explicit way for a resumer to acquire the job
// instead, and it runs every check a claim runs.
//
// Unless that credential cannot take it back. A driver already holding another claim
// would make the approval wait on that job, one answer at a time. A credential that is
// not a minted agent (the admin identity every chat tab connects as, or a legacy
// operator key) names no particular session, so a lease given to it is worked by
// nobody until the sweep. In both cases the job goes back to the queue with its
// approval, and whichever session claims it next gets the resume note. The job's flags
// and record bar are asked at that claim, as for any queued job.
export interface ResumeOptions {
  // The pre-approved gate. When set, this resume is approved on the signed gate policy
  // rather than on a human having said yes, and the value is the policy version the
  // caller read. The blocked command is matched against the policy classes and the
  // resume is refused when it matches none, so this narrows what the caller may do on
  // its own rather than widening it.
  approvedByPolicy?: string;
  // The resumer acquires the job rather than returning it to the driver that blocked.
  take?: boolean;
  // This resume sends the work back to be corrected, so it spends from the retry
  // cap's budget. A plain resume does not, because an ordinary push through a gate
  // corrects nothing.
  correction?: boolean;
  // The seat's full note, beside the one-line reason. Recorded in the audit row as
  // `note` and handed on whole in resume_note and the mirror document.
  note?: string;
}

// What a driver may approve for itself: pushing its own branch and opening its own
// pull request. Not a migration, which stays a human gate, so `additive_migration`
// stays the seat's to approve. The classes and the never list are the policy's own;
// this only narrows which of them a driver may use.
const DRIVER_SELF_APPROVED: readonly GateClass[] = ["push_branch", "open_pr"];

// A minted agent's actor is `agent:<name>`: one credential, one driver. The admin
// identity (`github:<login>`) and a legacy operator key (`opkey:<fingerprint>`) are
// shared by whatever sessions connect with them.
const isMintedActor = (actor: string): boolean => actor.startsWith("agent:");

/** The head commit of the job's own pull request, and the mapped repo it is on.
 *  The pull request is the one the job records: its result_ref, or its job_outcome_prs
 *  rows. Throws with the reason when there is none, more than one, one outside the
 *  namespace's mapping, or one GitHub cannot read. */
async function jobBranchHead(env: Env, job: JobRow): Promise<{ repo: string; sha: string }> {
  const recorded = await env.DB.prepare("SELECT pr_url FROM job_outcome_prs WHERE job_id = ?1")
    .bind(job.id)
    .all<{ pr_url: string }>();
  const byKey = new Map<string, PrUrl>();
  for (const ref of [job.result_ref, ...(recorded.results ?? []).map((r) => r.pr_url)]) {
    const pr = parsePrUrl(ref);
    if (pr) byKey.set(`${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase(), pr);
  }
  if (byKey.size === 0) {
    throw new Error(`${job.id} records no pull request, so there is no branch head to read the migration at`);
  }
  if (byKey.size > 1) {
    throw new Error(`${job.id} records more than one pull request (${[...byKey.keys()].join(", ")}), so which head runs the migration is not known`);
  }
  const [pr] = [...byKey.values()];
  // resolveRepo refuses a repo the namespace does not map, before GitHub is asked.
  const { owner, repo, full } = await resolveRepo(env, job.namespace, `${pr.owner}/${pr.repo}`);
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls/${pr.number}`);
  if (!resp.ok) throw new Error(`reading pull request #${pr.number} failed (${resp.status})`);
  const sha = ((await resp.json()) as { head?: { sha?: string } }).head?.sha ?? "";
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`pull request #${pr.number} reported no head commit`);
  return { repo: full, sha };
}

export async function resumeJob(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  reason: string,
  opts: ResumeOptions = {}
): Promise<JobResult> {
  const { approvedByPolicy, take = false, correction = false } = opts;
  // A blank note is no note, so resume_note does not carry an empty block.
  const fullNote = opts.note?.trim() ? opts.note : undefined;
  const actor = agent.actor;
  const badActor = actorShapeRefusal("resume", actor);
  if (badActor) return badActor;
  if (!reason?.trim()) {
    return refuse("resume", "resume needs a reason: what the human approved. A job that came back off a gate with no record of who cleared it is a gate that did not happen.");
  }

  const current = await readJob(env.DB, id);
  if (!current) return refuse("resume", `no job ${id}.`);
  if (current.status !== "blocked") {
    return refuse(
      "resume",
      `${id} is ${current.status}, not blocked. Resume is how a job comes back off a gate; a queued job is claimed and a done or failed one is finished.`
    );
  }

  // A plain resume is a record that somebody approved the gate, and the claimant
  // approving its own gate is no approval. `take` does not change who the claimant is,
  // so a claimant passing take is refused the same way.
  const isSeat = callerIsSeat(agent);
  if (approvedByPolicy === undefined && !isSeat && current.claimed_by === actor) {
    return refuse(
      "resume",
      `${actor} blocked ${id} and cannot approve its own gate with a plain resume. The seat (admin or can_merge) resumes it once the command is approved, ` +
        `or, for a branch push or a pull request only, resume with approved_by_policy. It stays blocked.`
    );
  }

  // The claimant the lease goes to. A blocked row with no claimant (none should
  // exist, since block keys on claimed_by) goes to the caller.
  const holder = take || !current.claimed_by ? actor : current.claimed_by;

  // The same one-claim-per-caller rule the claim path runs on, asked of whoever ends
  // up holding the lease: a driver holding two has abandoned one. Without take, a
  // holder that cannot take the job back sends it to the queue instead.
  const held = await heldClaim(env.DB, holder);
  const toQueue: string | null = take
    ? null
    : held
      ? `${holder} holds ${held.id} ('${held.title}' in ${held.namespace}), so ${id} went back to the queue for the next free session.`
      : !isMintedActor(holder)
        ? `${holder} is a shared identity rather than one driver's session, so ${id} went back to the queue for the next free session.`
        : null;
  if (held && !toQueue) {
    return refuse("resume", `${holder} already holds ${held.id} ('${held.title}' in ${held.namespace}), leased until ${held.lease_expires}. Finish it before resuming another.`);
  }
  const acquiring = !toQueue && holder === actor;

  // A resume is a claim when the caller acquires the job, so it asks the same scope
  // question a claim asks: a driver that could not have claimed this job must not
  // acquire it by resuming it. When the job goes back to its own claimant, that
  // claimant passed these checks at its claim, and the resumer is not taking anything.
  const corrupt = corruptRequirement(current);
  if (corrupt) {
    return refuse("resume", `${id} has a corrupt requirement: ${corrupt}. It stays blocked; a requirement that cannot be read is not the same as none.`);
  }
  // The namespace is asked either way. A resume that returns the job to its own
  // claimant still moves a job, so a caller that cannot write the job's namespace may
  // not do it; only the job's flags are left to the claimant it goes back to.
  const outside = outsideJobNamespace(agent, current.namespace);
  if (outside) {
    return refuse("resume", `${actor} cannot resume ${id} ('${current.title}'): ${outside} It stays blocked.`);
  }
  if (acquiring) {
    const missing = missingForJob(agent, current.namespace, current.required_scopes);
    if (missing) {
      return refuse("resume", `${actor} cannot resume ${id} ('${current.title}'): ${missing} It stays blocked for a driver that can finish it.`);
    }
    // And the record question, on the same reasoning.
    const resumeShortfall = await recordShortfall(env.DB, actor, current);
    if (resumeShortfall) {
      return refuse("resume", `${actor} cannot resume ${id} ('${current.title}'): ${resumeShortfall} It stays blocked for a driver that can finish it.`);
    }
  }

  // The retry cap, checked before anything is spent. A job sent back twice already is
  // one where each further correction has stopped being progress, and what to do next
  // belongs to a person. An admin is that person arriving, so an admin resume passes
  // and does not spend the budget.
  const spentOnWork = await correctionsForWork(env.DB, current.namespace, current.title);
  if (!agent.admin && atCorrectionCap(spentOnWork)) {
    return refuse(
      "resume",
      `the work titled '${current.title}' has been corrected ${spentOnWork} times across every job posted for it, which is the cap of ${CORRECTION_CAP}: ${RETRY_CAP_REASON}. ` +
        `The count is per (namespace, title) rather than per row, so failing this job and posting it again does not reset it. ` +
        `Every resume so far was defensible on its own, which is why the ceiling is counted rather than argued. ` +
        `An admin caller may resume it; a driver or the seat may not.`
    );
  }

  const verdict = await verifySignedBody(env.IMPROVE_SCORE_SECRET, current.body, "job body");
  if (!verdict.ok) {
    const marked = await markJobFailed(env, current, "blocked", verdict.reason, "job-signature-refused", actor, { reason: verdict.reason, at: "resume" }, now);
    if (!marked.failed) return movedBeforeFailing("resume", id, marked.current, "failed its signature check");
    return refuse("resume", `${id} failed its signature check and has been marked failed: ${verdict.reason}`);
  }

  // The policy check runs before the lease is taken, so a refusal leaves the job
  // blocked as it was rather than claimed by a caller whose approval did not hold.
  let policyMatch: { klass: string; detail: string; version: string } | null = null;
  if (approvedByPolicy !== undefined) {
    // Approving on policy is the seat's act. `resume` takes the write grant every
    // driver holds, so without this check any driver could pass the policy version and
    // approve its own blocked command. The policy's shape is "what the seat may approve
    // alone", and a check nobody performs would make that meaningless.
    //
    // A driver may approve its own branch push and pull request, and nothing wider:
    // only on a job it blocked itself and still holds, and only when every class the
    // command matched is in DRIVER_SELF_APPROVED. The classification is still the
    // Worker's, through the same approveByPolicy call the seat's approval makes, so the
    // never list still runs first and a force push still waits.
    if (!isSeat && (current.claimed_by !== actor || take)) {
      return refuse(
        "resume",
        `${id} cannot be approved by ${agent.actor} on the gate policy alone. A driver may approve only a job it blocked itself, ` +
          `and ${id} was blocked by ${current.claimed_by ?? "nobody on record"}. Approving somebody else's blocked command is the seat's act, ` +
          `and this caller holds neither the admin identity nor can_merge.`
      );
    }
    const command = commandFromSummary(current.result_summary);
    // The driver's narrower list is checked before the policy, over the same
    // classifier, so a driver's migration is refused without a repo read on its behalf.
    // A command that classifies as nothing falls through to approveByPolicy, which
    // refuses it for its own reason.
    if (!isSeat && command) {
      const match = classifyCommand(command);
      const beyond = "klasses" in match ? match.klasses.filter((k) => !DRIVER_SELF_APPROVED.includes(k)) : [];
      if (beyond.length > 0) {
        return refuse(
          "resume",
          `${id} is not pre-approved for a driver: it matched ${beyond.join(", ")}, which a driver may not approve for itself. ` +
            `A driver approves only ${DRIVER_SELF_APPROVED.join(" and ")}. It stays blocked for the human.`
        );
      }
    }
    // A migration is read at the job's branch head, not on the default branch. The
    // approved command runs the file in the driver's checkout, so reading the default
    // branch would refuse a new migration and could approve a same-named file whose
    // content is not what runs. Read once, and only when the command names a
    // migration. A read that fails throws its reason, which approveByPolicy puts in the
    // refusal.
    let head: Promise<{ repo: string; sha: string }> | null = null;
    const verdict = await approveByPolicy(env, approvedByPolicy, command, async (path) => {
      head ??= jobBranchHead(env, current);
      const at = await head;
      const file = await readRepoFile(env, current.namespace, path, at.sha, at.repo);
      return (file as { content?: string }).content ?? null;
    });
    if (!verdict.approved) {
      return refuse("resume", id + " is not pre-approved: " + verdict.reason);
    }
    // The approved verdict is the one that counts, so the driver's list is asserted on
    // it too. Unreachable unless the two classifications disagree, which is the case
    // this line exists for.
    if (!isSeat && verdict.klasses.some((k) => !DRIVER_SELF_APPROVED.includes(k))) {
      return refuse("resume", `${id} is not pre-approved for a driver: it matched ${verdict.klass}. It stays blocked for the human.`);
    }
    policyMatch = { klass: verdict.klass, detail: verdict.detail, version: verdict.policyVersion };
  }

  const expires = toQueue ? null : leaseUntil(now);
  // Only a correction spends the budget, and never an admin's. The 0 or 1 is bound
  // rather than interpolated for the same reason bumpBlocked is: the statement stays
  // one static string that the source guards can read and the query-plan test can
  // EXPLAIN.
  //
  // claimed_at is not touched. It is the first claim, and duration_minutes measures
  // from it, so a job that waited at a gate is measured over its whole working life
  // rather than over the stretch after its last resume.
  const spend = correction && !agent.admin ? 1 : 0;
  const job: JobRow = {
    ...current,
    status: toQueue ? "queued" : "claimed",
    claimed_by: toQueue ? null : holder,
    lease_expires: expires,
    resumed_count: current.resumed_count + 1,
    corrections_count: current.corrections_count + spend,
    updated_at: now.toISOString(),
  };
  const resumeNote: ResumeNote = {
    reason,
    ...(fullNote ? { note: fullNote } : {}),
    by: actor,
    at: now.toISOString(),
    ...(policyMatch ? { approved_by_policy: policyMatch.version, policy_class: policyMatch.klass } : {}),
    ...(spend ? { correction: true as const } : {}),
  };
  // One static statement for both returns, so the source guards and the query-plan
  // test read one shape: ?6 is 'claimed' or 'queued', and ?2 and ?4 are NULL for the
  // queue.
  const won = await guardedTransition(env, current, [
    env.DB.prepare(
      `UPDATE jobs SET status = ?6, claimed_by = ?2, lease_expires = ?4,
         resumed_count = resumed_count + 1, corrections_count = corrections_count + ?5, updated_at = ?3
       WHERE id = ?1 AND status = 'blocked' RETURNING id`
    ).bind(id, job.claimed_by, now.toISOString(), expires, spend, job.status),
    ...(await mirrorStatements(env.DB, job, "job-resumed", actor, resumeNote)),
    jobAudit(env.DB, actor, "job-resumed", job, {
      approved: reason,
      ...(fullNote ? { note: fullNote } : {}),
      held_by: job.claimed_by,
      ...(toQueue ? { returned_to: "queued", previous_holder: holder } : {}),
      ...(take ? { taken: true } : {}),
      ...(spend ? { correction: true } : {}),
      lease_expires: expires,
      resumed_count: job.resumed_count,
      corrections_count: job.corrections_count,
      ...(agent.admin ? { cap_lifted_by_admin: true } : {}),
      // Which class matched, not merely that one did. A row saying "approved by policy"
      // cannot be checked against the policy afterwards; one naming the class and what
      // it matched can.
      ...(policyMatch
        ? { approved_by_policy: policyMatch.version, policy_class: policyMatch.klass, policy_detail: policyMatch.detail }
        : {}),
    }),
  ]);
  if (!won) {
    return refuse("resume", `${id} left blocked between reading it and resuming it. Nothing was written; ask again.`);
  }
  return { ok: true, action: "resume", job, resume_note: resumeNote, ...(toQueue ? { note: toQueue } : {}) };
}
