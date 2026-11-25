// Whether sessions read the portfolio rules. Every repo's CLAUDE.md says to read
// capsid/conventions.md first, but audit_log recorded writes only. A read of that document,
// through `capsid_read_doc` or `capsid_start_session`, now leaves one `conventions-read` row, at
// most one per caller per hour.

import { HEALTH_PROBE_NS, HEALTH_PROBE_PATH } from "./store-probe";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";

const CONVENTIONS_READ_ACTION = "conventions-read";
const WINDOW = "-1 hour";

export function isConventionsDoc(namespace: string, path: string): boolean {
  return namespace === HEALTH_PROBE_NS && path === HEALTH_PROBE_PATH;
}

/**
 * Record that `actor` read the rules, unless it already did inside the last hour. One statement,
 * so the check and the insert cannot be separated by another request's row for the same caller.
 */
export async function recordConventionsRead(
  db: D1Database,
  actor: string,
  via: "read" | "brief",
  forNamespace: string,
  thread?: string,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO audit_log (actor, action, namespace, path, params)
         SELECT ?1, ?2, ?3, NULL, ?4
         WHERE NOT EXISTS (
           SELECT 1 FROM audit_log WHERE action = ?2 AND actor = ?1 AND at >= datetime('now', ?5)
             AND COALESCE(json_extract(params, '$.thread'), '') = ?6
         )`,
      )
      .bind(
        actor,
        CONVENTIONS_READ_ACTION,
        HEALTH_PROBE_NS,
        JSON.stringify(
          thread
            ? { via, for_namespace: forNamespace, thread }
            : { via, for_namespace: forNamespace },
        ),
        WINDOW,
        thread ?? "",
      )
      .run();
  } catch (err) {
    logEvent(
      "CONVENTIONS_READ",
      {
        message: `CONVENTIONS_READ could not record the read by ${actor}: ${errorMessage(err)}`,
      },
      { level: "error" },
    );
  }
}
