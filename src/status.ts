import { overnightState, type OvernightState } from "./overnight";
import type { Env } from "./env";
import { APP_ROSTER } from "./roster";
import { pendingProposals, servedCanonPaths, type PendingProposal } from "./canon";
import { loadGatePolicy } from "./gate-policy";
import { loadMergePolicy } from "./auto-merge-policy";
import { breakerState, type BreakerState } from "./job-breaker";
import { SCOPE_FLAGS, parseScopes } from "./agents-schema";
import { loadAgentRecords, type AgentRecord } from "./agent-record";
import { jobsSummary, type JobsSummary } from "./jobs";
import { integrityOf, REPORTS_PREFIX } from "./truth-report";
import { AWAITING_SEAT_KEY, type AwaitingSeat } from "./auto-merge-tick";
import { gatherInbox, type InboxApp } from "./inbox";
import { readSafetyReport } from "./merge-safety";
import type { OpsMergeSafety } from "./ops-types";
import { externalFence } from "./provenance";
import { readMaintenance, type MaintenanceItem } from "./maintenance";

// Capsid's status as a driver and the Portal read it (capsid_run_improve action status,
// GET /portal/api/namespaces): per namespace the queue, the breaker, what waits on the
// seat and the maintenance list, and across them the signed policies, the overnight
// switch, the merge safety meter and, for the admin, the credential inventory. The
// tool keeps the improve loop's name, which it was served under before the loop was
// removed (Dustin, 2026-10-19), so no credential's tools list has to change.

interface NamespaceStatus {
  namespace: string;
  // The queue's circuit breaker (src/job-breaker.ts): open when the namespace's drivers
  // failed the threshold of jobs in 24 hours, until the seat or Dustin resets it.
  breaker: BreakerState;
  // The latest `capsid_lint_namespace` report document under reports/. null means no report was ever
  // run here, which is not an integrity of zero.
  latest_report: { path: string; integrity: number | null; generated: string } | null;
  // Counts for the open states and today's moves, plus the blocked jobs themselves with
  // the command each waits on, because a count alone tells nobody what to run.
  jobs: JobsSummary;
  // Pull requests the auto-merge policy declined, each with the refusing check. The
  // tick rewrites the whole list, so it needs no expiry. Empty when the policy is off.
  awaiting_seat: AwaitingSeat[];
  // The daily maintenance pass's list for this namespace (src/maintenance.ts): stale or
  // mislabelled jobs, what was resumed for the seat, green driver pull requests waiting,
  // pull requests red for days, and merged or old branches. Empty before the first pass.
  maintenance: MaintenanceItem[];
  // Open pull requests that pass read in this namespace, so an empty pull request list can
  // be told from one that read nothing. null when the pass did not read them (never ran,
  // not a roster namespace, or the read failed and a prs-not-checked item says why).
  maintenance_prs_read: number | null;
  // Branches that pass read in this namespace, the same way: null when it read none.
  maintenance_branches_read: number | null;
  // What needs Dustin in this namespace's app (src/inbox.ts): blocked jobs and questions,
  // pull requests auto-merge declined, a failing CI run, a site that is down. The same
  // answer GET /ops/inbox serves the admin shell, narrowed to this namespace.
  needs_dustin: InboxApp;
}

export interface StatusReport {
  // The canon documents a driver's write turns into a proposal (src/canon.ts), so a
  // driver knows before it writes.
  canon_paths: ReturnType<typeof servedCanonPaths>;
  // Admin only: the proposals waiting for approval.
  canon_proposals?: PendingProposal[];
  // The version a driver passes as approved_by_policy, served here because a
  // namespace-scoped driver cannot read the capsid namespace. Only the version and
  // whether it is on, never the body. Reported only when the policy loads (signature
  // verified, agreeing with the code); otherwise the reason it does not.
  policies: PolicyVersions;
  // The overnight run's switch and, when it runs on the subscription, the recorded
  // decision (src/overnight.ts). The scheduler reads this before it starts a session.
  overnight: OvernightState;
  // The auto-merge safety meter and shutoff (src/merge-safety.ts): the last seven days per
  // namespace and whether auto-merge is paused there, from the report the tick keeps, so
  // asking costs one KV read. Null before the tick's first pass. A scoped caller sees its
  // own namespaces' rows only.
  merge_safety: OpsMergeSafety | null;
  // The credential inventory. Revoked rows are included and say so, so "revoked" and
  // "never existed" look different. Never the key or the stored verifier, and only the
  // flags an agent holds. Absent, not empty, for a scoped caller: an empty list would
  // read as "no agents exist".
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
  // When the watcher pass moved it to agents_archive (src/agents-archive.ts), or null
  // for a row still in agents. An archived agent is always revoked.
  archived_at: string | null;
  // What this credential has done, from job_outcomes. Counts and rates, never a
  // composite score (src/agent-record.ts says why).
  record: AgentRecord;
}

// Exported for the Watch Floor feed (src/ops-feed.ts), which lists the same inventory
// with the same records rather than a second reading of the agents table.
// The archive is read newest move first and bounded: the archive grows as revoked agents
// move out of the live table. The full archive is agents list with
// archived: true.
const SUMMARY_ARCHIVE_LIMIT = 50;

export async function agentSummaries(db: D1Database): Promise<AgentSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT name, kind, scopes, last_seen, revoked_at, NULL AS archived_at FROM agents
       UNION ALL
       SELECT * FROM (SELECT name, kind, scopes, last_seen, revoked_at, archived_at FROM agents_archive ORDER BY archived_at DESC, name LIMIT ?1)`
    )
    .bind(SUMMARY_ARCHIVE_LIMIT)
    .all<{ name: string; kind: string; scopes: string; last_seen: string | null; revoked_at: string | null; archived_at: string | null }>();
  // Live first, then revoked, then archived; by name within each.
  const rank = (r: { revoked_at: string | null; archived_at: string | null }) => (r.archived_at ? 2 : r.revoked_at ? 1 : 0);
  const rows = [...(results ?? [])].sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
      archived_at: row.archived_at,
    };
  });
  // Three grouped reads for the whole inventory, not three per credential.
  const records = await loadAgentRecords(db, inventory);
  return inventory.map((agent) => ({ ...agent, record: records[agent.name] }));
}

/** One signed policy as a driver needs it: which version, and whether it is on. */
type ServedPolicy = { version: string; enabled: boolean } | { reason: string };

interface PolicyVersions {
  gates: ServedPolicy;
  auto_merge: ServedPolicy;
}

async function servedPolicies(env: Env): Promise<PolicyVersions> {
  // Each load verifies the stored document's signature and checks it describes no less
  // than the code enforces. A throw is reported, not raised: a driver asking what
  // version is current should not have status fail because a policy is being re-signed.
  const one = async (load: () => Promise<{ policy: { version: string; enabled: boolean } } | { error: string }>): Promise<ServedPolicy> => {
    try {
      const loaded = await load();
      return "error" in loaded ? { reason: loaded.error } : { version: loaded.policy.version, enabled: loaded.policy.enabled };
    } catch (err) {
      return { reason: `the policy could not be read: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
  return { gates: await one(() => loadGatePolicy(env)), auto_merge: await one(() => loadMergePolicy(env)) };
}

// An item an app reported about itself is the app's words, and an agent reads
// capsid_run_improve action status, so its title is relayed inside an external fence (src/provenance.ts,
// OWASP item 1; capsid/research/design-inbox-report.md, "Trust").
function fenceReported(app: InboxApp): InboxApp {
  return { ...app, items: app.items.map((item) => (item.kind === "report" ? { ...item, title: externalFence("inbox-report", app.namespace, item.title) } : item)) };
}

export async function capsidStatus(
  env: Env,
  only?: string,
  // The caller's namespaces and whether it is the admin, supplied by the tool from the
  // resolved agent. Omitted means unrestricted (the cron, the Portal). A scoped caller
  // sees only its own namespaces and no credential inventory, because both map the
  // boundary it sits behind.
  scope?: { namespaces: "*" | string[]; admin: boolean }
): Promise<StatusReport> {
  const allowed = scope?.namespaces ?? "*";
  const requested = only ? [only] : [...APP_ROSTER];
  const namespaces = allowed === "*" ? requested : requested.filter((n) => allowed.includes(n));
  const out: NamespaceStatus[] = [];

  // One read for every namespace. An unreadable or malformed key reports an empty set
  // rather than failing status.
  let awaitingAll: AwaitingSeat[] = [];
  try {
    const raw = await env.APP_KV.get(AWAITING_SEAT_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) awaitingAll = parsed as AwaitingSeat[];
    }
  } catch {
    awaitingAll = [];
  }
  const mergeSafety = await readSafetyReport(env.APP_KV);
  const inboxAll = await gatherInbox(env, new Date(), namespaces);
  const maintenanceList = await readMaintenance(env);
  const maintenanceAll = maintenanceList?.items ?? [];

  for (const namespace of namespaces) {
    const report = await env.DB
      .prepare(
        `SELECT path, body, updated_at FROM documents
         WHERE namespace = ?1 AND path LIKE ?2 AND type = 'reference'
         ORDER BY path DESC LIMIT 1`
      )
      .bind(namespace, `${REPORTS_PREFIX}lint-%`)
      .first<{ path: string; body: string | null; updated_at: string }>();

    out.push({
      namespace,
      breaker: await breakerState(env, namespace, new Date()),
      // The filename is ISO-dated, so ORDER BY path gives the newest date. updated_at
      // would give the most recently rewritten report instead.
      latest_report: report
        ? { path: `${namespace}/${report.path}`, integrity: integrityOf(report.body), generated: report.updated_at }
        : null,
      jobs: await jobsSummary(env.DB, namespace, new Date(), env.IMPROVE_SCORE_SECRET),
      awaiting_seat: awaitingAll.filter((a) => a.namespace === namespace),
      maintenance: maintenanceAll.filter((m) => m.namespace === namespace),
      maintenance_prs_read: maintenanceList?.prs_read[namespace] ?? null,
      maintenance_branches_read: maintenanceList?.branches_read[namespace] ?? null,
      needs_dustin: fenceReported(inboxAll.apps.find((a) => a.namespace === namespace) ?? { namespace, name: namespace, count: 0, severity: "none", items: [] }),
    });
  }

  return {
    canon_paths: servedCanonPaths(),
    policies: await servedPolicies(env),
    overnight: await overnightState(env),
    merge_safety: mergeSafety && allowed !== "*" ? { ...mergeSafety, namespaces: mergeSafety.namespaces.filter((n) => allowed.includes(n.namespace)) } : mergeSafety,
    // Admin only: the inventory is the map an agent looking to widen itself would want.
    ...(scope && !scope.admin ? {} : { agents: await agentSummaries(env.DB), canon_proposals: await pendingProposals(env.DB) }),
    namespaces: out,
  };
}
