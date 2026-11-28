import type { Env } from "./env";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { HOUR_MS } from "./time";

// THE WATCHER'S MEMORY OF A FINDING, one watcher_findings row per fingerprint
// (migrations/0024_watcher_findings.sql), so a condition seen on every pass is one finding.

// THE QUIET PERIOD: six hours. A finding that cleared is opened again only when it is seen at least
// six hours after it cleared.
export const REOPEN_QUIET_MS = 6 * HOUR_MS;

// The newest sightings kept on a row. Older ones are dropped, so a finding that
// persists for weeks does not grow its row without bound.
export const MAX_EVIDENCE = 20;
const MAX_EVIDENCE_LINES = 8;
const MAX_EVIDENCE_LINE = 300;

const FINDING_STATES = ["open", "dismissed", "cleared"] as const;
type FindingState = (typeof FINDING_STATES)[number];

export interface FindingRow {
  fingerprint: string;
  namespace: string;
  title: string;
  state: FindingState;
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  cleared_at: string | null;
  reopen_after: string | null;
  evidence: string;
  updated_at: string;
}

// What a sighting carries into the row. The Finding type lives in src/watcher-detect.ts;
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

// The row's evidence with this sighting appended, newest last, the newest MAX_EVIDENCE kept.
// Evidence this Worker wrote that does not parse is a defect to see: it is logged and replaced,
// never silently dropped.
export function appendEvidence(
  fingerprint: string,
  existing: string | null,
  f: Sighted,
  now: Date,
): string {
  let list: EvidenceEntry[] = [];
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      list = parsed as EvidenceEntry[];
    } catch (err) {
      logEvent(
        "WATCHER_EVIDENCE_UNREADABLE",
        {
          message: `WATCHER_EVIDENCE_UNREADABLE ${fingerprint}: ${errorMessage(err)}; starting it again`,
        },
        { level: "error" },
      );
    }
  }
  const lines = (f.evidence ?? [])
    .slice(0, MAX_EVIDENCE_LINES)
    .map((line) => line.slice(0, MAX_EVIDENCE_LINE));
  list.push({ at: now.toISOString(), lines });
  return JSON.stringify(list.slice(-MAX_EVIDENCE));
}

export type SightingVerdict =
  // Open it, or count the sighting on an open row.
  | { do: "record" }
  // Count the sighting and leave the row as it is.
  | { do: "quiet"; why: string };

// What one sighting does, from the row (null when there is none). Pure: the pass does the reads
// and the writes.
export function onSighting(row: FindingRow | null, now: Date): SightingVerdict {
  if (!row || row.state === "open") return { do: "record" };
  if (row.state === "dismissed")
    return { do: "quiet", why: "dismissed, and it has not cleared since" };

  // cleared
  const reopen = row.reopen_after ? Date.parse(row.reopen_after) : Number.NaN;
  // A cleared row with no usable reopen_after is opened rather than muted: a watcher
  // that goes quiet on a corrupt stamp reads as health.
  if (Number.isNaN(reopen)) {
    logEvent(
      "WATCHER_REOPEN_UNREADABLE",
      {
        message: `WATCHER_REOPEN_UNREADABLE ${row.fingerprint}: reopen_after '${row.reopen_after}'; opening it`,
      },
      { level: "error" },
    );
    return { do: "record" };
  }
  if (now.getTime() < reopen)
    return { do: "quiet", why: `cleared at ${row.cleared_at}, quiet until ${row.reopen_after}` };
  return { do: "record" };
}

/** The reopen_after a clear at `now` writes. */
const reopenAfter = (now: Date) => new Date(now.getTime() + REOPEN_QUIET_MS).toISOString();

// The reads and writes a pass makes, injected so test/watcher.test.ts can drive the
// pass without a database. `d1FindingMemory` is the one the tick uses.
export interface FindingMemory {
  // The rows for these fingerprints, and every 'open' or 'dismissed' row (the ones a pass may
  // clear), keyed by fingerprint.
  load(fingerprints: string[]): Promise<Map<string, FindingRow>>;
  /** A first row, open. False when a row already exists. */
  insert(f: Sighted, now: Date): Promise<boolean>;
  /** A sighting with no state change. False when the row has left `row.state`. */
  sight(row: FindingRow, f: Sighted, now: Date): Promise<boolean>;
  /** To 'open', from the state it was read in. */
  open(row: FindingRow, f: Sighted, now: Date): Promise<boolean>;
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
        const row = await db
          .prepare("SELECT * FROM watcher_findings WHERE fingerprint = ?1")
          .bind(fp)
          .first<FindingRow>();
        if (row) rows.set(fp, row);
      }
      // The rows a pass may clear, over the (state, namespace) index.
      const { results } = await db
        .prepare("SELECT * FROM watcher_findings WHERE state IN ('open', 'dismissed')")
        .all<FindingRow>();
      for (const row of results ?? []) rows.set(row.fingerprint, row);
      return rows;
    },

    async insert(f, now) {
      const iso = now.toISOString();
      const won = await db
        .prepare(
          `INSERT INTO watcher_findings (fingerprint, namespace, title, state, first_seen_at, last_seen_at, seen_count, evidence, updated_at)
           VALUES (?1, ?2, ?3, 'open', ?4, ?4, 1, ?5, ?4)
           ON CONFLICT (fingerprint) DO NOTHING RETURNING fingerprint`,
        )
        .bind(f.fingerprint, f.namespace, f.title, iso, appendEvidence(f.fingerprint, null, f, now))
        .first<{ fingerprint: string }>();
      return won !== null;
    },

    async sight(row, f, now) {
      const iso = now.toISOString();
      const won = await db
        .prepare(
          `UPDATE watcher_findings SET title = ?3, seen_count = seen_count + 1, last_seen_at = ?4, evidence = ?5, updated_at = ?4
           WHERE fingerprint = ?1 AND state = ?2 RETURNING fingerprint`,
        )
        .bind(
          row.fingerprint,
          row.state,
          f.title,
          iso,
          appendEvidence(row.fingerprint, row.evidence, f, now),
        )
        .first<{ fingerprint: string }>();
      return won !== null;
    },

    async open(row, f, now) {
      const iso = now.toISOString();
      const won = await db
        .prepare(
          `UPDATE watcher_findings SET state = 'open', title = ?3, namespace = ?4, cleared_at = NULL, reopen_after = NULL,
                  seen_count = seen_count + 1, last_seen_at = ?5, evidence = ?6, updated_at = ?5
           WHERE fingerprint = ?1 AND state = ?2 RETURNING fingerprint`,
        )
        .bind(
          row.fingerprint,
          row.state,
          f.title,
          f.namespace,
          iso,
          appendEvidence(row.fingerprint, row.evidence, f, now),
        )
        .first<{ fingerprint: string }>();
      return won !== null;
    },

    async clear(row, now) {
      const iso = now.toISOString();
      const won = await db
        .prepare(
          `UPDATE watcher_findings SET state = 'cleared', cleared_at = ?3, reopen_after = ?4, updated_at = ?3
           WHERE fingerprint = ?1 AND state = ?2 RETURNING fingerprint`,
        )
        .bind(row.fingerprint, row.state, iso, reopenAfter(now))
        .first<{ fingerprint: string }>();
      return won !== null;
    },
  };
}
