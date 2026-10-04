// Whether sessions read the portfolio rules. Every repo's CLAUDE.md says to read
// capsid/conventions.md first; audit_log recorded writes only, so there was no evidence
// either way. A read of that document, through `read` or `brief`, now leaves one
// `conventions-read` row, at most one per caller per hour so it cannot become noise.
//
// The row is NOT addressed to capsid/conventions.md. `lastActor` and the Portal read the
// newest audit row for a document's path as its last writer, so a reader's row there
// would make every reader the document's last_actor. It sits in the capsid namespace
// with no path, and params say how the document was reached.

import { HEALTH_PROBE_NS, HEALTH_PROBE_PATH } from "./store-probe";

const CONVENTIONS_READ_ACTION = "conventions-read";
const WINDOW = "-1 hour";

/** Whether a read of this document is a read of the portfolio rules. */
export function isConventionsDoc(namespace: string, path: string): boolean {
  return namespace === HEALTH_PROBE_NS && path === HEALTH_PROBE_PATH;
}

/** Record that `actor` read the rules, unless it already did inside the last hour. One
 *  statement, so the check and the insert cannot be separated by another request's row
 *  for the same caller. A failure is reported and never fails the read: this is a
 *  measurement, and the caller asked for a document. */
export async function recordConventionsRead(
  db: D1Database,
  actor: string,
  via: "read" | "brief",
  forNamespace: string
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO audit_log (actor, action, namespace, path, params)
         SELECT ?1, ?2, ?3, NULL, ?4
         WHERE NOT EXISTS (
           SELECT 1 FROM audit_log WHERE action = ?2 AND actor = ?1 AND at >= datetime('now', ?5)
         )`
      )
      .bind(actor, CONVENTIONS_READ_ACTION, HEALTH_PROBE_NS, JSON.stringify({ via, for_namespace: forNamespace }), WINDOW)
      .run();
  } catch (err) {
    console.error(`CONVENTIONS_READ could not record the read by ${actor}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
