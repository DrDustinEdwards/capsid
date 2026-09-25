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
import { reviewGate, type ReviewOutcome } from "./review";
import { outcomePrStatements } from "./outcome-prs";
import { readRepoFile } from "./github/contents";
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

// THE WORK QUEUE. The ruling seat posts a job from a chat; a driver session on a
// machine claims it, does it, and reports back.
//
// EVERY TRANSITION IS A KEYED UPDATE WITH RETURNING, never meta.changes. D1's
// meta.changes is inflated by the FTS5 triggers on documents, and these batches
// carry a document write, so the count would be of the triggers as much as the row.
// The same rule the improve state machine already runs on: `UPDATE ... WHERE status
// = <expected> RETURNING id`, and no row back means somebody else got there first.
//
// THE ROW IS THE SOURCE OF TRUTH FOR STATUS. The mirrored document at
// <namespace>/jobs/<id>.md is rewritten in the SAME BATCH as every transition, so a
// reader who found the job through brief or search sees the state the table holds.
// It is a projection, and its body says so.

// WHO CAN HOLD A LEASE. migrations/0006 states that claimed_by carries the same shape
// as audit_log.actor, so one query joins a job to what its driver did. A minted agent
// speaks that vocabulary as `agent:<name>` (src/agents-schema.ts, agentActor), and
// the name is UNIQUE in the agents table and never reused, so the string identifies
// exactly one credential forever.
const ACTOR_SHAPE = /^(github:|opkey:|agent:)/;

export interface JobResult {
  ok: boolean;
  action: string;
  job?: JobRow;
  jobs?: Array<JobListRow | JobRow>;
  truncated?: boolean;
  note?: string;
  refusal?: string;
  // THE OUTCOME ROW THIS TRANSITION WROTE, returned so the driver sees what the
  // Worker checked rather than assuming its own numbers were taken. `notes` names
  // every verification that could not run, which is the difference between a count
  // nobody checked and a count nobody tried to check.
  outcome?: { row: JobOutcomeRow; notes: string[] };
  // THE LATEST RESUME'S REASON, for a job that has been resumed at least once. See
  // latestResumeNote below.
  resume_note?: ResumeNote;
}

// WHAT THE LAST RESUME APPROVED, handed to whoever holds the job next.
//
// The reason a resume takes was written only to the audit row, and no tool returns
// audit params to a driver. The job row, its mirror document, and the claim and list
// responses carried nothing, so a driver picking a resumed job back up could not read
// what the seat had approved. On 2026-09-24 that lost the seat's answers twice in
// dustinedwards (job_5588145f7aaa, job_acaa730fcbc8) and the driver had to ask again
// (job_6aef1c672fc3). The audit row stays the one record; this reads it back.
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
  // Only once it has happened. A job that has never hit a gate should not carry a
  // line of zeroes explaining that it has not.
  if (job.blocked_count > 0) lines.push(`- gates hit: ${job.blocked_count}, resumed: ${job.resumed_count}`);
  // The brief carries open job documents, so this line is how brief hands the
  // approval to a driver.
  if (note) lines.push(`- last resume, by ${note.by} at ${note.at}: ${note.reason}`);
  if (job.result_summary) lines.push(`- result: ${job.result_summary}`);
  if (job.result_ref) lines.push(`- result ref: ${job.result_ref}`);
  // The full note as its own block after the status lines, whole: a driver reading
  // the brief needs every ruling, not the first line of them.
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
    // CLOSED ON A FINISHED ROW, and `failed` is as finished as `done`. This read
    // `job.status === "done"` until 2026-09-12, so a failed job's mirror stayed
    // `active` forever and brief kept carrying it as open work; three capsid job
    // documents sat that way. isTerminalJobStatus is the one statement of which
    // statuses are finished, and test/jobs.test.ts classifies every status in the
    // vocabulary so a new one cannot land unclassified.
    status: isTerminalJobStatus(job.status) ? "closed" : "active",
    tags: "jobs",
    prior,
    action,
    actor,
  });
}

function auditStatement(db: D1Database, actor: string, action: string, job: JobRow, params: Record<string, unknown>) {
  return db
    .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(actor, action, job.namespace, jobDocPath(job.id), JSON.stringify({ job_id: job.id, ...params }));
}

async function readJob(db: D1Database, id: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<JobRow>();
}

// THE TRACK-RECORD BAR, CHECKED AT THE CLAIM (migrations/0011).
//
// READ ONLY WHEN A JOB ASKS FOR ONE, which is almost never. The record is computed
// from every outcome row, so making every claim pay for that read to answer a
// question nobody asked would put a table scan in front of the queue's hottest path.
//
// It goes through recordFor, the same function improve_status and the console call,
// so the bar a claim is measured against is the number a human can read on the page.
// `null` for namespaces because the improve-loop columns play no part in this
// comparison and computing them here would attribute a namespace's attempts to
// whichever credential happened to be asking.
async function recordShortfall(db: D1Database, actor: string, job: JobRow): Promise<string | null> {
  if (!job.min_record) return null;
  return missingForRecord(recordFor(actor, await loadRecordRows(db), null), job.min_record);
}

// ---- post --------------------------------------------------------------------
//
// THE BODY IS SIGNED AT POST, with the same key and the same envelope as the
// improve loop's task documents (src/improve-task.ts). The driver refuses a job
// whose body does not verify, so a row edited by a raw D1 splice, or a document
// mirrored back over by hand, cannot steer a session that holds local shell and
// repo credentials.
//
// UNCONFIGURED IS A REFUSAL, not a skip. With no IMPROVE_SCORE_SECRET there is no
// key to sign with, and a queue of unsignable jobs is a queue the driver will
// refuse one at a time at 03:00 instead of here.

/** The open statuses in prose, derived rather than retyped, so a status added to
 *  OPEN_JOB_STATUSES cannot leave the refusal claiming a shorter list than the index
 *  enforces. */
function openMeans(): string {
  const names = [...OPEN_JOB_STATUSES];
  const last = names.pop();
  return names.length ? `${names.join(", ")} or ${last}` : String(last);
}

/** WHAT THE DUPLICATE POST COLLIDED WITH. The unique index is the rule and D1's error
 *  names only the constraint, so the row is read back to say which job is holding the
 *  title and what state it is in: "there is already one" sends the reader to the
 *  console to find out whether anybody is waiting on it. A blocked job is the case
 *  that matters, because it is waiting on a human rather than on a driver.
 *
 *  The lookup is the MESSAGE, never the rule: if the holder finished between the
 *  constraint firing and this read, the refusal still stands and says what it can. */
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
  // A body is the prompt a driver EXECUTES, so a malformed post is worse here than
  // anywhere else: the swallowed text is signed along with everything else and the
  // driver runs whatever survived.
  const postSwallowed = swallowedParamTag(args.body);
  if (postSwallowed) return refuse("post", swallowedTagRefusal("body", postSwallowed));

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
    // NULL WHEN NOTHING WAS ASKED FOR, rather than an empty requirement object. The
    // column's meaning is "this job needs something unusual", and a row of empty JSON
    // reads as a requirement nobody can see.
    required_scopes: args.required_scopes?.flags?.length ? serializeRequiredScopes(args.required_scopes) : null,
    // NULL WHEN NO BAR WAS ASKED FOR, on the same reasoning as required_scopes above.
    // A bar of zero is no bar, so it is stored as none rather than as a requirement
    // every agent trivially meets.
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
    auditStatement(env.DB, actor, "job-posted", job, {
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
    // The partial unique index over (namespace, title) where the status is open.
    // Reported as what it means rather than as the constraint's own text.
    if (/UNIQUE/i.test(message)) {
      return refuse("post", await duplicateRefusal(env, args.namespace, title));
    }
    throw err;
  }
  return { ok: true, action: "post", job };
}

// ---- list --------------------------------------------------------------------

// THE LIST NEVER CARRIES A BODY UNLESS IT WAS ASKED FOR ONE JOB BY A WRITER
// (AUDIT-2026-09-16.md). A body is the signed prompt a driver executes with shell and
// repo credentials, and list was SELECT *, so a read grant on a namespace read every
// prompt queued in it. The columns are named so the body never leaves D1 for a list;
// claim returns it, and so does list when `withBody` is set, which the tool sets only
// for a single named id and a caller holding write.
export const JOB_LIST_COLUMNS = [
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
  // One extra row asked for, so "exactly the page" is distinguishable from "there
  // are more". Same shape as every other bounded read here.
  const truncated = rows.length > JOBS_ROWS_MAX;
  // One named job carries its latest resume note. Not every row of a wide list,
  // which would cost one read per resumed job.
  const listNote = args.id && rows.length === 1 ? await latestResumeNote(env.DB, rows[0]) : null;
  return {
    ok: true,
    action: "list",
    ...(listNote ? { resume_note: listNote } : {}),
    jobs: truncated ? rows.slice(0, JOBS_ROWS_MAX) : rows,
    ...(truncated ? { truncated: true, note: `more than ${JOBS_ROWS_MAX} jobs match; narrow by namespace or status.` } : {}),
  };
}

// ---- claim -------------------------------------------------------------------
//
// ONE CLAIM PER CALLER, ACROSS EVERY NAMESPACE. A driver does one job at a time,
// and a second claim means the first is either finished or abandoned; letting a
// caller hold two turns the lease into a suggestion. Checked before the CAS, so the
// refusal names the job already held rather than reporting a lost race.
export async function claimJob(
  env: Env,
  agent: Agent,
  now: Date,
  args: { namespace?: string; id?: string }
): Promise<JobResult> {
  const actor = agent.actor;
  if (!ACTOR_SHAPE.test(actor)) {
    return refuse("claim", `'${actor}' is not a caller identity this queue can hold a lease for. A claim is recorded against a github: login, an opkey: fingerprint, or an agent: name.`);
  }
  const held = await env.DB.prepare("SELECT * FROM jobs WHERE status = 'claimed' AND claimed_by = ?1 LIMIT 1")
    .bind(actor)
    .first<JobRow>();
  if (held) {
    return refuse(
      "claim",
      `${actor} already holds ${held.id} ('${held.title}' in ${held.namespace}), leased until ${held.lease_expires}. Complete it, fail it, or block it before claiming another.`
    );
  }

  // Either a named job or the highest-priority queued one in a namespace. The
  // SELECT only picks a candidate; the UPDATE below is what actually claims it, so
  // two drivers reading the same candidate still resolve to one winner.
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

  // THE SIGNATURE IS CHECKED BEFORE THE JOB IS HANDED OVER, not by the driver after
  // it has one. A job body is executable input that arrives as a database row, and
  // the driver is a session holding local shell and repo credentials.
  //
  // A body that does not verify was edited after `post` signed it, by a raw splice
  // or by a write that reached the row some other way. That job is FAILED here
  // rather than left queued: leaving it would hand the same broken row to the next
  // driver, and every driver in turn, which is a queue that never drains.
  //
  // The actor check verifyTaskDoc adds for a run document deliberately does NOT
  // apply. Only the loop writes a run doc, so its audit actor is the loop; a job is
  // posted by a human seat, so its actor is that seat. What proves a job went
  // through `post` is that this Worker's key signed it.
  // WHAT THIS JOB NEEDS OF THE DRIVER, checked BEFORE the lease is taken. A claim
  // that takes the lease and then refuses has parked the job on a driver that cannot
  // do it, and since a caller holds one claim at a time it has also stopped that
  // driver taking anything else for four hours. The check runs through the one
  // enforcement point, so a job requirement and an agent scope are compared by the
  // same function that decides every tool call.
  // A REQUIREMENT THAT CANNOT BE READ FAILS THE JOB, on the signature check's reasoning
  // below: left queued, the same row would be refused to every driver in turn, and a
  // claim with no id takes the top queued job, so it would stop the namespace's queue.
  const corrupt = corruptRequirement(candidate);
  if (corrupt) {
    const reason = `${candidate.id} has a corrupt requirement: ${corrupt}. A requirement that cannot be read is not the same as none, so it was not leased.`;
    await env.DB.prepare(
      `UPDATE jobs SET status = 'failed', result_summary = ?2, lease_expires = NULL, updated_at = ?3
       WHERE id = ?1 AND status = 'queued' RETURNING id`
    )
      .bind(candidate.id, reason, now.toISOString())
      .first<{ id: string }>();
    const failed = { ...candidate, status: "failed" as const, result_summary: reason, updated_at: now.toISOString() };
    await env.DB.batch([
      ...(await mirrorStatements(env.DB, failed, "job-requirement-corrupt", actor)),
      auditStatement(env.DB, actor, "job-requirement-corrupt", failed, { reason: corrupt }),
    ]);
    return refuse("claim", `${reason} It has been marked failed.`);
  }

  const missing = missingForJob(agent, candidate.namespace, candidate.required_scopes);
  if (missing) {
    return refuse(
      "claim",
      `${actor} cannot claim ${candidate.id} ('${candidate.title}'): ${missing} The job stays queued for a driver that can do it.`
    );
  }

  // AND WHAT IT NEEDS OF THE DRIVER'S HISTORY, on the same terms and in the same
  // place: before the lease, so a driver that cannot satisfy the bar is not parked on
  // a job for four hours, and the job stays queued for one that can.
  const shortfall = await recordShortfall(env.DB, actor, candidate);
  if (shortfall) {
    return refuse("claim", `${actor} cannot claim ${candidate.id} ('${candidate.title}'): ${shortfall} The job stays queued for a driver that can do it.`);
  }

  const verdict = await verifySignedBody(env.IMPROVE_SCORE_SECRET, candidate.body, "job body");
  if (!verdict.ok) {
    await env.DB.prepare(
      `UPDATE jobs SET status = 'failed', result_summary = ?2, lease_expires = NULL, updated_at = ?3
       WHERE id = ?1 AND status = 'queued' RETURNING id`
    )
      .bind(candidate.id, verdict.reason, now.toISOString())
      .first<{ id: string }>();
    const failed = { ...candidate, status: "failed" as const, result_summary: verdict.reason, updated_at: now.toISOString() };
    await env.DB.batch([
      ...(await mirrorStatements(env.DB, failed, "job-signature-refused", actor)),
      auditStatement(env.DB, actor, "job-signature-refused", failed, { reason: verdict.reason }),
    ]);
    return refuse("claim", `${candidate.id} failed its signature check and has been marked failed: ${verdict.reason}`);
  }

  const expires = leaseUntil(now);
  const won = await env.DB.prepare(
    `UPDATE jobs SET status = 'claimed', claimed_by = ?2, claimed_at = ?3, lease_expires = ?4, updated_at = ?3
     WHERE id = ?1 AND status = 'queued' RETURNING id`
  )
    .bind(candidate.id, actor, now.toISOString(), expires)
    .first<{ id: string }>();
  if (!won) {
    return refuse("claim", `${candidate.id} was claimed by someone else between reading it and taking it. Ask again.`);
  }

  const claimed: JobRow = {
    ...candidate,
    status: "claimed",
    claimed_by: actor,
    claimed_at: now.toISOString(),
    lease_expires: expires,
    updated_at: now.toISOString(),
  };
  await env.DB.batch([
    ...(await mirrorStatements(env.DB, claimed, "job-claimed", actor)),
    auditStatement(env.DB, actor, "job-claimed", claimed, { lease_expires: expires }),
  ]);
  // A job that went back to the queue after a resume (an expired lease) reaches its
  // next driver here, so the approval has to come with it.
  const claimNote = await latestResumeNote(env.DB, claimed);
  return { ok: true, action: "claim", job: claimed, ...(claimNote ? { resume_note: claimNote } : {}) };
}

// ---- the transitions a holder makes -------------------------------------------
//
// heartbeat, complete, fail and block are the same shape: a keyed UPDATE that only
// fires for the CLAIMED job THIS caller holds, so an expired lease that the tick
// already returned to the queue cannot be completed out from under its new owner.
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
    // block is the only transition that bumps the gate counter. BOUND AS A NUMBER,
    // not interpolated as a SQL fragment: the statement stays one static string, so
    // test/jobs.test.ts can read that it is keyed and test-integration/
    // query-plans.test.ts can reconstruct it and EXPLAIN it. A statement assembled
    // at runtime is invisible to both.
    bumpBlocked?: boolean;
    // What the driver says this job produced. Verified against GitHub and written
    // into job_outcomes below, on the terminal transitions only.
    evidence?: JobEvidence;
    // The skills the driver was offered and used. Names only: the CREDIT direction
    // comes from signalFor(), which reads what the Worker verified on GitHub.
    skills?: JobSkills;
  }
): Promise<JobResult> {
  const actor = agent.actor;
  const won = await env.DB.prepare(
    `UPDATE jobs SET status = ?2, result_summary = COALESCE(?3, result_summary), result_ref = COALESCE(?4, result_ref),
       lease_expires = ?5, updated_at = ?6, blocked_count = blocked_count + ?8
     WHERE id = ?1 AND status = 'claimed' AND claimed_by = ?7 RETURNING id`
  )
    .bind(
      id,
      patch.status,
      patch.result_summary ?? null,
      patch.result_ref ?? null,
      patch.lease_expires,
      now.toISOString(),
      actor,
      patch.bumpBlocked ? 1 : 0
    )
    .first<{ id: string }>();
  if (!won) {
    const current = await readJob(env.DB, id);
    if (!current) return refuse(action, `no job ${id}.`);
    if (current.status !== "claimed") {
      return refuse(
        action,
        `${id} is ${current.status}, not claimed. ${current.status === "queued" ? "Its lease expired and the tick returned it to the queue; claim it again." : "It has already been finished."}`
      );
    }
    return refuse(action, `${id} is held by ${current.claimed_by}, not by ${actor}.`);
  }
  const job = (await readJob(env.DB, id)) as JobRow;

  // THE OUTCOME ROW, ON THE TERMINAL TRANSITIONS ONLY. A job that is still running
  // has no outcome to record, and one that reached `done` or `failed` will not
  // transition again: both are keyed updates out of `claimed`, so this runs once per
  // job and the primary key enforces that rather than trusting it.
  //
  // A FAILED JOB GETS A ROW TOO. A driver whose jobs mostly fail is the thing this
  // table exists to make visible, and recording only the successes would produce a
  // record in which every agent looks equally good.
  //
  // VERIFICATION RUNS BEFORE THE BATCH AND CANNOT FAIL THE TRANSITION. The row is
  // already updated by this point; verifyEvidence swallows its own errors and reports
  // them as notes, so an unreachable GitHub costs the verified flags and not the
  // driver's ability to close a finished job.
  let outcome: { row: JobOutcomeRow; notes: string[] } | undefined;
  const statements = [
    ...(await mirrorStatements(env.DB, job, `job-${action}`, actor)),
    auditStatement(env.DB, actor, `job-${action}`, job, {
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
    // ONE ROW PER PULL REQUEST THE EVIDENCE NAMED, in the same batch as the outcome.
    // Until this existed the URLs were read once during verification and thrown away,
    // so the row kept counts with no way back to what they counted, and the merge
    // state it recorded at complete time could never be corrected.
    statements.push(...outcomePrStatements(env.DB, job.id, patch.evidence?.prs ?? []));
    // THE CREDIT, FROM THE VERIFIED SIGNAL AND NOWHERE ELSE (ruled 2026-09-16). The
    // driver names offered and used; signalFor reads merge state and CI as this Worker
    // read them off GitHub. An unverifiable job earns nothing in either direction.
    statements.push(
      ...attributionStatements(env.DB, {
        offered: patch.skills?.offered ?? [],
        used: patch.skills?.used ?? [],
        signal: signalFor(verdict),
      })
    );
  }
  await env.DB.batch(statements);
  // The driver a resume returned the job to is already holding it and learns of the
  // resume by its next call, which is usually a heartbeat.
  const heartbeatNote = action === "heartbeat" ? await latestResumeNote(env.DB, job) : null;
  return { ok: true, action, job, ...(outcome ? { outcome } : {}), ...(heartbeatNote ? { resume_note: heartbeatNote } : {}) };
}

export async function heartbeatJob(env: Env, agent: Agent, now: Date, id: string): Promise<JobResult> {
  return holderTransition(env, agent, now, "heartbeat", id, { status: "claimed", lease_expires: leaseUntil(now) });
}

// THE REVIEW GATE, CONSULTED BY BOTH TRANSITIONS THAT HAND WORK ON.
//
// A gate on one of them would not be a gate: a driver that found `complete` refused
// would simply `block` instead, and the bypass would look like ordinary use. So the
// same function answers for both, and the answer is turned into a JobResult here so
// the two cannot describe the same verdict differently.
//
// THE BUDGET IS A PROPERTY OF THE WORK, NOT OF THE ROW.
//
// corrections_count lives on a row, and the unique open-title index only covers
// `queued` and `claimed`, so a job that was failed, or one still sitting `blocked`,
// leaves (namespace, title) free to be posted again. The new row starts at 0 and the
// ceiling resets, which made the cap a property of how many times a row existed
// rather than of how many times the work had been sent back (audit 2026-09-13,
// finding 9).
//
// Ruled 2026-09-13: count per (namespace, title) and leave the index alone. The
// alternative was widening the unique index to include `blocked`, which needs a
// migration and would also refuse a legitimate re-post of work that stopped at a gate.
//
// Summed across every row for that work, whatever its status, and the current row is
// one of them. Unindexed on purpose: jobs is a single-user queue of a few hundred rows
// at most, and the only index that could serve this is the partial one this ruling
// declined to widen.
//
// FAILS CLOSED. A read that throws, or a SUM that comes back as anything but a finite
// number, returns NaN, and atCorrectionCap treats a budget it cannot read as a budget
// already spent.
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

// Returns null when the gate does not apply: no review_required, or no pull request on
// a transition that does not demand one. That is the normal path for almost every job.
async function reviewRefusal(
  env: Env,
  agent: Agent,
  now: Date,
  action: string,
  id: string,
  resultRef: string | null,
  // WHAT THIS TRANSITION OWES THE REVIEWER. `complete` hands the work on, so it must
  // name a pull request and carry an APPROVE; `block` and `fail` do not close the work
  // out and may legitimately have nothing to review. See reviewGate for the whole
  // rule, which is stated there so both call sites cannot describe different ones.
  opts: { requirePullRequest?: boolean; candidateRefs?: readonly (string | null | undefined)[] } = {}
): Promise<JobResult | null> {
  const current = await readJob(env.DB, id);
  if (!current) return null;
  // The reference this call is about, not only the one already stored: a driver
  // completing with the pull request it just opened has it in its arguments.
  const ref = resultRef ?? current.result_ref;
  let outcome: ReviewOutcome | null;
  try {
    outcome = await reviewGate(env, { namespace: current.namespace, review_required: current.review_required, result_ref: ref }, opts);
  } catch (err) {
    // A GITHUB FAILURE HOLDS THE JOB, it does not wave it through. This gate exists to
    // put a second reader in front of the seat, and an unreadable comment list is not
    // evidence that one looked.
    return refuse(
      action,
      `${id} needs a review and GitHub could not be read: ${err instanceof Error ? err.message : String(err)}. ` +
        `The job stays claimed; try again rather than treating an unreadable review as an approval.`
    );
  }
  if (outcome === null || outcome.kind === "proceed") return null;

  if (outcome.kind === "waiting") {
    return refuse(action, `${id} is ${outcome.reason} The job stays claimed and its lease keeps running.`);
  }


  // CHANGES and BLOCK both MOVE the job, so neither is a plain refusal: the row has to
  // record what the reviewer said, or the next reader sees a job that stalled for no
  // stated reason.
  const { review } = outcome;
  const said = review.said ? ` ${review.said}` : "";
  if (outcome.kind === "rework") {
    // THE CAP IS CHECKED BEFORE THE CORRECTION IS SPENT, so the loop it bounds is
    // actually bounded. It counted correctly and stopped nothing: the rework path
    // always incremented and always left the job claimed, so a third CHANGES spent a
    // third correction and sent the work back again, and the only place the ceiling
    // was enforced was `resume`, which this path never touches. A reviewer and a
    // driver disagreeing forever is precisely the loop the cap exists for, and the
    // test over it asserted the counter reached 2 rather than that anything stopped
    // (audit 2026-09-13, finding 8).
    //
    // At the cap the job goes to the seat instead, through the ordinary block path, so
    // it carries the reviewer's objection and the gate counter behaves as it does for
    // any other block. fromReview stops blockJob consulting the review that produced
    // it and recursing.
    const spentOnWork = await correctionsForWork(env.DB, current.namespace, current.title);
    if (atCorrectionCap(spentOnWork)) {
      return blockJob(env, agent, now, id, {
        reason:
          `review by ${review.by}: CHANGES.${said} This is correction ${spentOnWork + 1} against this work, past the cap of ${CORRECTION_CAP}: ` +
          `${RETRY_CAP_REASON}. The reviewer and the driver have not converged, so what happens next is a person's call rather than another round.`,
        fromReview: true,
      });
    }
    // BACK TO THE DRIVER, and it spends a correction from the same budget the retry
    // cap bounds. A review sending work round forever is the loop that cap exists for,
    // and counting it separately would exempt it.
    const summary = `review by ${review.by}: CHANGES.${said}`;
    const won = await env.DB.prepare(
      `UPDATE jobs SET result_summary = ?2, corrections_count = corrections_count + 1, updated_at = ?3
       WHERE id = ?1 AND status = 'claimed' AND claimed_by = ?4 RETURNING id`
    )
      .bind(id, summary, now.toISOString(), agent.actor)
      .first<{ id: string }>();
    if (!won) return refuse(action, `${id} moved between reading it and recording the review. Ask again.`);
    const job = (await readJob(env.DB, id)) as JobRow;
    await env.DB.batch([
      ...(await mirrorStatements(env.DB, job, "job-review-changes", agent.actor)),
      auditStatement(env.DB, agent.actor, "job-review-changes", job, {
        verdict: review.verdict,
        by: review.by,
        at: review.at,
        corrections_count: job.corrections_count,
      }),
    ]);
    return { ok: false, action, job, refusal: `${summary} The job stays claimed: fix it and hand it on again. This spent a correction (${job.corrections_count} of ${CORRECTION_CAP}).` };
  }

  // HALT. Blocked for the seat, with the objection as the reason, through the ordinary
  // block path so the gate counter and the mirror document behave exactly as they do
  // for any other block.
  return blockJob(env, agent, now, id, { reason: `review by ${review.by}: BLOCK.${said}`, fromReview: true });
}

/**
 * Every skill id the caller named, checked against the table.
 *
 * REFUSED, NOT IGNORED. A driver that names a skill which does not exist has either
 * a stale id or a typo, and silently dropping it would record "offered nothing" for a
 * run that was offered something. That is the one way the offered-to-used rate can be
 * wrong without anybody writing a wrong number. Returns the refusal, or null.
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

// USED MUST BE A SUBSET OF OFFERED. A skill used but never offered did not come from
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
  // BEFORE THE WRITE, because the outcome row this call produces cannot be corrected
  // afterwards. Measured twice on 2026-09-11: result_ref and evidence swallowed into
  // the summary, and the row recorded nothing.
  const swallowed = swallowedParamTag(args.result_summary);
  if (swallowed) return refuse("complete", swallowedTagRefusal("result_summary", swallowed));
  // THE ONE TRANSITION THAT HANDS WORK ON. It must name a pull request and carry an
  // APPROVE from an actor that may review; evidence.prs counts as naming it, because a
  // driver that reported its work there and a document key in result_ref had, before
  // this, escaped the gate entirely.
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
  // THE GATE IS CONSULTED HERE TOO, and its absence was the third way out of a review.
  // `complete` was gated and `block` was gated; `fail` was not, so a driver holding a
  // CHANGES it did not want could close the job as failed and leave the pull request
  // sitting there for the seat to find and merge. It does NOT demand a pull request,
  // because work that genuinely could not be done has none.
  const review = await reviewRefusal(env, agent, now, "fail", id, null);
  if (review) return review;
  const strayOnFail = usedNotOffered(skills);
  if (strayOnFail) return refuse("fail", strayOnFail);
  const unknownOnFail = await unknownSkills(env.DB, skills);
  if (unknownOnFail) return refuse("fail", unknownOnFail);
  return holderTransition(env, agent, now, "fail", id, { status: "failed", result_summary: reason, lease_expires: null, skills });
}

// BLOCKED CARRIES THE EXACT COMMAND. A job that hit a gate is not a failure, it is
// work waiting on a human, and the thing the human needs is the command to run, not
// a description of the situation. The console shows these.
// THE SEAT STEPPING IN, on a job it does not hold.
//
// Every other transition keys on `claimed_by = <caller>`, which is what stops two
// drivers treading on each other. That rule leaves no way to close a job whose driver
// is gone: the machine was turned off, the session died, the work was superseded from
// a chat. The lease expiry returns a claimed job to the queue, and a job stuck in a
// state nobody will finish then sits there being counted.
//
// ADMIN ONLY, and that is the same reasoning resume already carries: "the seat that
// approves is routinely not the session that blocked". `agent.admin` is true for the
// OAuth admin session and a legacy write key and is false for every minted agent, so
// a driver cannot fail another driver's job, which is the thing this must not become.
//
// It refuses a job that is already finished rather than rewriting one, and it says so
// rather than reporting a no-op as success. Keyed UPDATE with RETURNING, and the
// mirror and the audit row ride in the same batch as every other transition.
export async function adminFailJob(env: Env, agent: Agent, now: Date, id: string, reason: string): Promise<JobResult> {
  if (!agent.admin) {
    return refuse(
      "admin-fail",
      `${agent.actor} may only fail a job it holds. Failing somebody else's job is the administrator's call, and a minted agent is deliberately not the administrator.`
    );
  }
  if (!reason?.trim()) return refuse("admin-fail", "fail needs a reason. A failed job with no reason is one nobody can retry or rule on.");
  const won = await env.DB.prepare(
    `UPDATE jobs SET status = 'failed', result_summary = ?3, lease_expires = NULL, updated_at = ?2
     WHERE id = ?1 AND status IN ('queued', 'claimed', 'blocked') RETURNING id`
  )
    .bind(id, now.toISOString(), reason)
    .first<{ id: string }>();
  if (!won) {
    const current = await readJob(env.DB, id);
    if (!current) return refuse("admin-fail", `no job ${id}.`);
    return refuse("admin-fail", `${id} is already ${current.status}; there is nothing to fail.`);
  }
  const job = (await readJob(env.DB, id)) as JobRow;
  const statements = [
    ...(await mirrorStatements(env.DB, job, "job-admin-fail", agent.actor)),
    auditStatement(env.DB, agent.actor, "job-admin-fail", job, { status: job.status, reason, held_by: job.claimed_by }),
  ];
  // THE OTHER WAY A JOB REACHES A TERMINAL STATE, and it gets a row for the same
  // reason `fail` does: a job the seat had to close because its driver never came
  // back is exactly the kind of ending the record should show.
  //
  // ONLY WHEN SOMEBODY HELD IT. A queued job the seat cancelled was never worked, so
  // there is no agent to attribute it to, and inventing one would put a failure on a
  // credential that had not touched the job. There is no evidence argument here
  // either: the seat calling this did not do the work and cannot report on it.
  if (job.claimed_by) {
    const verdict = await verifyEvidence(env, job.namespace, undefined);
    statements.push(outcomeStatement(env.DB, outcomeFrom(job, verdict, now)));
  }
  await env.DB.batch(statements);
  return { ok: true, action: "admin-fail", job };
}

// ---- supersede -----------------------------------------------------------------
//
// THE SEAT REPLACING A JOB BEFORE ANY WORK WAS DONE ON IT: a corrected or reposted
// body, a reorder, a withdrawal. Until this existed the only way to close such a job
// was to claim it and fail it, so the history carried dozens of failures that never
// happened, each with a summary saying so and a status saying otherwise.
//
// NO OUTCOME ROW, NO PULL REQUEST ROWS, NO ATTRIBUTION. Nothing was attempted, so
// there is nothing to record against a driver or a skill, and a row here would put a
// failure on a credential that did no work.
//
// WHEN IT IS ALLOWED. From `queued`, by any caller that may write the job's
// namespace: nobody holds it. From `claimed`, only while the row records no work
// (no gate hit, no resume, no correction, no result_ref), and only by the holder or
// the seat. The seat is identified the way resume identifies it, by admin or
// can_merge: src/agents-schema.ts says kind is descriptive and not authorizing.
// Everything later than that is ended by `fail` or the console's admin fail, which
// is what they are for.
//
// THE WHOLE RULE IS IN THE ONE KEYED UPDATE. The checks before it only choose the
// refusal message; a driver that hits a gate between the read and the write leaves
// no row to supersede, rather than being superseded out from under its work.

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
    const isSeat = agent.admin || agent.scopes.flags.can_merge;
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
  const won = await env.DB.prepare(
    `UPDATE jobs SET status = 'superseded', result_summary = ?2, lease_expires = NULL, updated_at = ?3
     WHERE id = ?1 AND (status = 'queued' OR (status = 'claimed' AND claimed_by = ?4 AND blocked_count = 0
       AND resumed_count = 0 AND corrections_count = 0 AND result_ref IS NULL)) RETURNING id`
  )
    .bind(id, summary, now.toISOString(), current.claimed_by)
    .first<{ id: string }>();
  if (!won) {
    const moved = await readJob(env.DB, id);
    const work = moved ? workRecorded(moved) : null;
    return refuse(
      "supersede",
      `${id} changed between reading it and superseding it: it is now ${moved?.status ?? "gone"}${moved?.claimed_by ? `, held by ${moved.claimed_by}` : ""}${work ? `, and ${work}` : ""}. Nothing was written.`
    );
  }
  const job = (await readJob(env.DB, id)) as JobRow;
  await env.DB.batch([
    ...(await mirrorStatements(env.DB, job, "job-superseded", agent.actor)),
    auditStatement(env.DB, agent.actor, "job-superseded", job, {
      reason,
      replaced_by: replacedBy,
      from: current.status,
      held_by: current.claimed_by,
    }),
  ]);
  return { ok: true, action: "supersede", job };
}

// THE ONE SPELLING OF THE RESUME INSTRUCTION. blockJob writes it into the summary and
// commandFromSummary reads it back out, so the format cannot drift between the two.
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
  // THE GATE IS CONSULTED HERE TOO, because a gate on `complete` alone is one a
  // driver bypasses by blocking instead. `fromReview` is set by the halt path below,
  // which reaches this function to do the blocking: without it a BLOCK verdict would
  // consult the review that produced it and recurse.
  if (!args.fromReview) {
    const review = await reviewRefusal(env, agent, now, "block", id, null);
    if (review) return review;
  }
  const summary = args.command ? `${args.reason}\n\n${RESUME_MARKER}\n\n    ${args.command}` : args.reason;
  // THE CAP IS APPLIED WHERE THE BLOCK IS WRITTEN, so a capped job says so in the
  // one field every reader already looks at: the console prints result_summary, the
  // driver reads it to continue, and a human deciding reads it there too. The budget
  // is read before the transition, because the transition is what makes this block
  // the third one.
  const current = await readJob(env.DB, id);
  const capped = current !== null && atCorrectionCap(await correctionsForWork(env.DB, current.namespace, current.title));
  return holderTransition(env, agent, now, "block", id, {
    status: "blocked",
    result_summary: capped ? cappedSummary(summary) : summary,
    lease_expires: null,
    bumpBlocked: true,
  });
}

// ---- resume --------------------------------------------------------------------
//
// A GATE IS A PAUSE, NOT AN ENDING. Before this, `blocked` was terminal: the only
// way into a claim was from `queued`, so a job the driver stopped at a gate could
// never be picked back up. The human ran the command, the work landed, and the row
// still described the state before the gate, because `claim` refuses anything that
// is not queued. Measured 2026-09-10 on job_1b957927a714, which shipped a commit and
// four pull requests while its own row said the push had not happened.
//
// THE SIGNATURE IS CHECKED AGAIN HERE, and that is not belt-and-braces. `claim`
// verifies the body before handing a job to a driver; a blocked job then sits in the
// table for as long as a human takes, which is exactly the window in which a row
// could be edited. Resume hands that body back to a session holding local shell and
// repo credentials, so it re-verifies on the same terms and marks a tampered job
// failed rather than returning it.
//
// WHO MAY RESUME: any write-grant caller, which the tool layer has already checked
// before this runs. Deliberately not restricted to the original claimer: the point
// is that a HUMAN approved something, and the seat that approves is routinely not
// the session that blocked. The reason is required and lands in the audit row, so
// what was approved is recorded rather than implied.
//
// WHO HOLDS IT AFTERWARDS: the driver that blocked it, not the caller that resumed
// it (ruled 2026-09-16). A blocked row keeps claimed_by, and the lease goes back to
// that claimant. Until then the resumer took the lease, so the seat's resume of
// job_4918f3519cba left the job claimed by the seat, which has no shell to finish it
// with, and the job had to be failed and posted again. `take` is the explicit way for
// a resumer to acquire the job instead, and it runs every check a claim runs.
export interface ResumeOptions {
  // THE PRE-APPROVED GATE (autonomy arc part 2). When set, this resume is approved on
  // the signed gate policy rather than on a human having said yes, and the value is
  // the policy version the caller read. The command the job blocked on is matched
  // against the policy classes and the resume is REFUSED when it matches none, so this
  // narrows what the caller may do on its own rather than widening it.
  approvedByPolicy?: string;
  // The resumer acquires the job rather than returning it to the driver that blocked.
  take?: boolean;
  // This resume sends the work back to be CORRECTED, so it spends from the retry
  // cap's budget. A plain resume does not (ruled 2026-09-16): job_466d6472511e reached
  // the cap on three ordinary pushes, none of which corrected anything.
  correction?: boolean;
  // THE SEAT'S FULL NOTE, beside the one-line reason. Recorded in the audit row as
  // `note` and handed on whole in resume_note and the mirror document.
  note?: string;
}

// WHAT A DRIVER MAY APPROVE FOR ITSELF (ruled 2026-09-16). Pushing its own branch and
// opening its own pull request. Not a migration: the ruling keeps migrations a human
// gate, so `additive_migration` stays the seat's to approve. The classes and the
// never list are the policy's own; this only narrows which of them a driver may use.
const DRIVER_SELF_APPROVED: readonly GateClass[] = ["push_branch", "open_pr"];

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
  if (!ACTOR_SHAPE.test(actor)) {
    return refuse("resume", `'${actor}' is not a caller identity this queue can hold a lease for. A claim is recorded against a github: login, an opkey: fingerprint, or an agent: name.`);
  }
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

  // The claimant the lease goes to. A blocked row with no claimant (none should
  // exist, since block keys on claimed_by) goes to the caller, as before.
  const holder = take || !current.claimed_by ? actor : current.claimed_by;
  const acquiring = holder === actor;

  // The same one-claim-per-caller rule the claim path runs on, for the same reason,
  // asked of whoever ends up HOLDING the lease: a driver holding two has abandoned one.
  const held = await env.DB.prepare("SELECT * FROM jobs WHERE status = 'claimed' AND claimed_by = ?1 LIMIT 1")
    .bind(holder)
    .first<JobRow>();
  if (held) {
    return refuse(
      "resume",
      `${holder} already holds ${held.id} ('${held.title}' in ${held.namespace}), leased until ${held.lease_expires}. ` +
        (acquiring ? "Finish it before resuming another." : `${id} stays blocked until that driver is free, or resume it with take.`)
    );
  }

  // RESUME IS A CLAIM WHEN THE CALLER ACQUIRES THE JOB, so it asks the same scope
  // question a claim asks: a driver that could not have claimed this job must not
  // acquire it by resuming it. When the job goes back to its own claimant, that
  // claimant already passed these checks at its claim, and the resumer is not taking
  // anything.
  const corrupt = corruptRequirement(current);
  if (corrupt) {
    return refuse("resume", `${id} has a corrupt requirement: ${corrupt}. It stays blocked; a requirement that cannot be read is not the same as none.`);
  }
  // THE NAMESPACE IS ASKED EITHER WAY. A resume that returns the job to its own
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

  // THE RETRY CAP, CHECKED BEFORE ANYTHING IS SPENT. A job sent back twice already
  // is one where each further correction has stopped being progress, and what to do
  // next belongs to a person. An ADMIN is that person arriving, so an admin resume
  // passes and does not spend the budget.
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
    await env.DB.prepare(
      `UPDATE jobs SET status = 'failed', result_summary = ?2, lease_expires = NULL, updated_at = ?3
       WHERE id = ?1 AND status = 'blocked' RETURNING id`
    )
      .bind(id, verdict.reason, now.toISOString())
      .first<{ id: string }>();
    const failed = { ...current, status: "failed" as const, result_summary: verdict.reason, updated_at: now.toISOString() };
    await env.DB.batch([
      ...(await mirrorStatements(env.DB, failed, "job-signature-refused", actor)),
      auditStatement(env.DB, actor, "job-signature-refused", failed, { reason: verdict.reason, at: "resume" }),
    ]);
    return refuse("resume", `${id} failed its signature check and has been marked failed: ${verdict.reason}`);
  }

  // THE POLICY CHECK RUNS BEFORE THE LEASE IS TAKEN, so a refusal leaves the job
  // blocked exactly as it was rather than claimed by a caller whose approval did not
  // hold.
  let policyMatch: { klass: string; detail: string; version: string } | null = null;
  if (approvedByPolicy !== undefined) {
    // APPROVING IS THE SEAT'S ACT, and nothing checked who was doing it. `resume` takes
    // the write grant every driver holds, so any driver could pass the policy version
    // and approve its own blocked command (audit 2026-09-13, finding 12). The classes
    // exclude deploys, secrets and merges, so the reachable worst case was a driver
    // pushing its own branch and opening its own pull request, which is what it was
    // going to ask for anyway. It is still wrong: the policy's whole shape is "what the
    // SEAT may approve alone", and a check nobody performs makes the noun decorative.
    //
    // THE SEAT IS IDENTIFIED BY can_merge, NOT BY kind. src/agents-schema.ts says kind
    // is descriptive and not authorizing, and the auto-merge tick using it that way is
    // recorded as a defect rather than a precedent. can_merge is the flag the seat
    // holds and no driver does, so it is the credential fact that separates them.
    //
    // A DRIVER MAY APPROVE ITS OWN BRANCH PUSH AND PULL REQUEST (ruled 2026-09-16), and
    // nothing wider: only on a job it blocked itself and still holds, and only when
    // every class the command matched is in DRIVER_SELF_APPROVED. The classification is
    // still the Worker's, through the same approveByPolicy call the seat's approval
    // makes, so the never list still runs first and a force push still waits.
    const isSeat = agent.admin || agent.scopes.flags.can_merge;
    if (!isSeat && (current.claimed_by !== actor || take)) {
      return refuse(
        "resume",
        `${id} cannot be approved by ${agent.actor} on the gate policy alone. A driver may approve only a job it blocked itself, ` +
          `and ${id} was blocked by ${current.claimed_by ?? "nobody on record"}. Approving somebody else's blocked command is the seat's act, ` +
          `and this caller holds neither the admin identity nor can_merge.`
      );
    }
    const command = commandFromSummary(current.result_summary);
    // THE DRIVER'S NARROWER LIST IS CHECKED BEFORE THE POLICY IS, over the same
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
    const verdict = await approveByPolicy(env, approvedByPolicy, command, async (path) => {
      try {
        const file = await readRepoFile(env, current.namespace, path);
        return (file as { content?: string }).content ?? null;
      } catch {
        return null;
      }
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

  const expires = leaseUntil(now);
  // ONLY A CORRECTION SPENDS THE BUDGET, and never an admin's. The 0 or 1 is BOUND
  // rather than interpolated for the same reason bumpBlocked is: the statement stays
  // one static string that the source guards can read and the query-plan test can
  // EXPLAIN.
  //
  // claimed_at IS NOT TOUCHED. It is the first claim, and duration_minutes measures
  // from it (ruled 2026-09-16), so a job that waited at a gate is measured over its
  // whole working life rather than over the stretch after its last resume.
  const spend = correction && !agent.admin ? 1 : 0;
  const won = await env.DB.prepare(
    `UPDATE jobs SET status = 'claimed', claimed_by = ?2, lease_expires = ?4,
       resumed_count = resumed_count + 1, corrections_count = corrections_count + ?5, updated_at = ?3
     WHERE id = ?1 AND status = 'blocked' RETURNING id`
  )
    .bind(id, holder, now.toISOString(), expires, spend)
    .first<{ id: string }>();
  if (!won) {
    return refuse("resume", `${id} left blocked between reading it and resuming it. Ask again.`);
  }

  const job = (await readJob(env.DB, id)) as JobRow;
  const resumeNote: ResumeNote = {
    reason,
    ...(fullNote ? { note: fullNote } : {}),
    by: actor,
    at: now.toISOString(),
    ...(policyMatch ? { approved_by_policy: policyMatch.version, policy_class: policyMatch.klass } : {}),
    ...(spend ? { correction: true as const } : {}),
  };
  await env.DB.batch([
    ...(await mirrorStatements(env.DB, job, "job-resumed", actor, resumeNote)),
    auditStatement(env.DB, actor, "job-resumed", job, {
      approved: reason,
      ...(fullNote ? { note: fullNote } : {}),
      held_by: holder,
      ...(take ? { taken: true } : {}),
      ...(spend ? { correction: true } : {}),
      lease_expires: expires,
      resumed_count: job.resumed_count,
      corrections_count: job.corrections_count,
      ...(agent.admin ? { cap_lifted_by_admin: true } : {}),
      // WHICH CLASS MATCHED, not merely that one did. A row saying "approved by policy"
      // cannot be checked against the policy afterwards; one naming the class and what
      // it matched can.
      ...(policyMatch
        ? { approved_by_policy: policyMatch.version, policy_class: policyMatch.klass, policy_detail: policyMatch.detail }
        : {}),
    }),
  ]);
  return { ok: true, action: "resume", job, resume_note: resumeNote };
}

// ---- the lease sweep ----------------------------------------------------------
//
// Run by the five-minute improve tick. A claim whose lease has expired goes back to
// queued, so a driver that died holds a job for at most JOB_LEASE_SECONDS rather
// than forever. RETURNING, so the tick reports what it actually moved.
//
// The mirror documents are rewritten too, one batch per job: a job that reads
// "claimed by a session that is gone" in brief is the state this sweep exists to
// clear, and leaving the document behind would keep telling that story.
export async function expireJobLeases(env: Env, now: Date): Promise<{ requeued: string[] }> {
  const stamp = now.toISOString();
  const { results } = await env.DB.prepare(
    `UPDATE jobs SET status = 'queued', claimed_by = NULL, claimed_at = NULL, lease_expires = NULL, updated_at = ?1
     WHERE status = 'claimed' AND lease_expires IS NOT NULL AND lease_expires < ?1 RETURNING id`
  )
    .bind(stamp)
    .all<{ id: string }>();
  const requeued = (results ?? []).map((r) => r.id);
  for (const id of requeued) {
    const job = await readJob(env.DB, id);
    if (!job) continue;
    await env.DB.batch([
      ...(await mirrorStatements(env.DB, job, "job-lease-expired", "improve-loop")),
      auditStatement(env.DB, "improve-loop", "job-lease-expired", job, { returned_to: "queued" }),
    ]);
  }
  return { requeued };
}

// ---- the improve_status block --------------------------------------------------
//
// Counted per namespace, plus what a human has to look at: the blocked jobs, with
// the command each is waiting on. Blocked is the only status whose ROWS come back
// rather than a count, because a count of blocked jobs tells nobody what to run,
// and the console shows exactly these.
//
// done_today rather than done: a lifetime total only ever goes up and stops being
// information. What the seat wants to know is whether the queue moved today.
export interface JobsSummary {
  queued: number;
  claimed: number;
  blocked: number;
  done_today: number;
  // blocked_times and resumed say how often this job has hit a gate and how often a
  // human sent it back. A job on its third gate reads differently from one that has
  // been stuck at the same gate since it was posted, and the count is what tells
  // them apart.
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
  // substr on the stored timestamp rather than a range: updated_at is written as an
  // ISO string by this module and as datetime('now') by the table default, and the
  // two agree on the first ten characters and nothing else.
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
