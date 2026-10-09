import type { Agent } from "./agents";
import { sha256Hex } from "./auth";
import { callerIsSeat } from "./jobs-transition";
import { TOOL_GRANTS } from "./scope";
import { auditStatement, documentUpsert, isMissingRowAbort, requireBodyUnchanged, requireMissing, snapshotLive } from "./store-guards";

// CANON WRITE-PROTECTION (capsid/decisions.md, 2026-10-03, OWASP hardening item 2, D3;
// design: capsid/research/design-owasp-hardening.md, "Item 2").
//
// Canon is what every agent is told to trust: the portfolio rules, the layer model, each
// namespace's core.md and its decisions log (capsid/repo-structure.md, layers 2 to 6
// minus the typed docs). A driver's `write` to one is not applied. It becomes a row in
// canon_proposals (migrations/0034) and the write answers pending_review. The admin
// approves it, applied as an ordinary write guarded on the body it was written against,
// or rejects it, through the `canon_approve` and `canon_reject` controls (src/controls.ts,
// the Portal and the controls tool). restore, delete and move on a canon path are
// refused for such a caller: a proposal carries a body, and those three do not.
//
// The admin's and the seat's own writes are not queued (callerIsSeat: admin or
// can_merge, the same test every seat-only job transition uses).
//
// Lines a proposal adds that read as instructions to agents are flagged for the
// reviewer, never auto-rejected: the rulings in decisions.md are themselves
// instructions to agents, and an automatic reject would refuse the seat's own canon.

export interface CanonRule {
  // "*" is every namespace.
  namespace: string;
  pattern: RegExp;
  label: string;
}

// test/canon.test.ts pins this list.
export const CANON_RULES: readonly CanonRule[] = [
  { namespace: "capsid", pattern: /^conventions(-[a-z0-9]+)*\.md$/, label: "capsid/conventions.md and capsid/conventions-<name>.md" },
  { namespace: "capsid", pattern: /^repo-structure\.md$/, label: "capsid/repo-structure.md" },
  { namespace: "*", pattern: /^core\.md$/, label: "<namespace>/core.md" },
  { namespace: "*", pattern: /^(archive\/)?decisions(-vol-[1-9][0-9]{0,3})?\.md$/, label: "<namespace>/decisions.md and its volumes, live or archived" },
];

/** Whether a document is canon. Exact strings: documents are keyed by the exact path,
 *  so "Core.md" or "./core.md" is another document, which no reader takes for canon. */
export function isCanonPath(namespace: string, path: string): boolean {
  return CANON_RULES.some((r) => (r.namespace === "*" || r.namespace === namespace) && r.pattern.test(path));
}

/** Whether this caller's change to this document goes to review instead of the store. */
export function canonGuarded(agent: Agent, namespace: string, path: string): boolean {
  return !callerIsSeat(agent) && isCanonPath(namespace, path);
}

/** The list as improve_status serves it, beside protected_paths. */
export function servedCanonPaths(): Array<{ namespace: string; source: string; label: string }> {
  return CANON_RULES.map((r) => ({ namespace: r.namespace, source: r.pattern.source, label: r.label }));
}

/** The refusal restore, delete and move give a guarded caller on a canon path. */
export function canonRefusal(tool: "restore" | "delete" | "move", namespace: string, path: string): string {
  return (
    `${namespace}/${path} is canon (capsid/repo-structure.md), and a ${tool} of it by a driver is refused. Nothing changed. ` +
    `Canon changes by proposal: write the body you want with \`write\` and it is queued for the seat or Dustin to approve` +
    (tool === "restore" ? " (read the version with `history` to get its body)." : ".")
  );
}

// ---------------------------------------------------------------------------
// Instruction-shaped lines.

// A line is compared with these after its markdown lead (list marker, quote, heading,
// bold) is stripped and it is lowercased. Published in docs/schema.md.
const DIRECTIVE_OPENERS: readonly string[] = [
  "you must",
  "you should",
  "you will",
  "you are to",
  "always ",
  "never ",
  "ignore ",
  "disregard ",
  "forget ",
  "do not ",
  "don't ",
  "from now on",
  "agents must",
  "agents should",
  "the agent must",
  "drivers must",
  "a driver must",
  "every session must",
  "sessions must",
];
// Or an imperative naming a served tool: "call write ...", "run `jobs` ...".
const TOOL_IMPERATIVE = /^(call|run|use|invoke)\s+`?([a-z_]+)`?(\s|$)/;

function stripLead(line: string): string {
  return line
    .trim()
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+|>\s*|#{1,6}\s+)+/, "")
    .replace(/\*\*|__/g, "")
    .trim()
    .toLowerCase();
}

/** Whether one line reads as an instruction addressed to agents. */
export function isDirectiveLine(line: string): boolean {
  const text = stripLead(line);
  if (!text) return false;
  if (DIRECTIVE_OPENERS.some((opener) => text.startsWith(opener))) return true;
  const tool = TOOL_IMPERATIVE.exec(text)?.[2];
  return tool !== undefined && Object.prototype.hasOwnProperty.call(TOOL_GRANTS, tool);
}

/** The lines `after` adds to `before` and the lines it drops, as multisets: a line
 *  moved within the document is neither. Order follows the document. */
export function lineChanges(before: string | null, after: string): { added: string[]; removed: string[] } {
  const counts = new Map<string, number>();
  for (const line of (before ?? "").split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of after.split("\n")) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else added.push(line);
  }
  const removed: string[] = [];
  for (const line of (before ?? "").split("\n")) {
    const n = counts.get(line) ?? 0;
    if (n > 0) {
      removed.push(line);
      counts.set(line, n - 1);
    }
  }
  const content = (l: string) => l.trim() !== "";
  return { added: added.filter(content), removed: removed.filter(content) };
}

/** The added lines that read as instructions to agents. */
export function directiveLines(before: string | null, after: string): string[] {
  return lineChanges(before, after).added.filter(isDirectiveLine);
}

// ---------------------------------------------------------------------------
// The queue.

export interface ProposalInput {
  namespace: string;
  path: string;
  title: string | null;
  body: string;
  type: string | null;
  tags: string | null;
  status: string | null;
  mode: string;
  // The body the write read; null when the document did not exist.
  priorBody: string | null;
  priorExists: boolean;
}

export interface Proposed {
  id: number;
  base_sha: string | null;
  directive_lines: string[];
}

/** Stores a guarded caller's write as a pending proposal, with its audit row, in one
 *  batch. Nothing in documents changes. */
export async function proposeCanon(db: D1Database, actor: string, now: Date, input: ProposalInput): Promise<Proposed> {
  const baseSha = input.priorExists ? await sha256Hex(input.priorBody ?? "") : null;
  const flagged = directiveLines(input.priorBody, input.body);
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO canon_proposals (namespace, path, title, body, type, tags, status, mode, base_sha, proposer, created_at, directive_lines)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         RETURNING id`
      )
      .bind(input.namespace, input.path, input.title, input.body, input.type, input.tags, input.status, input.mode, baseSha, actor, now.toISOString(), JSON.stringify(flagged)),
    auditStatement(db, actor, "canon-proposed", input.namespace, input.path, { mode: input.mode, base_sha: baseSha, directive_lines: flagged.length }),
  ]);
  const id = (inserted?.results?.[0] as { id?: number } | undefined)?.id;
  if (typeof id !== "number") throw new Error(`the proposal for ${input.namespace}/${input.path} was not stored: the insert returned no id`);
  return { id, base_sha: baseSha, directive_lines: flagged };
}

export interface ProposalRow {
  id: number;
  namespace: string;
  path: string;
  title: string | null;
  body: string;
  type: string | null;
  tags: string | null;
  status: string | null;
  mode: string;
  base_sha: string | null;
  proposer: string;
  created_at: string;
  directive_lines: string;
  state: "pending" | "approved" | "rejected";
  decided_by: string | null;
  decided_at: string | null;
  decided_reason: string | null;
}

async function readProposal(db: D1Database, id: number): Promise<ProposalRow | null> {
  return db.prepare("SELECT * FROM canon_proposals WHERE id = ?1").bind(id).first<ProposalRow>();
}

// The pending queue is short by construction (each row waits on one person), so this is
// a guard, not a page.
const PENDING_LIMIT = 50;

export interface PendingProposal {
  id: number;
  namespace: string;
  path: string;
  proposer: string;
  created_at: string;
  // Whether the document existed when the proposal was written.
  creates: boolean;
  // Whether the stored body is still the one the proposal was written against. A stale
  // proposal cannot be approved; it is rejected and written again.
  stale: boolean;
  added: number;
  removed: number;
  directive_lines: string[];
}

/** The pending proposals, oldest first, each measured against the document as it is
 *  now. One read whatever the count: the feed's read budget is fixed
 *  (OPS_FEED_READS in src/ops-feed.ts). */
export async function pendingProposals(db: D1Database): Promise<PendingProposal[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.namespace, p.path, p.body, p.base_sha, p.proposer, p.created_at, p.directive_lines,
              d.id AS doc_id, d.body AS current_body
       FROM canon_proposals p LEFT JOIN documents d ON d.namespace = p.namespace AND d.path = p.path
       WHERE p.state = 'pending' ORDER BY p.id LIMIT ?1`
    )
    .bind(PENDING_LIMIT)
    .all<Pick<ProposalRow, "id" | "namespace" | "path" | "body" | "base_sha" | "proposer" | "created_at" | "directive_lines"> & { doc_id: number | null; current_body: string | null }>();
  return Promise.all(
    (results ?? []).map(async (r) => {
      const current = r.doc_id === null ? null : (r.current_body ?? "");
      const sha = current === null ? null : await sha256Hex(current);
      const change = lineChanges(current, r.body);
      return {
        id: r.id,
        namespace: r.namespace,
        path: r.path,
        proposer: r.proposer,
        created_at: r.created_at,
        creates: r.base_sha === null,
        stale: sha !== r.base_sha,
        added: change.added.length,
        removed: change.removed.length,
        directive_lines: parseLines(r.directive_lines),
      };
    })
  );
}

function parseLines(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === "string") : [];
  } catch {
    // Written by proposeCanon from JSON.stringify; unreadable means a hand-edited row,
    // shown as no flagged lines rather than failing the whole queue read.
    return [];
  }
}

export type ProposalCheck =
  | { ok: true; row: ProposalRow; current: string | null; directive: string[] }
  | { ok: false; refusal: string };

/** A pending proposal, and the document as it is now, or why it cannot be decided.
 *  `forApproval` also refuses a proposal whose base has moved. */
export async function checkProposal(db: D1Database, id: number, forApproval: boolean): Promise<ProposalCheck> {
  const row = await readProposal(db, id);
  if (!row) return { ok: false, refusal: `no canon proposal ${id}.` };
  if (row.state !== "pending") return { ok: false, refusal: `canon proposal ${id} was already ${row.state}${row.decided_by ? ` by ${row.decided_by}` : ""}${row.decided_at ? ` at ${row.decided_at}` : ""}.` };
  const doc = await db.prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2").bind(row.namespace, row.path).first<{ body: string | null }>();
  const current = doc ? (doc.body ?? "") : null;
  if (forApproval) {
    const sha = doc ? await sha256Hex(current ?? "") : null;
    if (sha !== row.base_sha) {
      return {
        ok: false,
        refusal:
          row.base_sha === null
            ? `${row.namespace}/${row.path} did not exist when proposal ${id} was written, and it does now. Approving would overwrite a body the proposer never read. Reject it, and the proposer writes it again against the current body.`
            : `${row.namespace}/${row.path} changed since proposal ${id} was written (written against ${row.base_sha.slice(0, 12)}, now ${sha ? sha.slice(0, 12) : "deleted"}). Approving would overwrite a body the proposer never read. Reject it, and the proposer writes it again against the current body.`,
      };
    }
  }
  return { ok: true, row, current, directive: parseLines(row.directive_lines) };
}

export type Decided = { ok: true; row: ProposalRow; sha256: string; snapshotted: boolean } | { ok: false; refusal: string };

// The proposal is still pending, inside the batch: the same NOT NULL abort the store's
// other guards use (src/store-guards.ts), so a second approve, or an approve racing a
// reject, changes nothing.
function requirePending(db: D1Database, id: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO document_versions (document_id, namespace, path)
       SELECT NULL, 'canon_proposals', ?1
       WHERE NOT EXISTS (SELECT 1 FROM canon_proposals WHERE id = ?1 AND state = 'pending')`
    )
    .bind(String(id));
}

/** Approves a proposal: the document is written as the proposal says, as an ordinary
 *  write (snapshot of the live row, the upsert, an audit row naming the approver and the
 *  proposal), guarded in the batch on the base body and on the proposal still pending.
 *  CLAUDE.md, snapshot rule. */
export async function approveProposal(db: D1Database, actor: string, now: Date, id: number): Promise<Decided> {
  const checked = await checkProposal(db, id, true);
  if (!checked.ok) return checked;
  const { row, current } = checked;
  const exists = row.base_sha !== null;
  try {
    const results = await db.batch([
      requirePending(db, id),
      exists ? requireBodyUnchanged(db, row.namespace, row.path, current) : requireMissing(db, row.namespace, row.path),
      ...(exists ? [snapshotLive(db, row.namespace, row.path)] : []),
      documentUpsert(db, row.namespace, row.path, row.title, row.body, row.type, row.tags, row.status),
      auditStatement(db, actor, "write", row.namespace, row.path, {
        title: row.title ?? undefined,
        type: row.type ?? undefined,
        tags: row.tags ?? undefined,
        status: row.status ?? undefined,
        mode: row.mode,
        updated: exists,
        canon_proposal: id,
        proposer: row.proposer,
      }),
      db
        .prepare("UPDATE canon_proposals SET state = 'approved', decided_by = ?2, decided_at = ?3 WHERE id = ?1 AND state = 'pending'")
        .bind(id, actor, now.toISOString()),
    ]);
    const snapshotted = exists && (results[2]?.results?.length ?? 0) > 0;
    return { ok: true, row, sha256: await sha256Hex(row.body), snapshotted };
  } catch (err) {
    if (!isMissingRowAbort(err)) throw err;
    return { ok: false, refusal: `canon proposal ${id} was not applied: it was decided, or ${row.namespace}/${row.path} changed, while this approval ran. Nothing changed. Preview it again.` };
  }
}

/** Rejects a proposal, with the reason the proposer reads. The document is untouched. */
export async function rejectProposal(db: D1Database, actor: string, now: Date, id: number, reason: string): Promise<Decided> {
  const checked = await checkProposal(db, id, false);
  if (!checked.ok) return checked;
  const { row } = checked;
  try {
    await db.batch([
      requirePending(db, id),
      db
        .prepare("UPDATE canon_proposals SET state = 'rejected', decided_by = ?2, decided_at = ?3, decided_reason = ?4 WHERE id = ?1 AND state = 'pending'")
        .bind(id, actor, now.toISOString(), reason),
      auditStatement(db, actor, "canon-rejected", row.namespace, row.path, { canon_proposal: id, proposer: row.proposer, reason }),
    ]);
  } catch (err) {
    if (!isMissingRowAbort(err)) throw err;
    return { ok: false, refusal: `canon proposal ${id} was decided while this rejection ran. Nothing changed.` };
  }
  return { ok: true, row, sha256: await sha256Hex(row.body), snapshotted: false };
}
