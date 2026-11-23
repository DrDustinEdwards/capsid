import type { FakeD1Rows } from "./fakes.ts";
import { sqliteNow, type Row, type WriteResult } from "./fake-sql.ts";

// The audit rows the fake builds inside a batch, as SQLite would evaluate their SELECT.

// delete's row, whose params are the edges it removes, built by json_group_array. An
// aggregate over no edges still answers one row, so the row lands with an empty list.
const DELETE_AUDIT_EDGES =
  /^INSERT INTO audit_log \(actor, action, namespace, path, params, client\) SELECT \?1, 'delete', \?2, \?3, json_object\('edges_removed', json_group_array\( json_object\('from_ns', from_ns, 'from_path', from_path, 'type', type, 'to_ns', to_ns, 'to_path', to_path\)\)\), \?4 FROM document_links WHERE \(from_ns = \?2 AND from_path = \?3\) OR \(to_ns = \?2 AND to_path = \?3\) RETURNING params$/i;

// changeWithAudit's row (src/agents-admin.ts): it fires only while its agent still matches
// the guard, the way SQLite evaluates the WHERE EXISTS.
const AGENT_AUDIT =
  /^INSERT INTO audit_log \(actor, action, namespace, path, params, client\) SELECT \?1, \?2, 'agents', \?3, \?4, \?5 WHERE EXISTS \(SELECT 1 FROM agents WHERE id = \?6 AND (.+)\)$/i;

function push(rows: FakeD1Rows, row: Record<string, unknown>) {
  const id = rows.audit_log.reduce((max, a) => Math.max(max, a.id ?? 0), 0) + 1;
  (rows.audit_log as Row[]).push({ id, ...row, at: sqliteNow() });
}

/** The write when `flat` is one of those two audit statements, else null. */
export function landAuditRow(
  flat: string,
  params: unknown[],
  rows: FakeD1Rows,
): WriteResult | null {
  if (DELETE_AUDIT_EDGES.test(flat)) {
    const [actor, namespace, path, client] = params as [string, string, string, string | null];
    const edges = rows.links
      .filter(
        (l) =>
          (l.from_ns === namespace && l.from_path === path) ||
          (l.to_ns === namespace && l.to_path === path),
      )
      .map(({ from_ns, from_path, type, to_ns, to_path }) => ({
        from_ns,
        from_path,
        type,
        to_ns,
        to_path,
      }));
    const auditParams = JSON.stringify({ edges_removed: edges });
    push(rows, { actor, action: "delete", namespace, path, params: auditParams, client });
    return { changes: 1, returning: [{ params: auditParams }] };
  }
  const guard = AGENT_AUDIT.exec(flat)?.[1];
  if (guard === undefined) return null;
  const [actor, action, path, auditParams, client, id] = params as string[];
  const agent = rows.agents.find((a) => a.id === id);
  const pending = /pending = ([01])/i.exec(guard)?.[1];
  const live =
    agent !== undefined &&
    (!/revoked_at IS NULL/i.test(guard) || agent.revoked_at == null) &&
    (pending === undefined || Number(agent.pending ?? 0) === Number(pending));
  if (!live) return { changes: 0, returning: [] };
  push(rows, { actor, action, namespace: "agents", path, params: auditParams, client });
  return { changes: 1, returning: [] };
}
