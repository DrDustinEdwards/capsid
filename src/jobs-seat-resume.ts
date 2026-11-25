import type { Env } from "./env";
import type { Agent } from "./agents";
import {
  corruptRequirement,
  missingForJob,
  outsideJobNamespace,
  type JobRow,
  CORRECTION_CAP,
  RETRY_CAP_REASON,
  atCorrectionCap,
} from "./jobs-schema";
import { approveByPolicy, classifyCommand, type GateClass } from "./gate-policy";
import { readRepoFile } from "./github/contents";
import { parsePrUrl } from "@dustinedwards/site-runtime/github";
import { ghFetch, resolveRepo } from "./github/client";
import { verifySignedBody } from "./signed-docs";
import { jobAudit, mirrorStatements, resumeNoteFields, type ResumeNote } from "./jobs-mirror";
import { signJobText } from "./job-signing";
import { resumeDestination } from "./jobs-seat-auto";
import { commandFromSummary } from "./jobs-holder-block";
import { actorKind, touchStatement } from "./job-touches";
import {
  actorShapeRefusal,
  callerIsSeat,
  correctionsForWork,
  guardedTransition,
  markJobFailed,
  movedBeforeFailing,
  readJob,
  recordShortfall,
  refuse,
  type JobResult,
} from "./jobs-transition";

type PrUrl = NonNullable<ReturnType<typeof parsePrUrl>>;

// Resume. A gate is a pause, not an ending: `claim` refuses anything that is not queued, so a job
// a driver stopped at a gate could otherwise never be picked back up.
export interface ResumeOptions {
  // Set: approved on the signed gate policy (the value is the policy version the caller read). The
  // blocked command must match a policy class or the resume is refused.
  approvedByPolicy?: string;
  take?: boolean;
  correction?: boolean;
  note?: string;
}

const DRIVER_SELF_APPROVED: readonly GateClass[] = ["push_branch", "open_pr"];

/**
 * The head commit of the job's own pull request, and the mapped repo it is on. The pull request is
 * the one the job records: its result_ref, or its job_outcome_prs rows. Throws with the reason
 * when there is none, more than one, one outside the namespace's mapping, or one GitHub cannot
 * read.
 */
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
    throw new Error(
      `${job.id} records no pull request, so there is no branch head to read the migration at`,
    );
  }
  if (byKey.size > 1) {
    throw new Error(
      `${job.id} records more than one pull request (${[...byKey.keys()].join(", ")}), so which head runs the migration is not known`,
    );
  }
  const [pr] = [...byKey.values()];
  const { owner, repo, full } = await resolveRepo(env, job.namespace, `${pr.owner}/${pr.repo}`);
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls/${pr.number}`);
  if (!resp.ok) throw new Error(`reading pull request #${pr.number} failed (${resp.status})`);
  const sha = ((await resp.json()) as { head?: { sha?: string } }).head?.sha ?? "";
  if (!/^[0-9a-f]{40}$/i.test(sha))
    throw new Error(`pull request #${pr.number} reported no head commit`);
  return { repo: full, sha };
}

export async function resumeJob(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  reason: string,
  opts: ResumeOptions = {},
): Promise<JobResult> {
  const { approvedByPolicy, take = false, correction = false } = opts;
  const fullNote = opts.note?.trim() ? opts.note : undefined;
  const actor = agent.actor;
  const badActor = actorShapeRefusal("resume", actor);
  if (badActor) return badActor;
  if (!reason?.trim()) {
    return refuse(
      "resume",
      "resume needs a reason: what the human approved. A job that came back off a gate with no record of who cleared it is a gate that did not happen.",
    );
  }

  const current = await readJob(env.DB, id);
  if (!current) return refuse("resume", `no job ${id}.`);
  if (current.status !== "blocked") {
    return refuse(
      "resume",
      `${id} is ${current.status}, not blocked. Resume is how a job comes back off a gate; a queued job is claimed and a done or failed one is finished.`,
    );
  }

  // A plain resume is a record that the seat approved the gate, and a driver approving a gate, its
  // own or a sibling's, is no approval. `take` does not change that, so a driver passing take is
  // refused the same way.
  const isSeat = callerIsSeat(agent);
  if (approvedByPolicy === undefined && !isSeat) {
    const own = current.claimed_by === actor;
    return refuse(
      "resume",
      `${actor} ${own ? `blocked ${id} and cannot approve its own gate` : `cannot approve ${id}'s gate`} with a plain resume: that is the seat's act. ` +
        `The seat (admin or can_merge) resumes it once the command is approved, ` +
        `or, for a branch push or a pull request only, the driver that blocked it resumes with approved_by_policy. It stays blocked.`,
    );
  }

  // The claimant the claim goes to. A blocked row with no claimant (none should exist, since block
  // keys on claimed_by) goes to the caller.
  const holder = take || !current.claimed_by ? actor : current.claimed_by;

  const { toQueue } = await resumeDestination(env, holder, current, take);
  const acquiring = !toQueue && holder === actor;

  // A resume that acquires the job is a claim, so it asks a claim's scope question. A job going back
  // to its own claimant passed these at its claim.
  const corrupt = corruptRequirement(current);
  if (corrupt) {
    return refuse(
      "resume",
      `${id} has a corrupt requirement: ${corrupt}. It stays blocked; a requirement that cannot be read is not the same as none.`,
    );
  }
  // The namespace is asked either way. A resume that returns the job to its own claimant still moves
  // a job, so a caller that cannot write the job's namespace may not do it; only the job's flags are
  // left to the claimant it goes back to.
  const outside = outsideJobNamespace(agent, current.namespace);
  if (outside) {
    return refuse(
      "resume",
      `${actor} cannot resume ${id} ('${current.title}'): ${outside} It stays blocked.`,
    );
  }
  if (acquiring) {
    const missing = missingForJob(agent, current.namespace, current.required_scopes);
    if (missing) {
      return refuse(
        "resume",
        `${actor} cannot resume ${id} ('${current.title}'): ${missing} It stays blocked for a driver that can finish it.`,
      );
    }
    const resumeShortfall = await recordShortfall(env.DB, actor, current);
    if (resumeShortfall) {
      return refuse(
        "resume",
        `${actor} cannot resume ${id} ('${current.title}'): ${resumeShortfall} It stays blocked for a driver that can finish it.`,
      );
    }
  }

  // The retry cap, checked before anything is spent. A job sent back twice already is one where each
  // further correction has stopped being progress, and what to do next belongs to a person. An admin
  // is that person arriving, so an admin resume passes and does not spend the budget.
  const spentOnWork = await correctionsForWork(env.DB, current.namespace, current.title);
  if (!agent.admin && atCorrectionCap(spentOnWork)) {
    return refuse(
      "resume",
      `the work titled '${current.title}' has been corrected ${spentOnWork} times across every job posted for it, which is the cap of ${CORRECTION_CAP}: ${RETRY_CAP_REASON}. ` +
        `The count is per (namespace, title) rather than per row, so failing this job and posting it again does not reset it. ` +
        `Every resume so far was defensible on its own, which is why the ceiling is counted rather than argued. ` +
        `An admin caller may resume it; a driver or the seat may not.`,
    );
  }

  const verdict = await verifySignedBody(env.IMPROVE_SCORE_SECRET, current.body, "job body");
  if (!verdict.ok) {
    const marked = await markJobFailed(
      env,
      current,
      "blocked",
      verdict.reason,
      "job-signature-refused",
      actor,
      { reason: verdict.reason, at: "resume" },
      now,
    );
    if (!marked.failed)
      return movedBeforeFailing("resume", id, marked.current, "failed its signature check");
    return refuse(
      "resume",
      `${id} failed its signature check and has been marked failed: ${verdict.reason}`,
    );
  }

  let policyMatch: { klass: string; detail: string; version: string } | null = null;
  if (approvedByPolicy !== undefined) {
    // Approving on policy is the seat's act: `resume` takes the write grant every driver holds, so
    // without this a driver could approve its own blocked command. the never list still runs first.
    if (!isSeat && (current.claimed_by !== actor || take)) {
      return refuse(
        "resume",
        `${id} cannot be approved by ${agent.actor} on the gate policy alone. A driver may approve only a job it blocked itself, ` +
          `and ${id} was blocked by ${current.claimed_by ?? "nobody on record"}. Approving somebody else's blocked command is the seat's act, ` +
          `and this caller holds neither the admin identity nor can_merge.`,
      );
    }
    const command = commandFromSummary(current.result_summary);
    // The driver's narrower list is checked first, so a driver's migration is refused without a repo
    // read on its behalf.
    if (!isSeat && command) {
      const match = classifyCommand(command);
      const beyond =
        "klasses" in match ? match.klasses.filter((k) => !DRIVER_SELF_APPROVED.includes(k)) : [];
      if (beyond.length > 0) {
        return refuse(
          "resume",
          `${id} is not pre-approved for a driver: it matched ${beyond.join(", ")}, which a driver may not approve for itself. ` +
            `A driver approves only ${DRIVER_SELF_APPROVED.join(" and ")}. It stays blocked for the human.`,
        );
      }
    }
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
    // The approved verdict is the one that counts, so the driver's list is asserted on it too.
    // Unreachable unless the two classifications disagree, which is the case this line exists for.
    if (!isSeat && verdict.klasses.some((k) => !DRIVER_SELF_APPROVED.includes(k))) {
      return refuse(
        "resume",
        `${id} is not pre-approved for a driver: it matched ${verdict.klass}. It stays blocked for the human.`,
      );
    }
    policyMatch = { klass: verdict.klass, detail: verdict.detail, version: verdict.policyVersion };
  }

  // Only a correction spends the budget, never an admin's. The 0 or 1 is bound, not interpolated, so
  // the statement stays one static string for the source guards and the query-plan test. claimed_at
  // is not touched, so duration spans the whole working life.
  const spend = correction && !agent.admin ? 1 : 0;
  const job: JobRow = {
    ...current,
    status: toQueue ? "queued" : "claimed",
    claimed_by: toQueue ? null : holder,
    resumed_count: current.resumed_count + 1,
    corrections_count: current.corrections_count + spend,
    updated_at: now.toISOString(),
  };
  // Signed with the job body's key, over the approval, the full note and who gave it, bound to this
  // job (src/job-signing.ts); latestResumeNote checks it on every read.
  const noteSig = await signJobText(
    env.IMPROVE_SCORE_SECRET,
    "resume-note",
    id,
    resumeNoteFields(reason, fullNote ?? null, actor),
  );
  const resumeNote: ResumeNote = {
    reason,
    ...(fullNote ? { note: fullNote } : {}),
    by: actor,
    at: now.toISOString(),
    ...(policyMatch
      ? { approved_by_policy: policyMatch.version, policy_class: policyMatch.klass }
      : {}),
    ...(spend ? { correction: true as const } : {}),
    signature: noteSig ? "verified" : "unconfigured",
  };
  // an approval clears the gate, on the signed policy or by the seat (admin or can_merge). The note,
  // when there is one, is a row of its own, so a count of approvals is not a count of notes.
  const touchKind = correction ? "correction" : policyMatch || isSeat ? "approval" : "resume";
  const touchActorKind = actorKind(actor, {
    policy: policyMatch !== null && !isSeat,
    seat: isSeat,
  });
  const touches = [
    touchStatement(env.DB, {
      job_id: id,
      namespace: current.namespace,
      kind: touchKind,
      actor,
      actor_kind: touchActorKind,
      detail: {
        reason,
        command: commandFromSummary(current.result_summary),
        ...(policyMatch
          ? { approved_by_policy: policyMatch.version, policy_class: policyMatch.klass }
          : {}),
        ...(take ? { taken: true } : {}),
        ...(toQueue ? { returned_to: "queued" } : {}),
      },
      sinceGate: true,
      at: now.toISOString(),
    }),
    ...(fullNote
      ? [
          touchStatement(env.DB, {
            job_id: id,
            namespace: current.namespace,
            kind: "note",
            actor,
            actor_kind: touchActorKind,
            detail: { note: fullNote },
            sinceGate: false,
            at: now.toISOString(),
          }),
        ]
      : []),
  ];
  const won = await guardedTransition(env, current, [
    env.DB.prepare(
      `UPDATE jobs SET status = ?5, claimed_by = ?2,
         resumed_count = resumed_count + 1, corrections_count = corrections_count + ?4, updated_at = ?3
       WHERE id = ?1 AND status = 'blocked' RETURNING id`,
    ).bind(id, job.claimed_by, now.toISOString(), spend, job.status),
    ...(await mirrorStatements(env, job, "job-resumed", actor, resumeNote)),
    jobAudit(env.DB, actor, "job-resumed", job, {
      approved: reason,
      ...(fullNote ? { note: fullNote } : {}),
      ...(noteSig ? { sig: noteSig } : {}),
      held_by: job.claimed_by,
      ...(toQueue ? { returned_to: "queued", previous_holder: holder } : {}),
      ...(take ? { taken: true } : {}),
      ...(spend ? { correction: true } : {}),
      resumed_count: job.resumed_count,
      corrections_count: job.corrections_count,
      ...(agent.admin ? { cap_lifted_by_admin: true } : {}),
      // Which class matched, not merely that one did. A row saying "approved by policy" cannot be
      // checked against the policy afterwards; one naming the class and what it matched can.
      ...(policyMatch
        ? {
            approved_by_policy: policyMatch.version,
            policy_class: policyMatch.klass,
            policy_detail: policyMatch.detail,
          }
        : {}),
    }),
    ...touches,
  ]);
  if (!won) {
    return refuse(
      "resume",
      `${id} left blocked between reading it and resuming it. Nothing was written; ask again.`,
    );
  }
  return {
    ok: true,
    action: "resume",
    job,
    resume_note: resumeNote,
    ...(toQueue ? { note: toQueue } : {}),
  };
}
