import type { Env } from "./env";
import { improveDocStatements, priorDoc } from "./improve-state";
import { checkJobText, type SignatureCheck } from "./job-signing";
import { jobDocPath, isTerminalJobStatus, type JobRow } from "./jobs-schema";
import { auditStatement } from "./store-guards";

// The records a job transition writes beside its UPDATE: the mirror document, the
// audit row, and the latest resume note read back from that audit row.

// What the last resume approved, handed to whoever holds the job next.
//
// The reason a resume takes is written to the audit row, and no tool returns audit
// params to a driver, so without this a driver picking a resumed job back up could not
// read what the seat had approved and would have to ask again. The audit row stays the
// one record; this reads it back.
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
  // Whether the approval is the one the resume wrote (src/job-signing.ts). A note whose
  // signature does not match is withheld: its text is replaced and its full note
  // dropped, so nothing changed after the fact reaches a driver as an approval.
  signature: SignatureCheck;
}

// Who may read a note, and with what: the database and the signing secret.
type NoteEnv = Pick<Env, "DB" | "IMPROVE_SCORE_SECRET">;

/** The fields a resume note's signature covers, in one place for the writer and reader. */
export function resumeNoteFields(approved: string, note: string | null, by: string): Record<string, string | null> {
  return { approved, note, by };
}

const WITHHELD = "WITHHELD: this approval's signature does not match, so it was changed after the resume wrote it. Do not act on it; ask the seat.";

// Served by audit_log_doc (namespace, path, id DESC), the index every job audit row
// already falls under because it is written against the job's mirror path.
type NoteRow = { actor: string | null; params: string | null; at: string };

// One audit row as the note it recorded, its signature checked, or null when the row is
// not a readable resume (no params, not JSON, no approved text).
async function noteFromRow(env: NoteEnv, job: Pick<JobRow, "id">, row: NoteRow): Promise<ResumeNote | null> {
  if (!row.params) return null;
  let params: Record<string, unknown>;
  try {
    params = JSON.parse(row.params) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof params.approved !== "string") return null;
  const by = row.actor ?? "(unknown)";
  const note = typeof params.note === "string" ? params.note : null;
  const signature = await checkJobText(
    env.IMPROVE_SCORE_SECRET,
    "resume-note",
    job.id,
    resumeNoteFields(params.approved, note, by),
    typeof params.sig === "string" ? params.sig : null
  );
  if (signature === "mismatch") return { reason: WITHHELD, by, at: row.at, signature };
  return {
    reason: params.approved,
    ...(note !== null ? { note } : {}),
    by,
    at: row.at,
    signature,
    ...(typeof params.approved_by_policy === "string" ? { approved_by_policy: params.approved_by_policy } : {}),
    ...(typeof params.policy_class === "string" ? { policy_class: params.policy_class } : {}),
    ...(params.correction === true ? { correction: true as const } : {}),
  };
}

const NOTE_SQL = "SELECT actor, params, at FROM audit_log WHERE namespace = ?1 AND path = ?2 AND action = 'job-resumed' ORDER BY id DESC LIMIT ?3";

export async function latestResumeNote(
  env: NoteEnv,
  job: Pick<JobRow, "id" | "namespace" | "resumed_count">
): Promise<ResumeNote | null> {
  if (!job.resumed_count) return null;
  const row = await env.DB.prepare(NOTE_SQL).bind(job.namespace, jobDocPath(job.id), 1).first<NoteRow>();
  return row ? noteFromRow(env, job, row) : null;
}

// Every resume note a driver is handed, together, and no more than this many bytes of
// them: a job resumed fifteen times (job_5765103c658f, 2026-09-26) carried its PR order
// and rulings in the early notes, which "the latest only" lost.
const RESUME_NOTES_MAX_BYTES = 64 * 1024;
// Rows read for it, so one job with a very long history is one bounded read.
const RESUME_NOTES_MAX_ROWS = 200;

export interface ResumeNotes {
  // Newest first. Each note's own signature is checked; one that does not match is
  // withheld, as the newest one is.
  notes: ResumeNote[];
  // Resumes the job recorded that this answer does not carry: older ones past the byte
  // cap or the row cap, or an audit row that cannot be read as a note.
  dropped: number;
}

/** Every resume note for a job, newest first, at most RESUME_NOTES_MAX_BYTES of them (the
 *  oldest dropped and counted). The newest is first and is what `latestResumeNote` returns. */
export async function resumeNotes(env: NoteEnv, job: Pick<JobRow, "id" | "namespace" | "resumed_count">): Promise<ResumeNotes> {
  if (!job.resumed_count) return { notes: [], dropped: 0 };
  const { results } = await env.DB.prepare(NOTE_SQL).bind(job.namespace, jobDocPath(job.id), RESUME_NOTES_MAX_ROWS).all<NoteRow>();
  const notes: ResumeNote[] = [];
  let bytes = 0;
  for (const row of results ?? []) {
    const note = await noteFromRow(env, job, row);
    if (!note) continue;
    const size = new TextEncoder().encode(JSON.stringify(note)).length;
    // The newest note is always returned, whatever its size: it is the approval a driver
    // acts on, and a cap that hid it would be the loss this reads back to prevent.
    if (notes.length > 0 && bytes + size > RESUME_NOTES_MAX_BYTES) break;
    notes.push(note);
    bytes += size;
  }
  return { notes, dropped: Math.max(0, job.resumed_count - notes.length) };
}

// The document a job mirrors to. The prompt is the SIGNED body, byte for byte, so a
// driver that reads the document rather than the row still verifies the same bytes.
function renderJobDoc(job: JobRow, notes: ResumeNote[], dropped = 0): string {
  const note = notes[0] ?? null;
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
  // Only once it has happened, so a job that never hit a gate carries no line of zeroes.
  if (job.blocked_count > 0) lines.push(`- gates hit: ${job.blocked_count}, resumed: ${job.resumed_count}`);
  // The brief carries open job documents, so this line is how brief hands the
  // approval to a driver.
  if (note) lines.push(`- last resume, by ${note.by} at ${note.at}${note.signature === "verified" ? "" : ` (${note.signature})`}: ${note.reason}`);
  if (job.result_summary) lines.push(`- result: ${job.result_summary}`);
  if (job.result_ref) lines.push(`- result ref: ${job.result_ref}`);
  // The full note as its own block after the status lines, untruncated: a driver
  // reading the brief needs every ruling, not the first line of them.
  if (note?.note) lines.push("", "## The last resume's note", "", note.note);
  // Every earlier resume, newest first: an approval given at one resume is still the
  // approval after the next (resumeNotes).
  if (notes.length > 1) {
    lines.push("", "## Earlier resumes", "");
    for (const earlier of notes.slice(1)) {
      lines.push(`- by ${earlier.by} at ${earlier.at}${earlier.signature === "verified" ? "" : ` (${earlier.signature})`}: ${earlier.reason}`);
      if (earlier.note) lines.push("", earlier.note, "");
    }
  }
  if (dropped > 0) lines.push("", `(${dropped} older resume${dropped === 1 ? "" : "s"} not shown.)`);
  lines.push("", "## The prompt", "", job.body);
  return lines.join("\n");
}

// `note` is passed by resume, whose audit row is written in the same batch as this
// mirror and so cannot be read back yet. Every other transition reads it.
export async function mirrorStatements(env: NoteEnv, job: JobRow, action: string, actor: string, note?: ResumeNote) {
  const path = jobDocPath(job.id);
  const prior = await priorDoc(env.DB, job.namespace, path);
  // The passed note is the resume being written in this batch, so it is not in the audit
  // log yet: it leads, and the notes read back are the earlier ones.
  const history = await resumeNotes(env, job);
  const notes = note ? [note, ...history.notes] : history.notes;
  return improveDocStatements(env.DB, {
    namespace: job.namespace,
    path,
    title: `Job: ${job.title}`,
    body: renderJobDoc(job, notes, history.dropped),
    type: "task",
    // Closed on a finished row, and `failed` is as finished as `done`: a failed job's
    // mirror left active would keep brief carrying it as open work.
    // isTerminalJobStatus is the one list of finished statuses.
    status: isTerminalJobStatus(job.status) ? "closed" : "active",
    tags: "jobs",
    prior,
    action,
    actor,
  });
}

// A job's audit row is addressed to its mirror document and carries the job id.
export function jobAudit(db: D1Database, actor: string, action: string, job: JobRow, params: Record<string, unknown>) {
  return auditStatement(db, actor, action, job.namespace, jobDocPath(job.id), { job_id: job.id, ...params });
}
