import { auditStatement } from "./store-guards";

// Revoked agents are archived and hidden, never deleted (docs/auth.md). An archived agent is a revoked row
// with archived_at set (0066), so its name stays reserved and its key refused with no second table.

// Moves a week after revocation, so a mistaken revocation can still be read in place.
export const ARCHIVE_AFTER_DAYS = 7;

type ArchiveReason = "revoked-7-days";

// A pass is not the place to drain a backlog; the next pass takes the rest.
const MAX_PER_PASS = 20;

const ARCHIVE_ACTION = "agents.archive";

const ARCHIVED_COLUMNS =
  "id, name, kind, key_hash, scopes, created_by, created_at, revoked_at, last_seen, archive_reason AS reason, audit_rows, jobs, archived_at";

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

async function archiveDue(db: D1Database, now: Date): Promise<DueRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, 'revoked-7-days' AS reason FROM agents
        WHERE revoked_at IS NOT NULL AND archived_at IS NULL AND datetime(revoked_at) <= datetime(?1, ?3)
        ORDER BY revoked_at, name
        LIMIT ?2`,
    )
    .bind(now.toISOString(), MAX_PER_PASS, `-${ARCHIVE_AFTER_DAYS} days`)
    .all<DueRow>();
  return results ?? [];
}

// One agent's move as one batch (archive stamp plus audit row), guarded on the row still being
// revoked and unarchived, so a row that changed since the read moves nothing.
function archiveStatements(db: D1Database, actor: string, due: DueRow): D1PreparedStatement[] {
  const agentActor = `agent:${due.name}`;
  return [
    db
      .prepare(
        `UPDATE agents SET archived_at = datetime('now'), archive_reason = ?2,
                audit_rows = (SELECT COUNT(*) FROM audit_log WHERE actor = ?3),
                jobs = (SELECT COUNT(*) FROM (
                   SELECT id FROM jobs WHERE posted_by = ?3 OR claimed_by = ?3
                   UNION SELECT job_id FROM job_outcomes WHERE agent = ?3
                   UNION SELECT job_id FROM job_claims WHERE agent = ?3))
          WHERE id = ?1 AND revoked_at IS NOT NULL AND archived_at IS NULL`,
      )
      .bind(due.id, due.reason, agentActor),
    auditStatement(db, actor, ARCHIVE_ACTION, "agents", due.name, {
      reason: due.reason,
      id: due.id,
    }),
  ];
}

export interface ArchivePass {
  archived: Array<{ name: string; reason: ArchiveReason }>;
  skipped: string[];
}

export async function archiveRevokedAgents(
  db: D1Database,
  actor: string,
  now: Date,
): Promise<ArchivePass> {
  const out: ArchivePass = { archived: [], skipped: [] };
  for (const due of await archiveDue(db, now)) {
    const results = await db.batch(archiveStatements(db, actor, due));
    // The UPDATE is the move, so its count says whether it happened; agents has no trigger to inflate it.
    if ((results[0]?.meta?.changes ?? 0) === 1)
      out.archived.push({ name: due.name, reason: due.reason });
    else out.skipped.push(due.name);
  }
  return out;
}

/** Archived agents, newest move first. The verifier never leaves this module, only its first twelve hex. */
export async function listArchivedAgents(
  db: D1Database,
  limit = 200,
): Promise<Array<Omit<ArchivedAgent, "key_hash"> & { fingerprint: string }>> {
  const { results } = await db
    .prepare(
      `SELECT ${ARCHIVED_COLUMNS} FROM agents WHERE archived_at IS NOT NULL ORDER BY archived_at DESC, name LIMIT ?1`,
    )
    .bind(limit)
    .all<ArchivedAgent>();
  return (results ?? []).map(({ key_hash, ...row }) => ({
    ...row,
    fingerprint: key_hash.slice(0, 12),
  }));
}

export async function archivedAgentByName(
  db: D1Database,
  name: string,
): Promise<ArchivedAgent | null> {
  return db
    .prepare(`SELECT ${ARCHIVED_COLUMNS} FROM agents WHERE name = ?1 AND archived_at IS NOT NULL`)
    .bind(name)
    .first<ArchivedAgent>();
}
