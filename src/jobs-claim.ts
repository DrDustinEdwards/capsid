import type { Env } from "./env";
import type { Agent } from "./agents";
import { DEFAULT_MAX_CLAIMS, claimLimit } from "./agents-schema";
import {
  JOBS_ROWS_MAX,
  OPEN_JOB_STATUSES,
  corruptRequirement,
  missingForJob,
  mintJobId,
  parseRequiredScopes,
  serializeMinRecord,
  swallowedParamTag,
  swallowedTagRefusal,
  serializeRequiredScopes,
  type JobRow,
  type JobStatus,
  type MinRecord,
  type RequiredScopes,
} from "./jobs-schema";
import { signTaskBody, verifySignedBody } from "./improve-task";
import { JOB_KINDS, isJobKind, routeJob, type Routing } from "./model-routing";
import { pullRequestRisk } from "./model-routing-pr";
import { jobAudit, mirrorStatements, resumeNotes } from "./jobs-mirror";
import { offerForClaim } from "./job-skill-offers";
import { breakerRefusal, breakerState } from "./job-breaker";
import { externalFenceProblem, jobOrigin } from "./provenance";
import {
  actorShapeRefusal,
  claimRoom,
  claimRoomClause,
  guardedTransition,
  heldClaims,
  type ClaimRoom,
  leaseUntil,
  markJobFailed,
  movedBeforeFailing,
  readJob,
  recordShortfall,
  refuse,
  type JobResult,
} from "./jobs-transition";

// Getting work into and out of the queue: post, list and claim.

// The body is signed at post, with the same key and envelope as the improve loop's
// task documents (src/improve-task.ts). The driver refuses a job whose body does not
// verify, so a row edited by a raw D1 splice, or a document mirrored back over by
// hand, cannot steer a session that holds local shell and repo credentials.
//
// Unconfigured is a refusal, not a skip. With no IMPROVE_SCORE_SECRET there is no key
// to sign with, and a queue of unsignable jobs would be refused by the driver one at
// a time instead of here.

/** The open statuses in prose, derived rather than retyped, so a status added to
 *  OPEN_JOB_STATUSES cannot leave the refusal claiming a shorter list than the index
 *  enforces. */
function openMeans(): string {
  const names = [...OPEN_JOB_STATUSES];
  const last = names.pop();
  return names.length ? `${names.join(", ")} or ${last}` : String(last);
}

/** What a duplicate post collided with. The unique index is the rule and D1's error
 *  names only the constraint, so the row is read back to say which job holds the
 *  title and what state it is in. A blocked holder is the case that matters, because
 *  it is waiting on a human rather than on a driver.
 *
 *  The lookup only shapes the message, never the rule: if the holder finished between
 *  the constraint firing and this read, the refusal still stands. */
async function duplicateRefusal(env: Env, namespace: string, title: string): Promise<string> {
  const placeholders = OPEN_JOB_STATUSES.map((_, i) => `?${i + 3}`).join(", ");
  const holder = await env.DB.prepare(
    `SELECT id, status FROM jobs WHERE namespace = ?1 AND title = ?2 AND status IN (${placeholders}) LIMIT 1`
  )
    .bind(namespace, title, ...OPEN_JOB_STATUSES)
    .first<{ id: string; status: string }>()
    .catch(() => null);
  const named = holder ? `: ${holder.id} is ${holder.status}` : "";
  const waiting = holder?.status === "blocked" ? " That one is blocked, which means somebody is already waiting on it." : "";
  return `${namespace} already has an open job titled '${title}'${named}. Finish or fail that one first, or post this under a different title. Open means ${openMeans()}.${waiting}`;
}

/** The body checks and the signature, shared by post and edit so an edited body is
 *  refused for what post refuses and signed exactly as post signs it. Returns the
 *  stored (signed) text, or the problem to refuse with. */
export async function signedJobBody(env: Env, body: string): Promise<{ ok: true; signed: string } | { ok: false; problem: string }> {
  if (!env.IMPROVE_SCORE_SECRET) {
    return {
      ok: false,
      problem:
        "job signing is not configured on this Worker (IMPROVE_SCORE_SECRET is unset), so this job could not be signed and no driver would execute it. Refusing rather than queueing work nothing can verify.",
    };
  }
  if (!body.trim()) return { ok: false, problem: "a job needs a body. The body is the prompt the driver executes." };
  // A body is the prompt a driver executes, so a malformed post is worse here than
  // anywhere else: the swallowed text is signed along with everything else and the
  // driver runs whatever survived.
  const swallowed = swallowedParamTag(body);
  if (swallowed) return { ok: false, problem: swallowedTagRefusal("body", swallowed) };
  // An external fence is how relayed text is told from instruction (src/provenance.ts), so
  // a body whose fence is unlabelled or never closes is refused rather than signed.
  const fenceProblem = externalFenceProblem(body);
  if (fenceProblem) return { ok: false, problem: `the body has a malformed external fence: ${fenceProblem}. Nothing was written.` };
  return { ok: true, signed: await signTaskBody(env.IMPROVE_SCORE_SECRET, body) };
}

export async function postJob(
  env: Env,
  agent: Agent,
  now: Date,
  args: {
    namespace: string;
    title: string;
    body: string;
    priority?: number;
    gate_required?: boolean;
    required_scopes?: Partial<RequiredScopes>;
    min_record?: MinRecord;
    review_required?: boolean;
    // Optional: when absent Capsid reads it from the title and the poster (src/model-routing.ts).
    kind?: string;
  }
): Promise<JobResult> {
  const actor = agent.actor;
  const title = args.title.trim();
  if (!title) return refuse("post", "a job needs a title: it is how the queue refuses a duplicate while one is still open.");
  const signedBody = await signedJobBody(env, args.body);
  if (!signedBody.ok) return refuse("post", signedBody.problem);
  // A registered namespace, as write requires for a document. Otherwise a caller
  // scoped to * could post into a namespace that does not exist, and the mirror
  // document would land where write refuses the same path.
  const registered = await env.DB.prepare("SELECT namespace FROM namespaces WHERE namespace = ?1").bind(args.namespace).first();
  if (!registered) {
    return refuse(
      "post",
      `unknown namespace '${args.namespace}'. Nothing was written. A job and its mirror document live in a registered namespace; check the spelling against the namespaces tool, or create it with register_namespace.`
    );
  }

  if (args.kind !== undefined && !isJobKind(args.kind)) {
    return refuse("post", `'${args.kind}' is not a job kind. One of: ${JOB_KINDS.join(", ")}, or leave it out and Capsid reads it from the title.`);
  }
  // The model is assigned here, by the Worker, from the kind and the risk the job states
  // about itself. Nobody types it.
  const routing = routeJob({
    title,
    body: args.body,
    namespace: args.namespace,
    posted_by: actor,
    kind: args.kind,
    required_flags: args.required_scopes?.flags,
    gate_required: args.gate_required,
  });

  const job: JobRow = {
    id: mintJobId(),
    namespace: args.namespace,
    title,
    body: signedBody.signed,
    priority: args.priority ?? 0,
    status: "queued",
    posted_by: actor,
    claimed_by: null,
    claimed_at: null,
    lease_expires: null,
    result_ref: null,
    result_summary: null,
    gate_required: args.gate_required ? 1 : 0,
    // NULL when nothing was asked for, rather than an empty requirement object. The
    // column means "this job needs something unusual", and empty JSON would read as a
    // requirement nobody can see.
    required_scopes: args.required_scopes?.flags?.length ? serializeRequiredScopes(args.required_scopes) : null,
    // A bar of zero is no bar, so it is stored as NULL rather than as a requirement
    // every agent trivially meets.
    min_record: args.min_record?.prs_merged ? serializeMinRecord(args.min_record) : null,
    blocked_count: 0,
    resumed_count: 0,
    corrections_count: 0,
    review_required: args.review_required ? 1 : 0,
    kind: routing.kind,
    model_recommended: routing.model,
    effort_recommended: routing.effort,
    routing_reason: routing.reason,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  const statements = [
    env.DB.prepare(
      `INSERT INTO jobs (id, namespace, title, body, priority, status, posted_by, gate_required, required_scopes, min_record, review_required, created_at, updated_at,
         kind, model_recommended, effort_recommended, routing_reason)
       VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12, ?13, ?14, ?15)`
    ).bind(
      job.id,
      job.namespace,
      job.title,
      job.body,
      job.priority,
      job.posted_by,
      job.gate_required,
      job.required_scopes,
      job.min_record,
      job.review_required,
      job.created_at,
      routing.kind,
      routing.model,
      routing.effort,
      routing.reason
    ),
    ...(await mirrorStatements(env, job, "job-posted", actor)),
    jobAudit(env.DB, actor, "job-posted", job, {
      origin: jobOrigin(actor),
      title: job.title,
      priority: job.priority,
      gate_required: job.gate_required,
      ...(job.required_scopes ? { required_scopes: job.required_scopes } : {}),
      ...(job.min_record ? { min_record: job.min_record } : {}),
      ...(job.review_required ? { review_required: true } : {}),
      model_recommended: routing.model,
      effort_recommended: routing.effort,
      kind: routing.kind,
    }),
  ];
  try {
    await env.DB.batch(statements);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The partial unique index over (namespace, title) for open statuses, reported as
    // what it means rather than as the constraint's own text.
    if (/UNIQUE/i.test(message)) {
      return refuse("post", await duplicateRefusal(env, args.namespace, title));
    }
    throw err;
  }
  return { ok: true, action: "post", job };
}

// List never carries a body unless one job was asked for by a writer. A body is the
// signed prompt a driver executes with shell and repo credentials, and a list that
// selected every column would let a read grant on a namespace read every prompt queued
// in it. The columns are named so the body never leaves D1 for a list. claim returns
// it, and so does list when `withBody` is set, which the tool sets only for a single
// named id and a caller holding write.
const JOB_LIST_COLUMNS = [
  "id",
  "namespace",
  "title",
  "status",
  "priority",
  "posted_by",
  "claimed_by",
  "lease_expires",
  "gate_required",
  "review_required",
  "blocked_count",
  "resumed_count",
  "created_at",
  "updated_at",
  "result_summary",
  "kind",
  "model_recommended",
  "effort_recommended",
] as const;

export type JobListRow = Pick<JobRow, (typeof JOB_LIST_COLUMNS)[number]>;

export async function listJobs(
  env: Env,
  args: { namespace?: string; status?: JobStatus; id?: string },
  opts: { withBody?: boolean } = {}
): Promise<JobResult> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const withBody = opts.withBody === true && Boolean(args.id);
  if (args.id) {
    binds.push(args.id);
    where.push(`id = ?${binds.length}`);
  }
  if (args.namespace) {
    binds.push(args.namespace);
    where.push(`namespace = ?${binds.length}`);
  }
  if (args.status) {
    binds.push(args.status);
    where.push(`status = ?${binds.length}`);
  }
  binds.push(JOBS_ROWS_MAX + 1);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(
    `SELECT ${[...JOB_LIST_COLUMNS, ...(withBody ? ["body"] : [])].join(", ")} FROM jobs ${clause} ORDER BY priority DESC, created_at ASC LIMIT ?${binds.length}`
  )
    .bind(...binds)
    .all<JobListRow>();
  const rows = results ?? [];
  // One extra row asked for, so "exactly the page" is distinguishable from "there are
  // more". Same shape as every other bounded read here.
  const truncated = rows.length > JOBS_ROWS_MAX;
  // One named job carries its latest resume note. Not every row of a wide list, which
  // would cost one read per resumed job.
  const listNotes = args.id && rows.length === 1 ? await resumeNotes(env, rows[0]) : null;
  const listNote = listNotes?.notes[0] ?? null;
  return {
    ok: true,
    action: "list",
    ...(listNote ? { resume_note: listNote } : {}),
    ...(listNotes && listNotes.notes.length > 0 ? { resume_notes: listNotes.notes } : {}),
    ...(listNotes && listNotes.dropped > 0 ? { resume_notes_dropped: listNotes.dropped } : {}),
    jobs: truncated ? rows.slice(0, JOBS_ROWS_MAX) : rows,
    ...(truncated ? { truncated: true, note: `more than ${JOBS_ROWS_MAX} jobs match; narrow by namespace or status.` } : {}),
  };
}

/** The claim's refusal for a ClaimRoom. At the default limit of one it reads as it always
 *  has: "<actor> already holds <job>, leased until <time>". */
function claimRefusal(actor: string, room: ClaimRoom, id: string): string {
  if (room.kind === "full") {
    const clause = claimRoomClause(actor, room, id, { lease: true }).replace(`${actor} holds `, `${actor} already holds `);
    return room.limit === DEFAULT_MAX_CLAIMS
      ? `${clause}. Complete it, fail it, or block it before claiming another.`
      : `${clause}. Complete, fail or block one before claiming another.`;
  }
  return `${claimRoomClause(actor, room, id)}. ${id} stays queued.`;
}

/** What a claim hands the driver about the model (capsid/conventions.md, "Model routing"): the
 *  recommendation, why, and how to follow it. The driver never picks a model itself. */
function deliveryOf(routing: Routing) {
  return {
    model: routing.model,
    effort: routing.effort,
    kind: routing.kind,
    risk: routing.risk,
    reason: routing.reason,
    rules_version: routing.rules_version,
    deliver:
      `A scheduled or cloud launch starts on --model ${routing.model}. An interactive driver keeps its own session for coordination and does the job's work in a subagent on model ${routing.model} (the Agent tool's model parameter), at effort ${routing.effort}.`,
  };
}

// Claims per caller, across every namespace, up to the caller's claim limit (one unless
// the admin raised it with the agents tool's max_claims). Each held job keeps its own
// lease, and every holder action names the job it acts on. A claim past the limit, or a
// second claim on the repo of a job already held (unless one of the two is a design
// job), is refused before the CAS, so the refusal names the job already held rather
// than reporting a lost race.
export async function claimJob(
  env: Env,
  agent: Agent,
  now: Date,
  args: { namespace?: string; id?: string }
): Promise<JobResult> {
  const actor = agent.actor;
  const badActor = actorShapeRefusal("claim", actor);
  if (badActor) return badActor;
  const limit = claimLimit(agent.scopes);
  const held = await heldClaims(env.DB, actor);
  if (held.length >= limit) return refuse("claim", claimRefusal(actor, { kind: "full", held, limit }, args.id ?? "another job"));

  // Either a named job or the highest-priority queued one in a namespace. The SELECT
  // only picks a candidate; the guarded UPDATE below is what claims it, so two drivers
  // reading the same candidate still resolve to one winner.
  let candidate: JobRow | null = null;
  if (args.id) {
    candidate = await readJob(env.DB, args.id);
    if (!candidate) return refuse("claim", `no job ${args.id}.`);
    if (candidate.status !== "queued") {
      return refuse("claim", `${args.id} is ${candidate.status}, not queued${candidate.claimed_by ? ` (held by ${candidate.claimed_by})` : ""}.`);
    }
  } else {
    if (!args.namespace) return refuse("claim", "claim needs a namespace to pick from, or an id to claim.");
    candidate = await env.DB.prepare(
      "SELECT * FROM jobs WHERE namespace = ?1 AND status = 'queued' ORDER BY priority DESC, created_at ASC LIMIT 1"
    )
      .bind(args.namespace)
      .first<JobRow>();
    if (!candidate) return refuse("claim", `no queued jobs in ${args.namespace}.`);
  }

  // The repo question, now that the job is known: a second claim on the repo of a job
  // already held is refused and leaves the queue as it was.
  const room = await claimRoom(env, limit, held, candidate);
  if (room) return refuse("claim", claimRefusal(actor, room, candidate.id));

  // A namespace whose drivers keep failing stops handing out work until a person looks
  // (src/job-breaker.ts). Checked before anything else touches the candidate, so an
  // open breaker leaves the queue exactly as it was.
  const breaker = await breakerState(env, candidate.namespace, now);
  if (breaker.open) return refuse("claim", `${actor} cannot claim ${candidate.id}: ${breakerRefusal(breaker)}`);

  // What the job needs of the driver is checked before the lease is taken. A claim
  // that took the lease and then refused would park the job on a driver that cannot do
  // it, and since a caller holds a limited number of claims it would also take one of
  // that driver's places for four hours. The check runs through checkScope, so a job
  // requirement and an agent scope are compared by the same function that decides
  // every tool call.
  //
  // A requirement that cannot be read fails the job, as a bad signature does below:
  // left queued, the same row would be refused to every driver in turn, and a claim
  // with no id takes the top queued job, so it would stop the namespace's queue.
  const corrupt = corruptRequirement(candidate);
  if (corrupt) {
    const reason = `${candidate.id} has a corrupt requirement: ${corrupt}. A requirement that cannot be read is not the same as none, so it was not leased.`;
    const marked = await markJobFailed(env, candidate, "queued", reason, "job-requirement-corrupt", actor, { reason: corrupt }, now);
    if (!marked.failed) return movedBeforeFailing("claim", candidate.id, marked.current, "has a corrupt requirement");
    return refuse("claim", `${reason} It has been marked failed.`);
  }

  const missing = missingForJob(agent, candidate.namespace, candidate.required_scopes);
  if (missing) {
    return refuse(
      "claim",
      `${actor} cannot claim ${candidate.id} ('${candidate.title}'): ${missing} The job stays queued for a driver that can do it.`
    );
  }

  // What it needs of the driver's history, on the same terms and in the same place:
  // before the lease, so the job stays queued for a driver that meets the bar.
  const shortfall = await recordShortfall(env.DB, actor, candidate);
  if (shortfall) {
    return refuse("claim", `${actor} cannot claim ${candidate.id} ('${candidate.title}'): ${shortfall} The job stays queued for a driver that can do it.`);
  }

  // The signature is checked before the job is handed over, not by the driver after
  // it has one. A job body is executable input that arrives as a database row, and the
  // driver is a session holding local shell and repo credentials.
  //
  // A body that does not verify was edited after `post` signed it. That job is failed
  // here rather than left queued: leaving it would hand the same broken row to every
  // driver in turn, and the queue would never drain.
  //
  // Unlike a run document (verifyTaskDoc) there is no actor check. Only the loop writes
  // a run document, so its audit actor is the loop; a job is posted by a human seat,
  // and this Worker's signature is what proves it went through `post`.
  const verdict = await verifySignedBody(env.IMPROVE_SCORE_SECRET, candidate.body, "job body");
  if (!verdict.ok) {
    const marked = await markJobFailed(env, candidate, "queued", verdict.reason, "job-signature-refused", actor, { reason: verdict.reason }, now);
    if (!marked.failed) return movedBeforeFailing("claim", candidate.id, marked.current, "failed its signature check");
    return refuse("claim", `${candidate.id} failed its signature check and has been marked failed: ${verdict.reason}`);
  }

  // The approval a resume handed on is checked the same way, before the lease: a note
  // changed after the resume wrote it is an instruction nobody gave, so the job is
  // failed rather than handed to a driver with it (src/job-signing.ts).
  const claimNotes = await resumeNotes(env, candidate);
  const claimNote = claimNotes.notes[0] ?? null;
  if (claimNote?.signature === "mismatch") {
    const reason = `its last resume note's signature does not match: the approval was changed after ${claimNote.by} wrote it at ${claimNote.at}.`;
    const marked = await markJobFailed(env, candidate, "queued", reason, "job-resume-note-refused", actor, { reason }, now);
    if (!marked.failed) return movedBeforeFailing("claim", candidate.id, marked.current, "carries a resume note that failed its signature check");
    return refuse("claim", `${candidate.id} was not handed out and has been marked failed: ${reason}`);
  }

  // The model for this job, assigned at post and settled again here: a job posted before
  // routing existed is routed now, and a job that already carries a pull request is read
  // on that PR's files, which can only raise the risk (src/model-routing.ts riskOf).
  const required = parseRequiredScopes(candidate.required_scopes);
  const prRisk = await pullRequestRisk(env, candidate.namespace, candidate.result_ref);
  const routing = routeJob({
    title: candidate.title,
    body: candidate.body,
    namespace: candidate.namespace,
    posted_by: candidate.posted_by,
    kind: candidate.kind,
    required_flags: required.ok ? required.value.flags : [],
    gate_required: candidate.gate_required === 1,
    pr_risk: prRisk.risk,
  });

  const expires = leaseUntil(now);
  const claimed: JobRow = {
    ...candidate,
    kind: routing.kind,
    model_recommended: routing.model,
    effort_recommended: routing.effort,
    routing_reason: routing.reason,
    status: "claimed",
    claimed_by: actor,
    // A job the seat released keeps its first claim time, so its duration covers its
    // whole working life. The lease sweep clears claimed_at, so a swept job starts over.
    claimed_at: candidate.claimed_at ?? now.toISOString(),
    lease_expires: expires,
    updated_at: now.toISOString(),
  };
  // The skills this job is offered: decided at its first claim and recorded in the
  // same batch, or read back from that record on a later claim.
  const offer = await offerForClaim(env, claimed, actor);
  // One batch with its records, behind the guard. Two drivers reading the same
  // candidate still resolve to one winner, because the first commit moves updated_at
  // and the second batch's guard aborts before its UPDATE runs.
  const won = await guardedTransition(env, candidate, [
    env.DB.prepare(
      `UPDATE jobs SET status = 'claimed', claimed_by = ?2, claimed_at = COALESCE(claimed_at, ?3), lease_expires = ?4, updated_at = ?3,
         kind = ?5, model_recommended = ?6, effort_recommended = ?7, routing_reason = ?8
       WHERE id = ?1 AND status = 'queued' RETURNING id`
    ).bind(candidate.id, actor, now.toISOString(), expires, routing.kind, routing.model, routing.effort, routing.reason),
    ...(await mirrorStatements(env, claimed, "job-claimed", actor)),
    jobAudit(env.DB, actor, "job-claimed", claimed, { lease_expires: expires }),
    ...(offer.record ? [offer.record] : []),
  ]);
  if (!won) {
    return refuse("claim", `${candidate.id} was claimed by someone else between reading it and taking it. Ask again.`);
  }
  // A job that went back to the queue after a resume (an expired lease) reaches its
  // next driver here, so the approval has to come with it: the note read and checked
  // above, before the lease.
  return {
    ok: true,
    action: "claim",
    job: claimed,
    ...(claimNote ? { resume_note: claimNote } : {}),
    ...(claimNotes.notes.length > 0 ? { resume_notes: claimNotes.notes } : {}),
    ...(claimNotes.dropped > 0 ? { resume_notes_dropped: claimNotes.dropped } : {}),
    offered_skills: offer.skills,
    routing: deliveryOf(routing),
    ...(prRisk.note ? { routing_note: prRisk.note } : {}),
  };
}
