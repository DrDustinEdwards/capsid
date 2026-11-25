import type { Env } from "./env";
import type { Agent } from "./agents";
import {
  missingForJob,
  outsideJobNamespace,
  swallowedParamTag,
  swallowedTagRefusal,
  type JobRow,
} from "./jobs-schema";
import { parsePrUrl } from "@dustinedwards/site-runtime/github";
import { ghFetch, resolveRepo } from "./github/client";
import { outcomeFrom, outcomeStatement, verifyEvidence } from "./job-outcomes";
import { jobAudit, mirrorStatements } from "./jobs-mirror";
import { completeAsSeat, completeJob, completeWithoutClaim, recordAsSeat } from "./jobs-holder";
import { failJob } from "./jobs-holder-block";
import { actorKind, touchStatement } from "./job-touches";
import type { ClaimInput, ClaimRaw } from "./job-claims";
import { readReproReceipt } from "./bench-run-key";
import {
  callerIsSeat,
  guardedTransition,
  readJob,
  recordShortfall,
  refuse,
  type JobResult,
} from "./jobs-transition";

type PrUrl = NonNullable<ReturnType<typeof parsePrUrl>>;

// The seat only (callerIsSeat): no driver holds can_merge, so a driver still cannot fail another
// driver's job. A finished job is refused, not rewritten.
export async function adminFailJob(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  reason: string,
  opts: { extra?: D1PreparedStatement[]; outcome?: boolean } = {},
): Promise<JobResult> {
  if (!callerIsSeat(agent)) {
    return refuse(
      "admin-fail",
      `${agent.actor} may only fail a job it holds. Failing somebody else's job is the seat's act, and this caller holds neither the admin identity nor can_merge.`,
    );
  }
  if (!reason?.trim())
    return refuse(
      "admin-fail",
      "fail needs a reason. A failed job with no reason is one nobody can retry or rule on.",
    );
  const current = await readJob(env.DB, id);
  if (!current) return refuse("admin-fail", `no job ${id}.`);
  // The job's own namespace, since a seat key may be scoped narrower than the admin.
  const outside = outsideJobNamespace(agent, current.namespace);
  if (outside)
    return refuse(
      "admin-fail",
      `${agent.actor} cannot fail ${id} ('${current.title}'): ${outside}`,
    );
  if (current.status !== "queued" && current.status !== "claimed" && current.status !== "blocked") {
    return refuse("admin-fail", `${id} is already ${current.status}; there is nothing to fail.`);
  }
  const job: JobRow = {
    ...current,
    status: "failed",
    result_summary: reason,
    updated_at: now.toISOString(),
  };
  const statements = [
    env.DB.prepare(
      `UPDATE jobs SET status = 'failed', result_summary = ?3, summary_sig = NULL, updated_at = ?2
       WHERE id = ?1 AND status IN ('queued', 'claimed', 'blocked') RETURNING id`,
    ).bind(id, now.toISOString(), reason),
    ...(await mirrorStatements(env, job, "job-admin-fail", agent.actor)),
    jobAudit(env.DB, agent.actor, "job-admin-fail", job, {
      status: job.status,
      reason,
      held_by: job.claimed_by,
    }),
    touchStatement(env.DB, {
      job_id: id,
      namespace: job.namespace,
      kind: "admin_fail",
      actor: agent.actor,
      actor_kind: actorKind(agent.actor, { seat: true }),
      detail: { reason, from: current.status, held_by: current.claimed_by },
      sinceGate: current.status === "blocked",
      at: now.toISOString(),
    }),
  ];
  // An outcome row, as `fail` writes one, but only when somebody held the job: a queued job the seat
  // canceled was never worked, so no agent is blamed and no evidence is given.
  if (job.claimed_by && opts.outcome !== false) {
    const verdict = await verifyEvidence(env, job.namespace, undefined);
    statements.push(outcomeStatement(env.DB, outcomeFrom(job, verdict, now)));
  }
  if (!(await guardedTransition(env, current, [...statements, ...(opts.extra ?? [])]))) {
    const moved = await readJob(env.DB, id);
    return refuse(
      "admin-fail",
      `${id} changed between reading it and failing it: it is now ${moved?.status ?? "gone"}${moved?.claimed_by ? `, held by ${moved.claimed_by}` : ""}. Nothing was written; look again before failing it.`,
    );
  }
  return { ok: true, action: "admin-fail", job };
}

// The seat failing a job somebody else holds, or nobody holds, is adminFailJob; the holder failing
// its own is an ordinary fail. The seat made no claim about that work, so the claim goes to the
// holder path only.
export async function failAsCaller(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  reason: string,
  said: { claim?: ClaimInput; raw?: ClaimRaw } = {},
): Promise<JobResult> {
  const current = await readJob(env.DB, id);
  if (current && current.claimed_by !== agent.actor && callerIsSeat(agent)) {
    // A claim is the holder's account of its own work. The seat failing a job it does not hold has
    // none to give, and one sent anyway is refused rather than dropped, so nobody reads a silence as a
    // recorded claim.
    const sent =
      typeof said.claim === "string" ? said.claim.trim() !== "" : said.claim !== undefined;
    if (sent) {
      return refuse(
        "fail",
        `${id} is held by ${current.claimed_by ?? "nobody"}, so this is the seat's fail and takes no claim: a claim is the holder's account of its own work. Send it without claim.`,
      );
    }
    return adminFailJob(env, agent, now, id, reason);
  }
  return failJob(env, agent, now, id, reason, said);
}

// The close is a human touch (kind admin_complete, migrations/0031), so the human-effort log shows
// the job needed the seat.
async function adminCompleteJob(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  args: Parameters<typeof completeJob>[4],
): Promise<JobResult> {
  if (!callerIsSeat(agent)) {
    return refuse(
      "complete",
      `${agent.actor} may only complete a job it holds. Completing somebody else's blocked job is the seat's act, and this caller holds neither the admin identity nor can_merge.`,
    );
  }
  const current = await readJob(env.DB, id);
  if (!current) return refuse("complete", `no job ${id}.`);
  // The job's own namespace, since a seat key may be scoped narrower than the admin.
  const outside = outsideJobNamespace(agent, current.namespace);
  if (outside)
    return refuse(
      "complete",
      `${agent.actor} cannot complete ${id} ('${current.title}'): ${outside}`,
    );
  return completeAsSeat(env, agent, now, id, args);
}

// record through the work queue tool: the seat writing the outcome of work done on a queued job
// without a claim. Seat only, because an outcome credits work and a driver could otherwise record
// work it did not do.
export async function recordAsCaller(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  args: Parameters<typeof completeJob>[4],
): Promise<JobResult> {
  if (!callerIsSeat(agent)) {
    return refuse(
      "record",
      `${agent.actor} may not record an outcome without a claim. That is the seat's act (the admin identity or can_merge); a driver claims the job and completes it.`,
    );
  }
  const current = await readJob(env.DB, id);
  if (!current) return refuse("record", `no job ${id}.`);
  const outside = outsideJobNamespace(agent, current.namespace);
  if (outside)
    return refuse("record", `${agent.actor} cannot record ${id} ('${current.title}'): ${outside}`);
  return recordAsSeat(env, agent, now, id, args);
}

// What a claim would have asked is asked here: required_flags and min_record. At least one named
// pull request must be on one of the namespace's repos, and its body must name this job id
// (auto-merge's body_names_job), or any pull request on a mapped repo would close any queued job.
async function completeUnclaimed(
  env: Env,
  agent: Agent,
  now: Date,
  current: JobRow,
  args: Parameters<typeof completeJob>[4],
): Promise<JobResult> {
  const id = current.id;
  const outside = outsideJobNamespace(agent, current.namespace);
  if (outside)
    return refuse(
      "complete",
      `${agent.actor} cannot complete ${id} ('${current.title}'): ${outside}`,
    );
  const refs = [args.result_ref, ...(args.evidence?.prs ?? [])].filter((ref): ref is string =>
    Boolean(ref),
  );
  const prs = refs
    .map((ref) => ({ ref, pr: parsePrUrl(ref) }))
    .filter((p): p is { ref: string; pr: PrUrl } => p.pr !== null);
  if (prs.length === 0) {
    return refuse(
      "complete",
      `${id} is queued and nobody holds it. A job worked without a claim is completed by naming its pull request (a pull request URL in result_ref or evidence.prs): the pull request is the claim. Nothing was written.`,
    );
  }
  let named = false;
  for (const { ref, pr } of prs) {
    let mapped: { owner: string; repo: string };
    try {
      mapped = await resolveRepo(env, current.namespace, `${pr.owner}/${pr.repo}`);
    } catch {
      return refuse(
        "complete",
        `${ref} is not on a repo mapped to ${current.namespace}, so it is not shown to be ${id}'s work. Nothing was written.`,
      );
    }
    if (!named) named = await prBodyNames(env, mapped.owner, mapped.repo, pr.number, id);
  }
  if (!named) {
    return refuse(
      "complete",
      `none of the named pull requests has ${id} in its description (or GitHub could not be read), so none is shown to be this job's work. Put the job id in the pull request body and complete again. Nothing was written.`,
    );
  }
  const missing = missingForJob(agent, current.namespace, current.required_scopes);
  if (missing)
    return refuse(
      "complete",
      `${agent.actor} cannot complete ${id} ('${current.title}') without a claim: ${missing} A claim would have refused it too. Nothing was written.`,
    );
  const shortfall = await recordShortfall(env.DB, agent.actor, current);
  if (shortfall)
    return refuse(
      "complete",
      `${agent.actor} cannot complete ${id} ('${current.title}') without a claim: ${shortfall} A claim would have refused it too. Nothing was written.`,
    );
  return completeWithoutClaim(env, agent, now, id, args);
}

async function prBodyNames(
  env: Env,
  owner: string,
  repo: string,
  number: number,
  id: string,
): Promise<boolean> {
  try {
    const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls/${number}`);
    if (!resp.ok) return false;
    const body = ((await resp.json()) as { body?: string | null }).body ?? "";
    return new RegExp(`\\b${id}\\b`).test(body);
  } catch {
    return false;
  }
}

// complete through the capsid_work_jobs tool. A queued job nobody holds is completed without a
// claim (completeUnclaimed); the seat completing a job somebody else holds is adminCompleteJob.
// Anyone else gets completeJob's own refusal.
export async function completeAsCaller(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  args: Parameters<typeof completeJob>[4],
): Promise<JobResult> {
  if (!args.result_summary?.trim()) return completeJob(env, agent, now, id, args);
  // Without that receipt, "not done, here's why" is the outcome the job asks for, and fail records
  // it.
  if (agent.benchRun) {
    const receipt = await readReproReceipt(env.DB, agent.benchRun.run);
    const missing = !receipt
      ? "the harness has no check of a reproduction test for this run (name the test with bench-repro before phase one ends)"
      : receipt.passed
        ? null
        : `the harness's check of your reproduction test did not pass: ${receipt.reason}`;
    if (missing) {
      return refuse(
        "complete",
        `${id} was not completed: ${missing}. A bench run completes its job only when the harness saw its test fail on the base and pass on its diff. ` +
          `Call fail with the reason instead; "not done, here's why" is a good outcome.`,
      );
    }
  }
  const current = await readJob(env.DB, id);
  if (current && current.status === "queued" && current.claimed_by === null)
    return completeUnclaimed(env, agent, now, current, args);
  if (current && current.claimed_by !== agent.actor && callerIsSeat(agent))
    return adminCompleteJob(env, agent, now, id, args);
  return completeJob(env, agent, now, id, args);
}

// Release: the seat returning a claimed job to the queue when its holder is gone. A claim has no
// lease and never expires, so without it the job stays held by a dead holder.
export async function releaseJob(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  reason: string,
): Promise<JobResult> {
  if (!callerIsSeat(agent)) {
    return refuse(
      "release",
      `${agent.actor} cannot release a job. Releasing a claim is the seat's act, and this caller holds neither the admin identity nor can_merge.`,
    );
  }
  if (!reason?.trim()) {
    return refuse(
      "release",
      "release needs a reason: why the holder is not coming back. It is recorded in the audit row.",
    );
  }
  const swallowed = swallowedParamTag(reason);
  if (swallowed) return refuse("release", swallowedTagRefusal("reason", swallowed));
  const current = await readJob(env.DB, id);
  if (!current) return refuse("release", `no job ${id}.`);
  const outside = outsideJobNamespace(agent, current.namespace);
  if (outside)
    return refuse(
      "release",
      `${agent.actor} cannot release ${id} ('${current.title}'): ${outside}`,
    );
  if (current.status !== "claimed") {
    return refuse(
      "release",
      `${id} is ${current.status}, not claimed. Release returns a claimed job to the queue; a blocked job is resumed, a queued one is already free, and a finished one is not reopened.`,
    );
  }
  const job: JobRow = {
    ...current,
    status: "queued",
    claimed_by: null,
    updated_at: now.toISOString(),
  };
  const won = await guardedTransition(env, current, [
    env.DB.prepare(
      `UPDATE jobs SET status = 'queued', claimed_by = NULL, updated_at = ?2
       WHERE id = ?1 AND status = 'claimed' AND claimed_by = ?3 RETURNING id`,
    ).bind(id, now.toISOString(), current.claimed_by),
    ...(await mirrorStatements(env, job, "job-released", agent.actor)),
    jobAudit(env.DB, agent.actor, "job-released", job, { reason, held_by: current.claimed_by }),
    touchStatement(env.DB, {
      job_id: id,
      namespace: job.namespace,
      kind: "release",
      actor: agent.actor,
      actor_kind: actorKind(agent.actor, { seat: true }),
      detail: { reason, held_by: current.claimed_by },
      sinceGate: false, // only a claimed job is released, so no gate is open
      at: now.toISOString(),
    }),
  ]);
  if (!won) {
    const moved = await readJob(env.DB, id);
    return refuse(
      "release",
      `${id} changed between reading it and releasing it: it is now ${moved?.status ?? "gone"}${moved?.claimed_by ? `, held by ${moved.claimed_by}` : ""}. Nothing was written.`,
    );
  }
  return { ok: true, action: "release", job };
}
