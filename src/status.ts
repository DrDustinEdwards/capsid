import { overnightState, type OvernightState } from "./overnight";
import type { Env } from "./env";
import { APP_ROSTER } from "./roster";
import { servedCanonPaths } from "./canon";
import { loadGatePolicy } from "./gate-policy";
import { breakerState, type BreakerState } from "./job-breaker";
import { SCOPE_FLAGS, parseScopes } from "./agents-schema";
import { loadAgentRecords, type AgentRecord } from "./agent-record";
import { jobsSummary, type JobsSummary } from "./jobs";
import { integrityOf, REPORTS_PREFIX } from "./truth-report";
import { gatherInbox, type InboxApp } from "./inbox";
import { externalFence } from "./provenance";
import { readMaintenance, type MaintenanceItem } from "./maintenance";

import { errorMessage } from "@dustinedwards/site-runtime/log";

interface NamespaceStatus {
  namespace: string;
  breaker: BreakerState;
  // null means no report was ever run, which is not an integrity of zero.
  latest_report: { path: string; integrity: number | null; generated: string } | null;
  jobs: JobsSummary;
  maintenance: MaintenanceItem[];
  // null when the pass did not read them, so an empty list can be told from nothing read.
  maintenance_prs_read: number | null;
  maintenance_branches_read: number | null;
  needs_dustin: InboxApp;
}

export interface StatusReport {
  canon_paths: ReturnType<typeof servedCanonPaths>;
  // Served here because a namespace-scoped driver cannot read the capsid namespace.
  policies: PolicyVersions;
  overnight: OvernightState;
  // Revoked rows are included so "revoked" and "never existed" differ. Absent, not empty, for a scoped
  // caller: an empty list would read as "no agents exist".
  agents?: AgentSummary[];
  namespaces: NamespaceStatus[];
}

export interface AgentSummary {
  name: string;
  kind: string;
  namespaces: "*" | string[];
  grants: string[];
  flags: string[];
  last_seen: string | null;
  revoked_at: string | null;
  pending: boolean;
  archived_at: string | null;
  record: AgentRecord;
}

// Exported for the Watch Floor feed (src/ops-feed.ts), which lists the same inventory. The archive
// grows as revoked agents move out of the live table, so it is read bounded.
const SUMMARY_ARCHIVE_LIMIT = 50;

export async function agentSummaries(db: D1Database): Promise<AgentSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT name, kind, scopes, last_seen, revoked_at, pending, archived_at FROM agents WHERE archived_at IS NULL
       UNION ALL
       SELECT * FROM (SELECT name, kind, scopes, last_seen, revoked_at, pending, archived_at FROM agents WHERE archived_at IS NOT NULL ORDER BY archived_at DESC, name LIMIT ?1)`,
    )
    .bind(SUMMARY_ARCHIVE_LIMIT)
    .all<{
      name: string;
      kind: string;
      scopes: string;
      last_seen: string | null;
      revoked_at: string | null;
      pending: number | null;
      archived_at: string | null;
    }>();
  const rank = (r: { revoked_at: string | null; archived_at: string | null }) =>
    r.archived_at ? 2 : r.revoked_at ? 1 : 0;
  const rows = [...(results ?? [])].sort(
    (a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const inventory = rows.map((row) => {
    const scopes = parseScopes(row.scopes);
    return {
      name: row.name,
      kind: row.kind,
      namespaces: scopes.namespaces,
      grants: scopes.grants,
      flags: SCOPE_FLAGS.filter((flag) => scopes.flags[flag]),
      last_seen: row.last_seen,
      revoked_at: row.revoked_at,
      pending: row.pending === 1,
      archived_at: row.archived_at,
    };
  });
  const records = await loadAgentRecords(db, inventory);
  return inventory.map((agent) => ({ ...agent, record: records[agent.name] }));
}

type ServedPolicy = { version: string; enabled: boolean } | { reason: string };

interface PolicyVersions {
  gates: ServedPolicy;
}

async function servedPolicies(env: Env): Promise<PolicyVersions> {
  // A throw is reported, not raised: a policy being re-signed should not fail status.
  const one = async (
    load: () => Promise<{ policy: { version: string; enabled: boolean } } | { error: string }>,
  ): Promise<ServedPolicy> => {
    try {
      const loaded = await load();
      return "error" in loaded
        ? { reason: loaded.error }
        : { version: loaded.policy.version, enabled: loaded.policy.enabled };
    } catch (err) {
      return {
        reason: `the policy could not be read: ${errorMessage(err)}`,
      };
    }
  };
  return {
    gates: await one(() => loadGatePolicy(env)),
  };
}

// An app's own words, relayed inside an external fence (src/provenance.ts, OWASP item 1).
function fenceReported(app: InboxApp): InboxApp {
  return {
    ...app,
    items: app.items.map((item) =>
      item.kind === "report"
        ? { ...item, title: externalFence("inbox-report", app.namespace, item.title) }
        : item,
    ),
  };
}

export async function capsidStatus(
  env: Env,
  only?: string,
  // Omitted means unrestricted (the cron, the Portal). A scoped caller sees no credential inventory:
  // both map the boundary it sits behind.
  scope?: { namespaces: "*" | string[]; admin: boolean },
): Promise<StatusReport> {
  const allowed = scope?.namespaces ?? "*";
  const requested = only ? [only] : [...APP_ROSTER];
  const namespaces = allowed === "*" ? requested : requested.filter((n) => allowed.includes(n));
  const out: NamespaceStatus[] = [];

  const inboxAll = await gatherInbox(env, new Date(), namespaces);
  const maintenanceList = await readMaintenance(env);
  const maintenanceAll = maintenanceList?.items ?? [];

  for (const namespace of namespaces) {
    const report = await env.DB.prepare(
      `SELECT path, body, updated_at FROM documents
         WHERE namespace = ?1 AND path LIKE ?2 AND type = 'reference'
         ORDER BY path DESC LIMIT 1`,
    )
      .bind(namespace, `${REPORTS_PREFIX}lint-%`)
      .first<{ path: string; body: string | null; updated_at: string }>();

    out.push({
      namespace,
      breaker: await breakerState(env, namespace, new Date()),
      // ORDER BY path gives the newest ISO date; updated_at would give the latest rewrite.
      latest_report: report
        ? {
            path: `${namespace}/${report.path}`,
            integrity: integrityOf(report.body),
            generated: report.updated_at,
          }
        : null,
      jobs: await jobsSummary(env.DB, namespace, new Date(), env.IMPROVE_SCORE_SECRET),
      maintenance: maintenanceAll.filter((m) => m.namespace === namespace),
      maintenance_prs_read: maintenanceList?.prs_read[namespace] ?? null,
      maintenance_branches_read: maintenanceList?.branches_read[namespace] ?? null,
      needs_dustin: fenceReported(
        inboxAll.apps.find((a) => a.namespace === namespace) ?? {
          namespace,
          name: namespace,
          count: 0,
          severity: "none",
          items: [],
        },
      ),
    });
  }

  return {
    canon_paths: servedCanonPaths(),
    policies: await servedPolicies(env),
    overnight: await overnightState(env),
    // Admin only: the inventory is the map an agent looking to widen itself would want.
    ...(scope && !scope.admin ? {} : { agents: await agentSummaries(env.DB) }),
    namespaces: out,
  };
}
