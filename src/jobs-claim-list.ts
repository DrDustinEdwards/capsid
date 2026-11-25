// Listing jobs, without bodies unless one is asked for.
import type { Env } from "./env";
import { JOBS_ROWS_MAX, startedNotice, type JobRow, type JobStatus } from "./jobs-schema";
import { resumeNotes } from "./jobs-mirror";
import { type JobResult } from "./jobs-transition";

// List never carries a body unless one job was asked for by a writer: a body is the signed prompt
// a driver executes, and selecting every column would let a read grant read every queued prompt.
// The columns are named so the body never leaves D1 for a list;
const JOB_LIST_COLUMNS = [
  "id",
  "namespace",
  "title",
  "status",
  "priority",
  "posted_by",
  "claimed_by",
  "gate_required",
  "blocked_count",
  "resumed_count",
  "created_at",
  "updated_at",
  "result_summary",
  "kind",
  "model_recommended",
  "effort_recommended",
  "started_at",
  "started_by",
  "parked_until",
] as const;

export type JobListRow = Pick<JobRow, (typeof JOB_LIST_COLUMNS)[number]>;

export async function listJobs(
  env: Env,
  args: { namespace?: string; status?: JobStatus; id?: string },
  opts: { withBody?: boolean } = {},
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
    `SELECT ${[...JOB_LIST_COLUMNS, ...(withBody ? ["body"] : [])].join(", ")} FROM jobs ${clause} ORDER BY priority DESC, created_at ASC LIMIT ?${binds.length}`,
  )
    .bind(...binds)
    .all<JobListRow>();
  const rows = results ?? [];
  // One extra row asked for, so "exactly the page" is distinguishable from "there are more". Same
  // shape as every other bounded read here.
  const truncated = rows.length > JOBS_ROWS_MAX;
  // One named job carries its latest resume note. Not every row of a wide list, which would cost one
  // read per resumed job.
  const listNotes = args.id && rows.length === 1 ? await resumeNotes(env, rows[0]) : null;
  const listNote = listNotes?.notes[0] ?? null;
  const listStarted = args.id && rows.length === 1 ? startedNotice(rows[0]) : null;
  return {
    ok: true,
    action: "list",
    ...(listStarted ? { started: listStarted } : {}),
    ...(listNote ? { resume_note: listNote } : {}),
    ...(listNotes && listNotes.notes.length > 0 ? { resume_notes: listNotes.notes } : {}),
    ...(listNotes && listNotes.dropped > 0 ? { resume_notes_dropped: listNotes.dropped } : {}),
    jobs: truncated ? rows.slice(0, JOBS_ROWS_MAX) : rows,
    ...(truncated
      ? {
          truncated: true,
          note: `more than ${JOBS_ROWS_MAX} jobs match; narrow by namespace or status.`,
        }
      : {}),
  };
}
