import type { Env } from "./env";
import { improveDocStatements, priorDoc } from "./improve-state";
import {
  JOB_LEASE_SECONDS,
  JOBS_ROWS_MAX,
  OPEN_JOB_STATUSES,
  jobDocPath,
  corruptRequirement,
  missingForJob,
  outsideJobNamespace,
  mintJobId,
  missingForRecord,
  serializeMinRecord,
  isTerminalJobStatus,
  swallowedParamTag,
  swallowedTagRefusal,
  serializeRequiredScopes,
  type JobRow,
  type JobStatus,
  type MinRecord,
  type RequiredScopes,
  CORRECTION_CAP,
  RETRY_CAP_REASON,
  atCorrectionCap,
  cappedSummary,
} from "./jobs-schema";
import type { Agent } from "./agents";
import { approveByPolicy, classifyCommand, type GateClass } from "./gate-policy";
import { reviewGate, type GateOutcome } from "./review";
import { outcomePrStatements } from "./outcome-prs";
import { auditStatement, isMissingRowAbort, requireJobUnchanged } from "./store-guards";
import { readRepoFile } from "./github/contents";
import { ghFetch, parsePrUrl, resolveRepo, type PrUrl } from "./github/client";
import { signTaskBody, verifySignedBody } from "./improve-task";
import { attributionStatements } from "./skills-records";
import { loadRecordRows, recordFor } from "./agent-record";
import {
  outcomeFrom,
  outcomeStatement,
  signalFor,
  verifyEvidence,
  type JobSkills,
  type JobEvidence,
  type JobOutcomeRow,
} from "./job-outcomes";

// The work queue. The seat posts a job; a driver session claims it, does it, and
// reports back.
//
// Every transition is `UPDATE ... WHERE status = <expected> RETURNING id`, never
// meta.changes: these batches carry a document write, and the FTS5 triggers inflate
// meta.changes. No row back means somebody else got there first. The holder
// transitions put the UPDATE in the same batch as its records, behind
// requireJobUnchanged (src/store-guards.ts), which aborts the batch when the row is
// not in the state the caller read.
//
// The row is the source of truth for status. The mirror document at
// <namespace>/jobs/<id>.md is rewritten in the same batch as every transition.

// claimed_by carries the same shape as audit_log.actor (migrations/0006), so one
// query joins a job to what its driver did. Agent names are unique and never reused,
// so `agent:<name>` identifies one credential.
const ACTOR_SHAPE = /^(github:|opkey:|agent:)/;

function actorShapeRefusal(action: string, actor: string): JobResult | null {
  if (ACTOR_SHAPE.test(actor)) return null;
  return refuse(
    action,
    `'${actor}' is not a caller identity this queue can hold a lease for. A claim is recorded against a github: login, an opkey: fingerprint, or an agent: name.`
  );
}

// The job a caller holds, if any. A caller holds at most one (claimJob).
async function heldClaim(db: D1Database, actor: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE status = 'claimed' AND claimed_by = ?1 LIMIT 1").bind(actor).first<JobRow>();
}

// THE SEAT IS IDENTIFIED BY admin OR can_merge, for supersede and for resume.
function callerIsSeat(agent: Agent): boolean {
  return agent.admin || agent.scopes.flags.can_merge;
}

export interface JobResult {
  ok: boolean;
  action: string;
  job?: JobRow;
  jobs?: Array<JobListRow | JobRow>;
  truncated?: boolean;
  note?: string;
  refusal?: string;
  // The outcome row this transition wrote, so the driver sees what the Worker
  // checked. `notes` names every verification that could not run.
  outcome?: { row: JobOutcomeRow; notes: string[] };
  // The latest resume's reason, for a job resumed at least once.
  resume_note?: ResumeNote;
}

// The reason given at the latest resume, read back from its audit row so the next
// holder sees what was approved. The audit row stays the one record.
export interface ResumeNote {
  reason: string;
  // The seat's full note, when the resume carried one. `reason` is bounded at
  // MAX_TITLE and holds one line; the rulings or plan the seat approved go here and
  // are handed on whole, never truncated.
  note?: string;
  by: string;
  at: string;
  approved_by_policy?: string;
  policy_class?: string;
  correction?: true;
}

// Served by audit_log_doc (namespace, path, id DESC), the index every job audit row
// already falls under because it is written against the job's mirror path.
async function latestResumeNote(
  db: D1Database,
  job: Pick<JobRow, "id" | "namespace" | "resumed_count">
): Promise<ResumeNote | null> {
  if (!job.resumed_count) return null;
  const row = await db
    .prepare(
      "SELECT actor, params, at FROM audit_log WHERE namespace = ?1 AND path = ?2 AND action = 'job-resumed' ORDER BY id DESC LIMIT 1"
    )
    .bind(job.namespace, jobDocPath(job.id))
    .first<{ actor: string | null; params: string | null; at: string }>();
  if (!row?.params) return null;
  let params: Record<string, unknown>;
  try {
    params = JSON.parse(row.params) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof params.approved !== "string") return null;
  return {
    reason: params.approved,
    ...(typeof params.note === "string" ? { note: params.note } : {}),
    by: row.actor ?? "(unknown)",
    at: row.at,
    ...(typeof params.approved_by_policy === "string" ? { approved_by_policy: params.approved_by_policy } : {}),
    ...(typeof params.policy_class === "string" ? { policy_class: params.policy_class } : {}),
    ...(params.correction === true ? { correction: true as const } : {}),
  };
}

function refuse(action: string, refusal: string): JobResult {
  return { ok: false, action, refusal };
}

const leaseUntil = (now: Date) => new Date(now.getTime() + JOB_LEASE_SECONDS * 1000).toISOString();

// The document a job mirrors to. The prompt is the SIGNED body, byte for byte, so a
// driver that reads the document rather than the row still verifies the same bytes.
function renderJobDoc(job: JobRow, note: ResumeNote | null): string {
  const lines = [
    `# ${job.title}`,
    "",
    `Job \`${job.id}\` in \`${job.namespace}\`. This document is a PROJECTION of the jobs`,
    "table, which is the source of truth for status. Rewritten on every transition.",
    "",
    `- status: **${job.status}**`,
    `- priority: ${job.priority}`,
    `- gate required: ${job.gate_required ? "yes" : "no"}`,
    `- posted by: ${job.posted_by}`,
    `- claimed by: ${job.claimed_by ?? "(unclaimed)"}`,
    `- lease expires: ${job.lease_expires ?? "(no lease)"}`,
  ];
  if (job.blocked_count > 0) lines.push(`- gates hit: ${job.blocked_count}, resumed: ${job.resumed_count}`);
  // The brief carries open job documents, so this line is how brief hands the
  // approval to a driver.
  if (note) lines.push(`- last resume, by ${note.by} at ${note.at}: ${note.reason}`);
  if (job.result_summary) lines.push(`- result: ${job.result_summary}`);
  if (job.result_ref) lines.push(`- result ref: ${job.result_ref}`);
  // The full note, untruncated: a driver reading the brief needs every ruling.
  if (note?.note) lines.push("", "## The last resume's note", "", note.note);
  lines.push("", "## The prompt", "", job.body);
  return lines.join("\n");
}

// `note` is passed by resume, whose audit row is written in the same batch as this
// mirror and so cannot be read back yet. Every other transition reads it.
async function mirrorStatements(db: D1Database, job: JobRow, action: string, actor: string, note?: ResumeNote) {
  const path = jobDocPath(job.id);
  const prior = await priorDoc(db, job.namespace, path);
  const resumeNote = note ?? (await latestResumeNote(db, job));
  return improveDocStatements(db, {
    namespace: job.namespace,
    path,
    title: `Job: ${job.title}`,
    body: renderJobDoc(job, resumeNote),
    type: "task",
    // Closed on any finished row, `failed` as much as `done`, or brief keeps carrying
    // it as open work. isTerminalJobStatus is the one list of finished statuses.
    status: isTerminalJobStatus(job.status) ? "closed" : "active",
    tags: "jobs",
    prior,
    action,
    actor,
  });
}

// A job's audit row is addressed to its mirror document and carries the job id.
function jobAudit(db: D1Database, actor: string, action: string, job: JobRow, params: Record<string, unknown>) {
  return auditStatement(db, actor, action, job.namespace, jobDocPath(job.id), { job_id: job.id, ...params });
}

async function readJob(db: D1Database, id: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<JobRow>();
}

// The one path that fails a job that cannot be handed over: a corrupt requirement or
// a bad signature at claim, a bad signature at resume. The UPDATE, the mirror and the
// audit row are one guarded batch, so they commit only when the row is still as the
// caller read it; otherwise the caller gets the current row to refuse with.
async function markJobFailed(
  env: Env,
  job: JobRow,
  fromStatus: "queued" | "blocked",
  summary: string,
  auditAction: string,
  actor: string,
  auditParams: Record<string, unknown>,
  now: Date
): Promise<{ failed: true } | { failed: false; current: JobRow | null }> {
  const failed = { ...job, status: "failed" as const, result_summary: summary, lease_expires: null, updated_at: now.toISOString() };
  const committed = await guardedTransition(env, job, [
    env.DB.prepare(
      `UPDATE jobs SET status = 'failed', result_summary = ?2, lease_expires = NULL, updated_at = ?3
       WHERE id = ?1 AND status = ?4 RETURNING id`
    ).bind(job.id, summary, now.toISOString(), fromStatus),
    ...(await mirrorStatements(env.DB, failed, auditAction, actor)),
    jobAudit(env.DB, actor, auditAction, failed, auditParams),
  ]);
  if (!committed) return { failed: false, current: await readJob(env.DB, job.id) };
  return { failed: true };
}

// Every transition and its records are one batch, so a throw cannot leave a moved row
// with no record of the move. `read` is the row the caller decided on;
// requireJobUnchanged, first in the batch, aborts it unless the row still has that
// status, holder and updated_at. Returns false when the guard aborted: nothing was
// written and the row changed since `read`.
async function guardedTransition(env: Env, read: JobRow, statements: D1PreparedStatement[]): Promise<boolean> {
  try {
    await env.DB.batch([requireJobUnchanged(env.DB, read.id, read.status, read.claimed_by, read.updated_at), ...statements]);
    return true;
  } catch (err) {
    if (!isMissingRowAbort(err)) throw err;
    return false;
  }
}

/** The refusal for a job markJobFailed found had already moved. */
function movedBeforeFailing(action: string, id: string, current: JobRow | null, why: string): JobResult {
  return refuse(
    action,
    `${id} ${why}, but it changed before it could be marked failed: it is now ${current?.status ?? "gone"}${current?.claimed_by ? `, held by ${current.claimed_by}` : ""}. Nothing was written.`
  );
}

// The track-record bar, checked at claim (migrations/0011). Read only when a job sets
// one, because the record scans every outcome row. recordFor is the same function
// improve_status and the console use. `null` for namespaces: the improve-loop columns
// play no part here and would be attributed to whichever credential is asking.
async function recordShortfall(db: D1Database, actor: string, job: JobRow): Promise<string | null> {
  if (!job.min_record) return null;
  return missingForRecord(recordFor(actor, await loadRecordRows(db), null), job.min_record);
}

// The body is signed at post with the improve loop's task envelope
// (src/improve-task.ts). The driver refuses a body that does not verify, so an edited
// row or document cannot steer a session holding shell and repo credentials. With no
// IMPROVE_SCORE_SECRET, post refuses rather than queue jobs no driver would accept.

/** The open statuses in prose, derived rather than retyped, so a status added to
 *  OPEN_JOB_STATUSES cannot leave the refusal claiming a shorter list than the index
 *  enforces. */
function openMeans(): string {
  const names = [...OPEN_JOB_STATUSES];
  const last = names.pop();
  return names.length ? `${names.join(", ")} or ${last}` : String(last);
}

/** What a duplicate post collided with. The unique index is the rule and D1's error
 *  names only the constraint, so the row is read back to name the holding job and its
 *  state. The lookup only shapes the message: if the holder finished in between, the
 *  refusal still stands. */
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
  }
): Promise<JobResult> {
  const actor = agent.actor;
  if (!env.IMPROVE_SCORE_SECRET) {
    return refuse(
      "post",
      "job signing is not configured on this Worker (IMPROVE_SCORE_SECRET is unset), so this job could not be signed and no driver would execute it. Refusing rather than queueing work nothing can verify."
    );
  }
  const title = args.title.trim();
  if (!title) return refuse("post", "a job needs a title: it is how the queue refuses a duplicate while one is still open.");
  if (!args.body.trim()) return refuse("post", "a job needs a body. The body is the prompt the driver executes.");
  // The body is the prompt a driver executes, and swallowed text would be signed with it.
  const postSwallowed = swallowedParamTag(args.body);
  if (postSwallowed) return refuse("post", swallowedTagRefusal("body", postSwallowed));
  // A registered namespace, as write requires, because the mirror document lands there.
  const registered = await env.DB.prepare("SELECT namespace FROM namespaces WHERE namespace = ?1").bind(args.namespace).first();
  if (!registered) {
    return refuse(
      "post",
      `unknown namespace '${args.namespace}'. Nothing was written. A job and its mirror document live in a registered namespace; check the spelling against the namespaces tool, or create it with register_namespace.`
    );
  }

  const signed = await signTaskBody(env.IMPROVE_SCORE_SECRET, args.body);
  const job: JobRow = {
    id: mintJobId(),
    namespace: args.namespace,
    title,
    body: signed,
    priority: args.priority ?? 0,
    status: "queued",
    posted_by: actor,
    claimed_by: null,
    claimed_at: null,
    lease_expires: null,
    result_ref: null,
    result_summary: null,
    gate_required: args.gate_required ? 1 : 0,
    // NULL when nothing was asked for, not an empty requirement object.
    required_scopes: args.required_scopes?.flags?.length ? serializeRequiredScopes(args.required_scopes) : null,
    // A bar of zero is no bar, so it is stored as NULL.
    min_record: args.min_record?.prs_merged ? serializeMinRecord(args.min_record) : null,
    blocked_count: 0,
    resumed_count: 0,
    corrections_count: 0,
    review_required: args.review_required ? 1 : 0,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  const statements = [
    env.DB.prepare(
      `INSERT INTO jobs (id, namespace, title, body, priority, status, posted_by, gate_required, required_scopes, min_record, review_required, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?7, ?8, ?9, ?10, ?11, ?11)`
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
      job.created_at
    ),
    ...(await mirrorStatements(env.DB, job, "job-posted", actor)),
    jobAudit(env.DB, actor, "job-posted", job, {
      title: job.title,
      priority: job.priority,
      gate_required: job.gate_required,
      ...(job.required_scopes ? { required_scopes: job.required_scopes } : {}),
      ...(job.min_record ? { min_record: job.min_record } : {}),
      ...(job.review_required ? { review_required: true } : {}),
    }),
  ];
  try {
    await env.DB.batch(statements);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The partial unique index over (namespace, title) for open statuses.
    if (/UNIQUE/i.test(message)) {
      return refuse("post", await duplicateRefusal(env, args.namespace, title));
    }
    throw err;
  }
  return { ok: true, action: "post", job };
}

// List never carries a body unless one job was asked for by a writer. A body is the
// prompt a driver executes, so a read grant must not read every prompt queued. claim
// returns it, and so does list when `withBody` is set, which the tool sets only for a
// single named id and a caller holding write.
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
  // One extra row asked for, so a full page is distinguishable from "there are more".
  const truncated = rows.length > JOBS_ROWS_MAX;
  // Only one named job carries its resume note; a wide list would cost a read per row.
  const listNote = args.id && rows.length === 1 ? await latestResumeNote(env.DB, rows[0]) : null;
  return {
    ok: true,
    action: "list",
    ...(listNote ? { resume_note: listNote } : {}),
    jobs: truncated ? rows.slice(0, JOBS_ROWS_MAX) : rows,
    ...(truncated ? { truncated: true, note: `more than ${JOBS_ROWS_MAX} jobs match; narrow by namespace or status.` } : {}),
  };
}

// One claim per caller, across every namespace: a driver does one job at a time.
// Checked before the CAS, so the refusal names the job already held rather than
// reporting a lost race.
export async function claimJob(
  env: Env,
  agent: Agent,
  now: Date,
  args: { namespace?: string; id?: string }
): Promise<JobResult> {
  const actor = agent.actor;
  const badActor = actorShapeRefusal("claim", actor);
  if (badActor) return badActor;
  const held = await heldClaim(env.DB, actor);
  if (held) {
    return refuse(
      "claim",
      `${actor} already holds ${held.id} ('${held.title}' in ${held.namespace}), leased until ${held.lease_expires}. Complete it, fail it, or block it before claiming another.`
    );
  }

  // A named job or the top queued one. The SELECT only picks a candidate; the guarded
  // UPDATE below claims it.
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

  // What the job needs of the driver is checked before the lease is taken, through
  // checkScope, so a job is never parked on a driver that cannot do it. A requirement
  // that cannot be read fails the job: left queued, the same row would be refused to
  // every driver in turn and stop the namespace's queue.
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

  const shortfall = await recordShortfall(env.DB, actor, candidate);
  if (shortfall) {
    return refuse("claim", `${actor} cannot claim ${candidate.id} ('${candidate.title}'): ${shortfall} The job stays queued for a driver that can do it.`);
  }

  // The signature is checked before the job is handed over, because a job body is
  // executable input for a session holding shell and repo credentials. A body that
  // does not verify fails the job rather than being left queued for every driver in
  // turn. Unlike a run document (verifyTaskDoc) there is no actor check: a job is
  // posted by a human seat, and this Worker's signature is what proves it went
  // through `post`.
  const verdict = await verifySignedBody(env.IMPROVE_SCORE_SECRET, candidate.body, "job body");
  if (!verdict.ok) {
    const marked = await markJobFailed(env, candidate, "queued", verdict.reason, "job-signature-refused", actor, { reason: verdict.reason }, now);
    if (!marked.failed) return movedBeforeFailing("claim", candidate.id, marked.current, "failed its signature check");
    return refuse("claim", `${candidate.id} failed its signature check and has been marked failed: ${verdict.reason}`);
  }

  const expires = leaseUntil(now);
  const claimed: JobRow = {
    ...candidate,
    status: "claimed",
    claimed_by: actor,
    claimed_at: now.toISOString(),
    lease_expires: expires,
    updated_at: now.toISOString(),
  };
  // Two drivers reading the same candidate resolve to one winner: the first commit
  // moves updated_at and the second batch's guard aborts.
  const won = await guardedTransition(env, candidate, [
    env.DB.prepare(
      `UPDATE jobs SET status = 'claimed', claimed_by = ?2, claimed_at = ?3, lease_expires = ?4, updated_at = ?3
       WHERE id = ?1 AND status = 'queued' RETURNING id`
    ).bind(candidate.id, actor, now.toISOString(), expires),
    ...(await mirrorStatements(env.DB, claimed, "job-claimed", actor)),
    jobAudit(env.DB, actor, "job-claimed", claimed, { lease_expires: expires }),
  ]);
  if (!won) {
    return refuse("claim", `${candidate.id} was claimed by someone else between reading it and taking it. Ask again.`);
  }
  // A resumed job whose lease expired reaches its next driver here, with its approval.
  const claimNote = await latestResumeNote(env.DB, claimed);
  return { ok: true, action: "claim", job: claimed, ...(claimNote ? { resume_note: claimNote } : {}) };
}

// heartbeat, complete, fail and block fire only for the claimed job this caller
// holds, so a lease the tick returned to the queue cannot be completed out from under
// its new owner.
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
    // Only block bumps the gate counter. Bound as a number, not interpolated, so the
    // statement stays one static string that test/jobs.test.ts and
    // test-integration/query-plans.test.ts can read and EXPLAIN.
    bumpBlocked?: boolean;
    // What the driver says this job produced; verified on the terminal transitions.
    evidence?: JobEvidence;
    // Skill names only: the credit direction comes from signalFor().
    skills?: JobSkills;
  }
): Promise<JobResult> {
  const actor = agent.actor;
  const read = await readJob(env.DB, id);
  const notHeld = holderRefusal(action, id, actor, read);
  if (notHeld) return notHeld;
  if (!read) return refuse(action, `no job ${id}.`);
  // The row as the UPDATE will leave it, so the mirror and outcome can be built first.
  const job: JobRow = {
    ...read,
    status: patch.status,
    result_summary: patch.result_summary ?? read.result_summary,
    result_ref: patch.result_ref ?? read.result_ref,
    lease_expires: patch.lease_expires,
    updated_at: now.toISOString(),
    blocked_count: read.blocked_count + (patch.bumpBlocked ? 1 : 0),
  };

  // The transition and every record of it are one batch, behind a guard that aborts it
  // unless the row is still claimed by this caller at the updated_at just read.
  //
  // The outcome row is written on the terminal transitions only, once per job (the
  // primary key enforces it), and a failed job gets one too, or every agent's record
  // would look equally good. verifyEvidence runs before the batch and reports its own
  // errors as notes, so an unreachable GitHub cannot stop a finished job closing.
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
    // One row per pull request the evidence named, so the counts can be traced and the
    // merge state corrected later.
    statements.push(...outcomePrStatements(env.DB, job.id, patch.evidence?.prs ?? []));
    // Credit comes only from the verified signal: signalFor reads merge state and CI
    // as this Worker read them. An unverifiable job earns nothing either way.
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
  // A driver a resume returned the job to learns of it on its next heartbeat.
  const heartbeatNote = action === "heartbeat" ? await latestResumeNote(env.DB, job) : null;
  return { ok: true, action, job, ...(outcome ? { outcome } : {}), ...(heartbeatNote ? { resume_note: heartbeatNote } : {}) };
}

export async function heartbeatJob(env: Env, agent: Agent, now: Date, id: string): Promise<JobResult> {
  return holderTransition(env, agent, now, "heartbeat", id, { status: "claimed", lease_expires: leaseUntil(now) });
}

// The corrections budget belongs to the work, not the row. The open-title index
// (migrations/0019) does not cover `failed`, so a failed job's (namespace, title) can
// be posted again with a fresh row at 0; summing across every row for that work keeps
// the cap. Unindexed on purpose: the queue holds a few hundred rows at most.
//
// Fails closed: a read that throws or a non-finite SUM returns NaN, which
// atCorrectionCap treats as a spent budget.
async function correctionsForWork(db: D1Database, namespace: string, title: string): Promise<number> {
  try {
    const row = await db
      .prepare("SELECT COALESCE(SUM(corrections_count), 0) AS spent FROM jobs WHERE namespace = ?1 AND title = ?2")
      .bind(namespace, title)
      .first<{ spent: number }>();
    const spent = row?.spent;
    return typeof spent === "number" && Number.isFinite(spent) ? spent : Number.NaN;
  } catch (err) {
    console.error(`CORRECTIONS_READ_FAILED ${namespace}/${title}: ${err instanceof Error ? err.message : String(err)}`);
    return Number.NaN;
  }
}

// The review gate, consulted by complete, fail and block alike: a gate on one of them
// is bypassed through the others. Only complete demands a pull request, because work
// that could not be done, or that stopped at a gate, may have none. Returns null when
// the gate does not apply.
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
  // The stored reference is the bound pull request; this call's references are candidates.
  let outcome: GateOutcome | null;
  try {
    outcome = await reviewGate(
      env,
      { namespace: current.namespace, review_required: current.review_required, result_ref: current.result_ref },
      { ...opts, candidateRefs: [resultRef, ...(opts.candidateRefs ?? [])] }
    );
  } catch (err) {
    // A GitHub failure holds the job: an unreadable review is not an approval.
    return refuse(
      action,
      `${id} needs a review and GitHub could not be read: ${err instanceof Error ? err.message : String(err)}. ` +
        `The job stays claimed; try again rather than treating an unreadable review as an approval.`
    );
  }
  if (outcome === null) return null;

  // The first read binds the job to its pull request in result_ref, whatever the
  // verdict, so a CHANGES cannot be escaped by naming another pull request next time.
  // The binding moves updated_at, so the CHANGES write guards on the row it left.
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

  // CHANGES and BLOCK both move the job, so the row records what the reviewer said.
  const { review } = outcome;
  const said = review.said ? ` ${review.said}` : "";
  if (outcome.kind === "rework") {
    // The cap is checked before the correction is spent, or a reviewer and a driver
    // could disagree forever. At the cap the job goes to the seat through the ordinary
    // block path; fromReview stops blockJob consulting this review again.
    const spentOnWork = await correctionsForWork(env.DB, current.namespace, current.title);
    if (atCorrectionCap(spentOnWork)) {
      return endedElsewhere(action, await blockJob(env, agent, now, id, {
        reason:
          `review by ${review.by}: CHANGES.${said} This is correction ${spentOnWork + 1} against this work, past the cap of ${CORRECTION_CAP}: ` +
          `${RETRY_CAP_REASON}. The reviewer and the driver have not converged, so what happens next is a person's call rather than another round.`,
        fromReview: true,
      }));
    }
    // Back to the driver, spending a correction from the retry cap's budget.
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

  // BLOCK: blocked for the seat through the ordinary block path.
  return endedElsewhere(action, await blockJob(env, agent, now, id, { reason: `review by ${review.by}: BLOCK.${said}`, fromReview: true }));
}

// A complete or fail that the reviewer turned into a block is reported as a refusal of
// the caller's own action, with the job as it now stands. A caller that asked to block
// got a block, so its result passes.
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
 * Every skill id the caller named, checked against the table. An unknown id is
 * refused, not dropped, because dropping it would record "offered nothing" for a run
 * that was offered something. Returns the refusal, or null.
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

// Used must be a subset of offered: a skill never offered did not come from the
// recommend step, so it cannot be credited to it.
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
  // Checked before the write, because the outcome row cannot be corrected afterwards.
  const swallowed = swallowedParamTag(args.result_summary);
  if (swallowed) return refuse("complete", swallowedTagRefusal("result_summary", swallowed));
  // The review gate (see reviewRefusal). evidence.prs counts as naming the pull request.
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

// The seat failing a job it does not hold, for a job whose driver is gone. Every other
// transition keys on `claimed_by = <caller>`, which leaves no other way to close it.
// Admin only (the OAuth admin session or a legacy write key, never a minted agent), so
// a driver cannot fail another driver's job. A finished job is refused, not rewritten.
export async function adminFailJob(env: Env, agent: Agent, now: Date, id: string, reason: string): Promise<JobResult> {
  if (!agent.admin) {
    return refuse(
      "admin-fail",
      `${agent.actor} may only fail a job it holds. Failing somebody else's job is the administrator's call, and a minted agent is deliberately not the administrator.`
    );
  }
  if (!reason?.trim()) return refuse("admin-fail", "fail needs a reason. A failed job with no reason is one nobody can retry or rule on.");
  const current = await readJob(env.DB, id);
  if (!current) return refuse("admin-fail", `no job ${id}.`);
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
  // An outcome row, as `fail` writes, but only when somebody held the job: a queued
  // job was never worked and has no agent to attribute a failure to. No evidence,
  // because the seat did not do the work.
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

// Supersede closes a job replaced before any work was done on it, so it is not
// recorded as a failure. No outcome row, pull request rows or attribution: nothing was
// attempted.
//
// Allowed from `queued` by any caller that may write the namespace, and from `claimed`
// only while the row records no work, by the holder or the seat (admin or can_merge,
// as resume identifies it; an agent's kind is not authorizing). Later jobs are ended
// by `fail` or the console's admin fail. The whole rule is in the one keyed UPDATE;
// the checks before it only choose the refusal message.

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
  // The job's own namespace: the tool's check saw only the argument, which may be omitted.
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
  // ?4 is the holder read above, so a lease that passed to another driver meanwhile
  // is not superseded out from under it.
  const job: JobRow = { ...current, status: "superseded", result_summary: summary, lease_expires: null, updated_at: now.toISOString() };
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

// A blocked job carries the exact command the human must run. blockJob writes this
// marker and commandFromSummary reads it back, so the format has one spelling.
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
  // A capped job says so in result_summary, the field every reader looks at. The
  // budget is read before the transition.
  const current = await readJob(env.DB, id);
  const capped = current !== null && atCorrectionCap(await correctionsForWork(env.DB, current.namespace, current.title));
  return holderTransition(env, agent, now, "block", id, {
    status: "blocked",
    result_summary: capped ? cappedSummary(summary) : summary,
    lease_expires: null,
    bumpBlocked: true,
  });
}

// Resume. A gate is a pause, not an ending: a blocked job goes back to work after a
// human approves.
//
// The signature is checked again, because a blocked row can sit for hours and resume
// hands its body to a session holding shell and repo credentials. A tampered job is
// failed rather than returned.
//
// Any write-grant caller may resume, because the seat that approves is routinely not
// the session that blocked; the reason is required and lands in the audit row. The
// claimant may not resume its own job on a plain resume, or the audit row would read
// as a human approval. It still may as the admin, with can_merge, or through
// approved_by_policy for a branch push or a pull request.
//
// The lease goes back to the driver that blocked, not the resumer, unless `take` is
// set, which runs every check a claim runs.
export interface ResumeOptions {
  // The pre-approved gate: the policy version the caller read. The blocked command
  // must match a signed policy class or the resume is refused.
  approvedByPolicy?: string;
  // The resumer acquires the job rather than returning it to the driver that blocked.
  take?: boolean;
  // This resume sends the work back to be corrected, so it spends from the retry
  // cap's budget. A plain resume does not.
  correction?: boolean;
  // The seat's full note beside the one-line reason, recorded in the audit row and
  // handed on whole.
  note?: string;
}

// What a driver may approve for itself: pushing its own branch and opening its own
// pull request. Migrations stay a human gate. This only narrows the policy's classes.
const DRIVER_SELF_APPROVED: readonly GateClass[] = ["push_branch", "open_pr"];

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

  // A claimant approving its own gate is no approval, with or without `take`.
  const isSeat = callerIsSeat(agent);
  if (approvedByPolicy === undefined && !isSeat && current.claimed_by === actor) {
    return refuse(
      "resume",
      `${actor} blocked ${id} and cannot approve its own gate with a plain resume. The seat (admin or can_merge) resumes it once the command is approved, ` +
        `or, for a branch push or a pull request only, resume with approved_by_policy. It stays blocked.`
    );
  }

  // A blocked row with no claimant (none should exist) goes to the caller.
  const holder = take || !current.claimed_by ? actor : current.claimed_by;
  const acquiring = holder === actor;

  // One claim per caller, asked of whoever ends up holding the lease.
  const held = await heldClaim(env.DB, holder);
  if (held) {
    return refuse(
      "resume",
      `${holder} already holds ${held.id} ('${held.title}' in ${held.namespace}), leased until ${held.lease_expires}. ` +
        (acquiring ? "Finish it before resuming another." : `${id} stays blocked until that driver is free, or resume it with take.`)
    );
  }

  // A resume that acquires the job asks the same questions a claim asks. When the job
  // goes back to its own claimant, that claimant passed them at its claim.
  const corrupt = corruptRequirement(current);
  if (corrupt) {
    return refuse("resume", `${id} has a corrupt requirement: ${corrupt}. It stays blocked; a requirement that cannot be read is not the same as none.`);
  }
  // The namespace is asked either way, because returning the job still moves it.
  const outside = outsideJobNamespace(agent, current.namespace);
  if (outside) {
    return refuse("resume", `${actor} cannot resume ${id} ('${current.title}'): ${outside} It stays blocked.`);
  }
  if (acquiring) {
    const missing = missingForJob(agent, current.namespace, current.required_scopes);
    if (missing) {
      return refuse("resume", `${actor} cannot resume ${id} ('${current.title}'): ${missing} It stays blocked for a driver that can finish it.`);
    }
    const resumeShortfall = await recordShortfall(env.DB, actor, current);
    if (resumeShortfall) {
      return refuse("resume", `${actor} cannot resume ${id} ('${current.title}'): ${resumeShortfall} It stays blocked for a driver that can finish it.`);
    }
  }

  // The retry cap, checked before anything is spent. Past it, the next step is a
  // person's, so an admin resume passes and does not spend the budget.
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
  // blocked as it was.
  let policyMatch: { klass: string; detail: string; version: string } | null = null;
  if (approvedByPolicy !== undefined) {
    // Approving on policy is the seat's act (admin or can_merge; an agent's kind is
    // not authorizing). A driver may approve only DRIVER_SELF_APPROVED classes, on a
    // job it blocked itself and still holds. The classification is still
    // approveByPolicy's, so the never list runs first.
    if (!isSeat && (current.claimed_by !== actor || take)) {
      return refuse(
        "resume",
        `${id} cannot be approved by ${agent.actor} on the gate policy alone. A driver may approve only a job it blocked itself, ` +
          `and ${id} was blocked by ${current.claimed_by ?? "nobody on record"}. Approving somebody else's blocked command is the seat's act, ` +
          `and this caller holds neither the admin identity nor can_merge.`
      );
    }
    const command = commandFromSummary(current.result_summary);
    // The driver's narrower list first, so a driver's migration is refused without a
    // repo read. An unclassified command falls through to approveByPolicy.
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
    // A migration is read at the job's branch head, because that is the file the
    // approved command runs. Read once, only when the command names a migration; a
    // failed read throws its reason into the refusal.
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
    // The driver's list asserted on the approved verdict too, in case the two
    // classifications disagree.
    if (!isSeat && verdict.klasses.some((k) => !DRIVER_SELF_APPROVED.includes(k))) {
      return refuse("resume", `${id} is not pre-approved for a driver: it matched ${verdict.klass}. It stays blocked for the human.`);
    }
    policyMatch = { klass: verdict.klass, detail: verdict.detail, version: verdict.policyVersion };
  }

  const expires = leaseUntil(now);
  // Only a correction spends the budget, never an admin's; bound, not interpolated, as
  // bumpBlocked is. claimed_at is not touched: duration_minutes measures from the
  // first claim.
  const spend = correction && !agent.admin ? 1 : 0;
  const job: JobRow = {
    ...current,
    status: "claimed",
    claimed_by: holder,
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
  const won = await guardedTransition(env, current, [
    env.DB.prepare(
      `UPDATE jobs SET status = 'claimed', claimed_by = ?2, lease_expires = ?4,
         resumed_count = resumed_count + 1, corrections_count = corrections_count + ?5, updated_at = ?3
       WHERE id = ?1 AND status = 'blocked' RETURNING id`
    ).bind(id, holder, now.toISOString(), expires, spend),
    ...(await mirrorStatements(env.DB, job, "job-resumed", actor, resumeNote)),
    jobAudit(env.DB, actor, "job-resumed", job, {
      approved: reason,
      ...(fullNote ? { note: fullNote } : {}),
      held_by: holder,
      ...(take ? { taken: true } : {}),
      ...(spend ? { correction: true } : {}),
      lease_expires: expires,
      resumed_count: job.resumed_count,
      corrections_count: job.corrections_count,
      ...(agent.admin ? { cap_lifted_by_admin: true } : {}),
      // Which class matched, so the approval can be checked against the policy later.
      ...(policyMatch
        ? { approved_by_policy: policyMatch.version, policy_class: policyMatch.klass, policy_detail: policyMatch.detail }
        : {}),
    }),
  ]);
  if (!won) {
    return refuse("resume", `${id} left blocked between reading it and resuming it. Nothing was written; ask again.`);
  }
  return { ok: true, action: "resume", job, resume_note: resumeNote };
}

// The lease sweep, run by the five-minute improve tick. An expired claim goes back to
// queued, so a driver that died holds a job for at most JOB_LEASE_SECONDS. Each job's
// requeue, mirror and audit row are one guarded batch, so a job whose driver
// heartbeat in between is left alone. Returns only the jobs whose batch committed.
export async function expireJobLeases(env: Env, now: Date): Promise<{ requeued: string[] }> {
  const stamp = now.toISOString();
  const { results } = await env.DB.prepare(
    "SELECT * FROM jobs WHERE status = 'claimed' AND lease_expires IS NOT NULL AND lease_expires < ?1"
  )
    .bind(stamp)
    .all<JobRow>();
  const requeued: string[] = [];
  // One job failing does not cost the others their requeue.
  for (const read of results ?? []) {
    try {
      const job: JobRow = { ...read, status: "queued", claimed_by: null, claimed_at: null, lease_expires: null, updated_at: stamp };
      const moved = await guardedTransition(env, read, [
        env.DB.prepare(
          `UPDATE jobs SET status = 'queued', claimed_by = NULL, claimed_at = NULL, lease_expires = NULL, updated_at = ?2
           WHERE id = ?1 AND status = 'claimed' AND lease_expires IS NOT NULL AND lease_expires < ?2 RETURNING id`
        ).bind(read.id, stamp),
        ...(await mirrorStatements(env.DB, job, "job-lease-expired", "improve-loop")),
        jobAudit(env.DB, "improve-loop", "job-lease-expired", job, { returned_to: "queued" }),
      ]);
      if (moved) requeued.push(read.id);
    } catch (err) {
      console.error(`JOB_LEASE_REQUEUE_FAILED ${read.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { requeued };
}

// The improve_status block: counts per namespace, plus the blocked jobs with the
// command each waits on, since a count of blocked jobs tells nobody what to run.
// done_today rather than a lifetime total, which only goes up.
export interface JobsSummary {
  queued: number;
  claimed: number;
  blocked: number;
  done_today: number;
  // How often each job has hit a gate and how often a human sent it back.
  blocked_jobs: Array<{ id: string; title: string; waiting_on: string | null; blocked_times: number; resumed: number }>;
}

export async function jobsSummary(db: D1Database, namespace: string, now: Date): Promise<JobsSummary> {
  const day = now.toISOString().slice(0, 10);
  const counts = await db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM jobs
       WHERE namespace = ?1 AND status IN ('queued', 'claimed', 'blocked') GROUP BY status`
    )
    .bind(namespace)
    .all<{ status: string; n: number }>();
  const byStatus = new Map((counts.results ?? []).map((r) => [r.status, r.n]));
  // substr, not a range: updated_at is an ISO string here and datetime('now') from the
  // table default, and the two agree only on the first ten characters.
  const doneToday = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs
       WHERE namespace = ?1 AND status = 'done' AND substr(updated_at, 1, 10) = ?2`
    )
    .bind(namespace, day)
    .first<{ n: number }>();
  const blocked = await db
    .prepare(
      `SELECT id, title, result_summary, blocked_count, resumed_count FROM jobs
       WHERE namespace = ?1 AND status = 'blocked' ORDER BY updated_at DESC LIMIT 20`
    )
    .bind(namespace)
    .all<{ id: string; title: string; result_summary: string | null; blocked_count: number; resumed_count: number }>();
  return {
    queued: byStatus.get("queued") ?? 0,
    claimed: byStatus.get("claimed") ?? 0,
    blocked: byStatus.get("blocked") ?? 0,
    done_today: doneToday?.n ?? 0,
    blocked_jobs: (blocked.results ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      waiting_on: r.result_summary,
      blocked_times: r.blocked_count,
      resumed: r.resumed_count,
    })),
  };
}
