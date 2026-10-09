import type { OfferedSkillWithBody } from "./job-skill-offers";
import type { Env } from "./env";
import type { Agent } from "./agents";
import { JOB_LEASE_SECONDS, missingForRecord, type JobRow } from "./jobs-schema";
import { isMissingRowAbort, requireJobUnchanged } from "./store-guards";
import { loadRecordRows, recordFor } from "./agent-record";
import type { JobOutcomeRow } from "./job-outcomes";
import type { JobListRow } from "./jobs-claim";
import type { OverlapReport } from "./job-overlaps";
import type { JobVersion } from "./jobs-edit";
import { jobAudit, mirrorStatements, type ResumeNote } from "./jobs-mirror";
import { DEFAULT_MAX_CLAIMS, MAX_CLAIMS_CEILING, claimLimit, parseScopes } from "./agents-schema";
import { resolveRepo } from "./github/client";

// What every job transition shares: the result shape, the refusal, the row read, the
// guarded batch every transition commits through, and the checks more than one of
// claim, holder and seat make. The queue's rules are stated in src/jobs.ts.

// claimed_by carries the same shape as audit_log.actor (migrations/0006), so one
// query joins a job to what its driver did. A minted agent speaks that vocabulary as
// `agent:<name>` (agentActor in src/agents-schema.ts), and the name is unique in the
// agents table and never reused, so the string identifies exactly one credential. The
// admin is `access:<email>` on the MCP login since it moved to Cloudflare Access
// (docs/auth.md, 2026-09-27) and `github:<login>` on rows the old console wrote before it moved to Access.
const ACTOR_SHAPE = /^(access:|github:|opkey:|agent:)/;

export function actorShapeRefusal(action: string, actor: string): JobResult | null {
  if (ACTOR_SHAPE.test(actor)) return null;
  return refuse(
    action,
    `'${actor}' is not a caller identity this queue can hold a lease for. A claim is recorded against an access: email, a github: login, an opkey: fingerprint, or an agent: name.`
  );
}

// The jobs a caller holds claimed, oldest claim first. A caller holds at most its claim
// limit (claimLimit, src/agents-schema.ts), one unless the admin raised it. Read up to
// one past the ceiling, so a table holding more than any limit allows still reads as
// full rather than as a short page.
export async function heldClaims(db: D1Database, actor: string): Promise<JobRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM jobs WHERE status = 'claimed' AND claimed_by = ?1 ORDER BY claimed_at, id LIMIT ?2")
    .bind(actor, MAX_CLAIMS_CEILING + 1)
    .all<JobRow>();
  return results ?? [];
}

// The claim limit of the credential behind an actor that is not the caller (a resume
// returning a job to the driver that blocked it): a minted agent's from its row, the
// default for anything else. The caller's own limit is read from its resolved scopes.
export async function claimLimitOf(db: D1Database, actor: string): Promise<number> {
  if (!actor.startsWith("agent:")) return DEFAULT_MAX_CLAIMS;
  const row = await db.prepare("SELECT scopes FROM agents WHERE name = ?1").bind(actor.slice("agent:".length)).first<{ scopes: string }>();
  return row ? claimLimit(parseScopes(row.scopes)) : DEFAULT_MAX_CLAIMS;
}

// A design job writes Capsid documents and changes no repo, so it cannot collide with a
// job on a repo branch. The job's kind is the one field that says so (src/model-routing.ts:
// given at post, or read from a title starting "Design"). A job with no kind yet is not
// design-only: unknown is treated as a repo change.
function isDesignOnly(job: Pick<JobRow, "kind">): boolean {
  return job.kind === "design";
}

// Why a caller cannot take one more job, or null when it can.
//   full:       it already holds as many as its limit allows.
//   repo:       it holds a job on the repo this one would change. One session owns one
//               repo's branch at a time (capsid/conventions.md 2.4), and two jobs on one
//               repo under one credential are two sessions on that repo's branches.
//   unreadable: a repo could not be resolved, so the collision cannot be ruled out.
// A design job on either side is not a collision.
export type ClaimRoom =
  | { kind: "full"; held: JobRow[]; limit: number }
  | { kind: "repo"; held: JobRow; repo: string }
  | { kind: "unreadable"; held: JobRow; problem: string };

async function repoOfNamespace(env: Env, namespace: string): Promise<{ repo: string } | { problem: string }> {
  try {
    return { repo: (await resolveRepo(env, namespace)).full };
  } catch (err) {
    return { problem: err instanceof Error ? err.message : String(err) };
  }
}

export async function claimRoom(env: Env, limit: number, held: JobRow[], job: JobRow): Promise<ClaimRoom | null> {
  const others = held.filter((h) => h.id !== job.id);
  if (others.length >= limit) return { kind: "full", held: others, limit };
  if (isDesignOnly(job)) return null;
  const wanted = await repoOfNamespace(env, job.namespace);
  for (const h of others) {
    if (isDesignOnly(h)) continue;
    const theirs = await repoOfNamespace(env, h.namespace);
    if ("problem" in theirs) return { kind: "unreadable", held: h, problem: theirs.problem };
    if ("problem" in wanted) return { kind: "unreadable", held: h, problem: wanted.problem };
    if (theirs.repo.toLowerCase() === wanted.repo.toLowerCase()) return { kind: "repo", held: h, repo: theirs.repo };
  }
  return null;
}

const heldName = (h: JobRow) => `${h.id} ('${h.title}' in ${h.namespace})`;

/** What a ClaimRoom says about `actor` and `id`, as one clause: "<actor> holds ...". The
 *  claim and resume refusals and the resume's return to the queue all start from it. */
export function claimRoomClause(actor: string, room: ClaimRoom, id: string, opts: { lease?: boolean } = {}): string {
  switch (room.kind) {
    case "full": {
      const names = room.held.map((h) => `${heldName(h)}${opts.lease ? `, leased until ${h.lease_expires}` : ""}`).join("; ");
      return room.limit === DEFAULT_MAX_CLAIMS ? `${actor} holds ${names}` : `${actor} holds ${names}, its limit of ${room.limit} concurrent claims`;
    }
    case "repo":
      return (
        `${actor} holds ${heldName(room.held)} on ${room.repo}, the repo ${id} would change too. One session owns one repo's branch at a time ` +
        `(capsid/conventions.md 2.4), so a second claim must be on another repo or a design job (kind design), which changes no repo`
      );
    case "unreadable":
      return `${actor} holds ${heldName(room.held)}, and whether ${id} would change the same repo cannot be read (${room.problem}), so it is treated as the same repo`;
  }
}

// The seat is identified by admin or can_merge, for supersede and for resume. An
// agent's kind is descriptive and not authorizing (src/agents-schema.ts); can_merge is
// the flag the seat holds and no driver does.
export function callerIsSeat(agent: Agent): boolean {
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
  // The outcome row this transition wrote, returned so the driver sees what the
  // Worker checked rather than assuming its own numbers were taken. `notes` names
  // every verification that could not run, which separates a count nobody checked
  // from a count nobody could check.
  outcome?: { row: JobOutcomeRow; notes: string[] };
  // The latest resume's reason, for a job resumed at least once. See
  // latestResumeNote in src/jobs-mirror.ts.
  resume_note?: ResumeNote;
  // Every resume note, newest first (the newest is resume_note), within a byte cap; and how
  // many the answer leaves out. claim, heartbeat and list for one id (src/jobs-mirror.ts).
  resume_notes?: ResumeNote[];
  resume_notes_dropped?: number;
  // block and complete: the other open pull requests that change the same files as the one
  // this call named, or why that could not be checked (src/job-overlaps.ts). Absent when the
  // call named no pull request of the namespace's repo.
  overlaps?: OverlapReport;
  // claim: the skills this job is offered, bodies inline. See ./job-skill-offers.
  offered_skills?: OfferedSkillWithBody[];
  // claim: the model Capsid recommends for this job, why, and how to follow it
  // (src/model-routing.ts), and a note when the pull request it carries could not be read.
  routing?: Record<string, unknown>;
  routing_note?: string;
  // list view "models": the learning table.
  models?: Record<string, unknown>;
  // edit, and list for one named id to a caller holding write: the versions earlier
  // edits replaced, newest first (src/jobs-edit.ts, migrations/0033).
  versions?: JobVersion[];
}

export function refuse(action: string, refusal: string): JobResult {
  return { ok: false, action, refusal };
}

export const leaseUntil = (now: Date) => new Date(now.getTime() + JOB_LEASE_SECONDS * 1000).toISOString();

// A runner key bound to this job (migrations/0021) is revoked in the same batch as
// every transition that ends the run that held it: done, failed, blocked, superseded,
// and a return to the queue by release or an expired lease. The queue returns are the
// ones the resolver alone does not cover: it accepts a bound key on a queued job for
// the pending-start window, so a key minted less than 20 minutes earlier would claim
// its job again (seat review of #174). For the others this is the record of when the
// key stopped, which `agents` action "list" shows.
export function revokeBoundKeys(db: D1Database, jobId: string): D1PreparedStatement {
  return db.prepare("UPDATE agents SET revoked_at = datetime('now') WHERE job_id = ?1 AND revoked_at IS NULL").bind(jobId);
}

export async function readJob(db: D1Database, id: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<JobRow>();
}

// The one path that fails a job that cannot be handed over: a corrupt requirement or
// a bad signature at claim, a bad signature at resume. The UPDATE, the mirror and the
// audit row are one guarded batch, so they commit only when the row is still as the
// caller read it. Without the guard, a job another driver had claimed meanwhile would
// get a mirror and an audit row saying it failed while its row said claimed. When the
// guard aborts, the caller gets the current row to refuse with.
export async function markJobFailed(
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
      `UPDATE jobs SET status = 'failed', result_summary = ?2, summary_sig = NULL, lease_expires = NULL, updated_at = ?3
       WHERE id = ?1 AND status = ?4 RETURNING id`
    ).bind(job.id, summary, now.toISOString(), fromStatus),
    ...(await mirrorStatements(env, failed, auditAction, actor)),
    jobAudit(env.DB, actor, auditAction, failed, auditParams),
    revokeBoundKeys(env.DB, job.id),
  ]);
  if (!committed) return { failed: false, current: await readJob(env.DB, job.id) };
  return { failed: true };
}

// Every transition and its records are one batch. Committing the UPDATE alone and
// writing the mirror and audit row in a second batch would let a throw in between
// leave a moved row with no record of the move.
//
// `read` is the row the caller decided on. requireJobUnchanged, first in the batch,
// aborts the whole batch unless the row still has that status, holder and updated_at,
// and D1 runs a batch as one transaction, so the UPDATE and every record built from
// `read` commit together or not at all. Returns false when the guard aborted, which
// means nothing was written and the row changed since `read`.
export async function guardedTransition(env: Env, read: JobRow, statements: D1PreparedStatement[]): Promise<boolean> {
  try {
    await env.DB.batch([requireJobUnchanged(env.DB, read.id, read.status, read.claimed_by, read.updated_at), ...statements]);
    return true;
  } catch (err) {
    if (!isMissingRowAbort(err)) throw err;
    return false;
  }
}

/** The refusal for a job markJobFailed found had already moved. */
export function movedBeforeFailing(action: string, id: string, current: JobRow | null, why: string): JobResult {
  return refuse(
    action,
    `${id} ${why}, but it changed before it could be marked failed: it is now ${current?.status ?? "gone"}${current?.claimed_by ? `, held by ${current.claimed_by}` : ""}. Nothing was written.`
  );
}

// The track-record bar, checked at claim (migrations/0011).
//
// Read only when a job sets one, which is rare. The record is computed from every
// outcome row, so making every claim pay for that read would put a table scan in
// front of the queue's hottest path.
//
// It goes through recordFor, the same function improve_status and the Portal call,
// so the bar a claim is measured against is the number a human can read on the page.
// `null` for namespaces because the improve-loop columns play no part in this
// comparison, and computing them here would attribute a namespace's attempts to
// whichever credential happened to be asking.
export async function recordShortfall(db: D1Database, actor: string, job: JobRow): Promise<string | null> {
  if (!job.min_record) return null;
  return missingForRecord(recordFor(actor, await loadRecordRows(db), null), job.min_record);
}

// The corrections budget is a property of the work, not of the row.
//
// corrections_count lives on a row, and the unique open-title index covers `queued`,
// `claimed` and `blocked` (migrations/0019) but not `failed`, so a failed job leaves
// (namespace, title) free to be posted again. The new row starts at 0, and a per-row
// cap would count how many times a row existed rather than how many times the work
// had been sent back. So the count is per (namespace, title).
//
// Summed across every row for that work, whatever its status, and the current row is
// one of them. Unindexed on purpose: jobs is a single-user queue of a few hundred rows
// at most, and the only index on (namespace, title) is the partial one, which does not
// cover finished rows.
//
// Fails closed. A read that throws, or a SUM that is not a finite number, returns
// NaN, and atCorrectionCap treats a budget it cannot read as a budget already spent.
export async function correctionsForWork(db: D1Database, namespace: string, title: string): Promise<number> {
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
