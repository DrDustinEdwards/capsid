import { improveDocStatements, priorDoc } from "./improve-state";
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
}

// Served by audit_log_doc (namespace, path, id DESC), the index every job audit row
// already falls under because it is written against the job's mirror path.
export async function latestResumeNote(
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
  // Only once it has happened, so a job that never hit a gate carries no line of zeroes.
  if (job.blocked_count > 0) lines.push(`- gates hit: ${job.blocked_count}, resumed: ${job.resumed_count}`);
  // The brief carries open job documents, so this line is how brief hands the
  // approval to a driver.
  if (note) lines.push(`- last resume, by ${note.by} at ${note.at}: ${note.reason}`);
  if (job.result_summary) lines.push(`- result: ${job.result_summary}`);
  if (job.result_ref) lines.push(`- result ref: ${job.result_ref}`);
  // The full note as its own block after the status lines, untruncated: a driver
  // reading the brief needs every ruling, not the first line of them.
  if (note?.note) lines.push("", "## The last resume's note", "", note.note);
  lines.push("", "## The prompt", "", job.body);
  return lines.join("\n");
}

// `note` is passed by resume, whose audit row is written in the same batch as this
// mirror and so cannot be read back yet. Every other transition reads it.
export async function mirrorStatements(db: D1Database, job: JobRow, action: string, actor: string, note?: ResumeNote) {
  const path = jobDocPath(job.id);
  const prior = await priorDoc(db, job.namespace, path);
  const resumeNote = note ?? (await latestResumeNote(db, job));
  return improveDocStatements(db, {
    namespace: job.namespace,
    path,
    title: `Job: ${job.title}`,
    body: renderJobDoc(job, resumeNote),
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
