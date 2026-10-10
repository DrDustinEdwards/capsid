import { auditStatement } from "./store-guards";

// Revoked agents leave the live inventory and keep their history (job_24e460427d6c;
// Dustin, 2026-10-02 and 2026-10-10: archive and hide, never delete an agent with
// history). migrations/0038_agents_archive.sql says what moves and why.
//
// Every row that records what an agent did carries the actor string agent:<name>
// itself, so moving the agents row breaks no join a reader of history needs. Three
// things still need the old row, and read it from here: the name stays reserved
// (mintAgent), the key's digest is still refused rather than tried as an operator key
// (resolveAgent), and a reviewer's past verdict is judged on the scopes it held
// (src/review.ts). Archived means revoked to every other reader.

// A revoked agent moves this long after revocation, so a revocation made by mistake can
// still be read in place for a week.
export const ARCHIVE_AFTER_DAYS = 7;

export type ArchiveReason = "revoked-7-days" | "runner-job-ended";

// How many agents one pass moves. A pass is not the place to drain a backlog of
// hundreds; the next pass takes the rest.
const MAX_PER_PASS = 20;

// The audit identity of the pass that moves them.
const ARCHIVE_ACTION = "agents.archive";

export interface ArchivedAgent {
  id: string;
  name: string;
  kind: string;
  key_hash: string;
  scopes: string;
  created_by: string;
  created_at: string;
  revoked_at: string;
  last_seen: string | null;
  job_id: string | null;
  reason: ArchiveReason;
  audit_rows: number;
  jobs: number;
  archived_at: string;
}

interface DueRow {
  id: string;
  name: string;
  reason: ArchiveReason;
}

/** The revoked agents due to move: 7 days after revocation, or a one-job runner key
 *  whose job has ended (done, failed or superseded). Oldest revocation first. */
async function archiveDue(db: D1Database, now: Date): Promise<DueRow[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id AS id, a.name AS name,
              CASE WHEN a.job_id IS NOT NULL AND j.status IN ('done', 'failed', 'superseded') THEN 'runner-job-ended' ELSE 'revoked-7-days' END AS reason
         FROM agents a LEFT JOIN jobs j ON j.id = a.job_id
        WHERE a.revoked_at IS NOT NULL
          AND (datetime(a.revoked_at) <= datetime(?1, ?3)
               OR (a.job_id IS NOT NULL AND j.status IN ('done', 'failed', 'superseded')))
        ORDER BY a.revoked_at, a.name
        LIMIT ?2`
    )
    .bind(now.toISOString(), MAX_PER_PASS, `-${ARCHIVE_AFTER_DAYS} days`)
    .all<DueRow>();
  return results ?? [];
}

/** The move of one agent, as one batch: copy it with its counts, delete it from agents,
 *  and write the audit row. Both data statements are guarded on the row still being
 *  revoked, so a row that changed between the read and the batch moves nothing. */
function archiveStatements(db: D1Database, actor: string, due: DueRow): D1PreparedStatement[] {
  const agentActor = `agent:${due.name}`;
  return [
    db
      .prepare(
        `INSERT INTO agents_archive (id, name, kind, key_hash, scopes, created_by, created_at, revoked_at, last_seen, job_id, reason, audit_rows, jobs)
         SELECT id, name, kind, key_hash, scopes, created_by, created_at, revoked_at, last_seen, job_id, ?2,
                (SELECT COUNT(*) FROM audit_log WHERE actor = ?3),
                (SELECT COUNT(*) FROM (
                   SELECT id FROM jobs WHERE posted_by = ?3 OR claimed_by = ?3
                   UNION SELECT job_id FROM job_outcomes WHERE agent = ?3
                   UNION SELECT job_id FROM job_claims WHERE agent = ?3))
           FROM agents WHERE id = ?1 AND revoked_at IS NOT NULL`
      )
      .bind(due.id, due.reason, agentActor),
    db.prepare("DELETE FROM agents WHERE id = ?1 AND revoked_at IS NOT NULL AND EXISTS (SELECT 1 FROM agents_archive WHERE id = ?1)").bind(due.id),
    auditStatement(db, actor, ARCHIVE_ACTION, "agents", due.name, { reason: due.reason, id: due.id }),
  ];
}

export interface ArchivePass {
  archived: Array<{ name: string; reason: ArchiveReason }>;
  // Due, and moved nothing: the row changed between the read and the batch.
  skipped: string[];
}

/** The watcher pass's archive step. Each agent moves in its own batch, so one that
 *  fails leaves the rest moved and says which. */
export async function archiveRevokedAgents(db: D1Database, actor: string, now: Date): Promise<ArchivePass> {
  const out: ArchivePass = { archived: [], skipped: [] };
  for (const due of await archiveDue(db, now)) {
    const results = await db.batch(archiveStatements(db, actor, due));
    // The DELETE is what takes the row out of the live table, so its count is the move.
    // agents has no trigger to inflate it (conventions 8.2).
    if ((results[1]?.meta?.changes ?? 0) === 1) out.archived.push({ name: due.name, reason: due.reason });
    else out.skipped.push(due.name);
  }
  return out;
}

/** Archived agents, newest move first. The stored verifier never leaves this module:
 *  readers get its first twelve hex, the fingerprint agents list shows. */
export async function listArchivedAgents(db: D1Database, limit = 200): Promise<Array<Omit<ArchivedAgent, "key_hash"> & { fingerprint: string }>> {
  const { results } = await db.prepare("SELECT * FROM agents_archive ORDER BY archived_at DESC, name LIMIT ?1").bind(limit).all<ArchivedAgent>();
  return (results ?? []).map(({ key_hash, ...row }) => ({ ...row, fingerprint: key_hash.slice(0, 12) }));
}

/** An archived agent by name, or null. */
export async function archivedAgentByName(db: D1Database, name: string): Promise<ArchivedAgent | null> {
  return db.prepare("SELECT * FROM agents_archive WHERE name = ?1").bind(name).first<ArchivedAgent>();
}
