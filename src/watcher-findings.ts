import type { Env } from "./env";

// THE WATCHER'S MEMORY OF A FINDING, one watcher_findings row per fingerprint, kept
// across jobs (migrations/0024_watcher_findings.sql says why it exists).
//
// An open job used to be the only memory, and a job leaves the open set when a person
// supersedes it or fails it, so the next pass that still saw the condition filed it
// again. The row outlives the job:
//
//   seen, its job open                 count the sighting, post nothing
//   seen, row open, job ended by a     'dismissed': the person's ending holds, and it is
//     person (not the watcher's clear)   not filed again until it clears
//   seen, dismissed                    count the sighting, post nothing
//   seen, cleared, inside the quiet    count the sighting, post nothing
//   seen, no row, or cleared and past  post a job, 'open'
//     reopen_after
//   not seen while its owning check    its queued job is failed as 'cleared' (as before),
//     ran                              'cleared', reopen_after = now + REOPEN_QUIET_MS
//
// Every write is keyed on the fingerprint, and a state move is an UPDATE guarded by
// the state it was read in, with RETURNING (CLAUDE.md, path mutation rule): two passes
// racing (the tick and the Portal's Refresh) cannot both move a row, and the loser is
// told. The queue's own unique index still refuses a second open job with one title,
// so a lost race here posts nothing twice.

// THE QUIET PERIOD: six hours. A finding that cleared, or that a person dismissed and
// then cleared, is filed again only when it is seen at least six hours after it
// cleared. Long enough that a flapping check (a probe, a CI rerun) files once, not
// once per flap; short enough that a real recurrence the same day is still filed.
export const REOPEN_QUIET_MS = 6 * 60 * 60 * 1000;

// The newest sightings kept on a row. Older ones are dropped, so a finding that
// persists for weeks does not grow its row without bound.
export const MAX_EVIDENCE = 20;
const MAX_EVIDENCE_LINES = 8;
const MAX_EVIDENCE_LINE = 300;

// The result_summary the watcher's own clear writes (clearFinding, src/watcher.ts).
export const CLEARED_SUMMARY = "cleared";

const FINDING_STATES = ["open", "dismissed", "cleared"] as const;
export type FindingState = (typeof FINDING_STATES)[number];

export interface FindingRow {
  fingerprint: string;
  namespace: string;
  title: string;
  state: FindingState;
  job_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  cleared_at: string | null;
  reopen_after: string | null;
  evidence: string;
  updated_at: string;
}

// What a sighting carries into the row. The Finding type lives in src/watcher.ts;
// this is the part of it the memory reads.
export interface Sighted {
  fingerprint: string;
  namespace: string;
  title: string;
  evidence?: string[];
}

export interface EvidenceEntry {
  at: string;
  lines: string[];
}

/** The row's evidence with this sighting appended, newest last, the newest
 *  MAX_EVIDENCE kept. Evidence this Worker wrote that does not parse is a defect to
 *  see: it is logged and replaced, never silently dropped. */
export function appendEvidence(fingerprint: string, existing: string | null, f: Sighted, now: Date): string {
  let list: EvidenceEntry[] = [];
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      list = parsed as EvidenceEntry[];
    } catch (err) {
      console.error(`WATCHER_EVIDENCE_UNREADABLE ${fingerprint}: ${err instanceof Error ? err.message : String(err)}; starting it again`);
    }
  }
  const lines = (f.evidence ?? []).slice(0, MAX_EVIDENCE_LINES).map((line) => line.slice(0, MAX_EVIDENCE_LINE));
  list.push({ at: now.toISOString(), lines });
  return JSON.stringify(list.slice(-MAX_EVIDENCE));
}

// The job a row points at, as far as the decision needs it.
export interface JobEnd {
  status: string;
  result_summary: string | null;
  updated_at: string;
}

const clearedByWatcher = (job: JobEnd) => job.status === "failed" && job.result_summary === CLEARED_SUMMARY;

export type SightingVerdict =
  // Its job is open and the row knows it: count the sighting.
  | { do: "bump" }
  // An open job the row does not point at: a job posted before this table existed, or
  // a row a lost write left behind. The row adopts it, 'open'.
  | { do: "adopt"; jobId: string }
  // The row's job was ended by a person while the condition still holds.
  | { do: "dismiss" }
  // Record the sighting, post nothing.
  | { do: "quiet"; why: string }
  // File it.
  | { do: "post" };

/** What one sighting does, from the row (null when there is none), the open job the
 *  queue holds for this fingerprint, and, for an 'open' row whose job is no longer
 *  open, how that job ended. Pure: the pass does the reads and the writes. */
export function onSighting(row: FindingRow | null, openJobId: string | null, rowJob: JobEnd | null, now: Date): SightingVerdict {
  if (openJobId) return row?.state === "open" && row.job_id === openJobId ? { do: "bump" } : { do: "adopt", jobId: openJobId };
  if (!row) return { do: "post" };

  if (row.state === "open") {
    // An open row with no job is a post that was refused: file it again.
    if (!row.job_id) return { do: "post" };
    // The watcher's own clear ended the job, and the row missed its move to 'cleared'.
    // The job's last transition is when it cleared, so the quiet period runs from there.
    if (rowJob && clearedByWatcher(rowJob)) {
      const reopen = Date.parse(rowJob.updated_at) + REOPEN_QUIET_MS;
      if (Number.isNaN(reopen) || now.getTime() >= reopen) return { do: "post" };
      return { do: "quiet", why: `cleared at ${rowJob.updated_at}, inside the quiet period` };
    }
    // Superseded, failed, done, or gone, by somebody other than the watcher's clear.
    return { do: "dismiss" };
  }

  if (row.state === "dismissed") return { do: "quiet", why: "dismissed, and it has not cleared since" };

  // cleared
  const reopen = row.reopen_after ? Date.parse(row.reopen_after) : Number.NaN;
  // A cleared row with no usable reopen_after is filed rather than muted: a watcher
  // that goes quiet on a corrupt stamp reads as health.
  if (Number.isNaN(reopen)) {
    console.error(`WATCHER_REOPEN_UNREADABLE ${row.fingerprint}: reopen_after '${row.reopen_after}'; filing it`);
    return { do: "post" };
  }
  if (now.getTime() < reopen) return { do: "quiet", why: `cleared at ${row.cleared_at}, quiet until ${row.reopen_after}` };
  return { do: "post" };
}

/** The reopen_after a clear at `now` writes. */
const reopenAfter = (now: Date) => new Date(now.getTime() + REOPEN_QUIET_MS).toISOString();

// The reads and writes a pass makes, injected so test/watcher.test.ts can drive the
// pass without a database. `d1FindingMemory` is the one the tick uses.
export interface FindingMemory {
  /** The rows for these fingerprints, and every 'open' or 'dismissed' row (the ones a
   *  pass may clear), keyed by fingerprint. */
  load(fingerprints: string[]): Promise<Map<string, FindingRow>>;
  /** How a job ended, or null when there is no such job. */
  job(id: string): Promise<JobEnd | null>;
  /** A first row. False when a row already exists. */
  insert(f: Sighted, state: FindingState, jobId: string | null, now: Date): Promise<boolean>;
  /** A sighting with no state change. False when the row has left `row.state`. */
  sight(row: FindingRow, f: Sighted, now: Date): Promise<boolean>;
  /** To 'open' with this job, from the state it was read in. */
  open(row: FindingRow, f: Sighted, jobId: string, now: Date): Promise<boolean>;
  /** From 'open' with its job ended by a person, to 'dismissed'. */
  dismiss(row: FindingRow, f: Sighted, now: Date): Promise<boolean>;
  /** From 'open' or 'dismissed' to 'cleared', quiet until reopenAfter(now). */
  clear(row: FindingRow, now: Date): Promise<boolean>;
}

export function d1FindingMemory(env: Env): FindingMemory {
  const db = env.DB;
  return {
    async load(fingerprints) {
      const rows = new Map<string, FindingRow>();
      // Keyed reads for what was seen: the primary key, one row each.
      for (const fp of fingerprints) {
        const row = await db.prepare("SELECT * FROM watcher_findings WHERE fingerprint = ?1").bind(fp).first<FindingRow>();
        if (row) rows.set(fp, row);
      }
      // The rows a pass may clear, over the (state, namespace) index.
      const { results } = await db
        .prepare("SELECT * FROM watcher_findings WHERE state IN ('open', 'dismissed')")
        .all<FindingRow>();
      for (const row of results ?? []) rows.set(row.fingerprint, row);
      return rows;
    },

    async job(id) {
      return db.prepare("SELECT status, result_summary, updated_at FROM jobs WHERE id = ?1").bind(id).first<JobEnd>();
    },

    async insert(f, state, jobId, now) {
      const iso = now.toISOString();
      const won = await db
        .prepare(
          `INSERT INTO watcher_findings (fingerprint, namespace, title, state, job_id, first_seen_at, last_seen_at, seen_count, evidence, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 1, ?7, ?6)
           ON CONFLICT (fingerprint) DO NOTHING RETURNING fingerprint`
        )
        .bind(f.fingerprint, f.namespace, f.title, state, jobId, iso, appendEvidence(f.fingerprint, null, f, now))
        .first<{ fingerprint: string }>();
      return won !== null;
    },

    async sight(row, f, now) {
      const iso = now.toISOString();
      const won = await db
        .prepare(
          `UPDATE watcher_findings SET title = ?3, seen_count = seen_count + 1, last_seen_at = ?4, evidence = ?5, updated_at = ?4
           WHERE fingerprint = ?1 AND state = ?2 RETURNING fingerprint`
        )
        .bind(row.fingerprint, row.state, f.title, iso, appendEvidence(row.fingerprint, row.evidence, f, now))
        .first<{ fingerprint: string }>();
      return won !== null;
    },

    async open(row, f, jobId, now) {
      const iso = now.toISOString();
      const won = await db
        .prepare(
          `UPDATE watcher_findings SET state = 'open', job_id = ?3, title = ?4, namespace = ?5, cleared_at = NULL, reopen_after = NULL,
                  seen_count = seen_count + 1, last_seen_at = ?6, evidence = ?7, updated_at = ?6
           WHERE fingerprint = ?1 AND state = ?2 RETURNING fingerprint`
        )
        .bind(row.fingerprint, row.state, jobId, f.title, f.namespace, iso, appendEvidence(row.fingerprint, row.evidence, f, now))
        .first<{ fingerprint: string }>();
      return won !== null;
    },

    async dismiss(row, f, now) {
      const iso = now.toISOString();
      // Keyed on the job too: a row another pass has since moved to a new job is not
      // dismissed on the old one's ending.
      const won = await db
        .prepare(
          `UPDATE watcher_findings SET state = 'dismissed', reopen_after = NULL, cleared_at = NULL,
                  seen_count = seen_count + 1, last_seen_at = ?3, evidence = ?4, updated_at = ?3
           WHERE fingerprint = ?1 AND state = 'open' AND job_id = ?2 RETURNING fingerprint`
        )
        .bind(row.fingerprint, row.job_id, iso, appendEvidence(row.fingerprint, row.evidence, f, now))
        .first<{ fingerprint: string }>();
      return won !== null;
    },

    async clear(row, now) {
      const iso = now.toISOString();
      const won = await db
        .prepare(
          `UPDATE watcher_findings SET state = 'cleared', cleared_at = ?3, reopen_after = ?4, updated_at = ?3
           WHERE fingerprint = ?1 AND state = ?2 RETURNING fingerprint`
        )
        .bind(row.fingerprint, row.state, iso, reopenAfter(now))
        .first<{ fingerprint: string }>();
      return won !== null;
    },
  };
}
