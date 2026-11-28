import { onRoster } from "./roster";
import { POLICY_PREFIX } from "./signed-docs";
import { OPEN_JOB_STATUSES } from "./jobs-schema";
import { D1_BATCH_STATEMENTS } from "./limits";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";

import { plural } from "@drdustinedwards/site-helpers/text";
// An edge already dangling at this namespace's end touches no deleted document, so pathMutation
// leaves it, as a document delete would (docs/schema.md, "Links": dangling edges are reported,
// never repaired).

// The statements every perform batch carries besides the per-document ones: the plan guard, the
// snapshot, the audit row, the ops_sites delete and the namespaces delete.
const FIXED_STATEMENTS = 5;
const STATEMENTS_PER_DOCUMENT = 2;
/**
 * The most live documents one delete_namespace batch can remove, from D1's batch ceiling
 * (D1_BATCH_STATEMENTS in src/limits.ts).
 */
export const NAMESPACE_DELETE_MAX_DOCUMENTS = Math.floor(
  (D1_BATCH_STATEMENTS - FIXED_STATEMENTS) / STATEMENTS_PER_DOCUMENT,
);

const NAMED = 20;

export interface PlanCounts {
  documents_live: number;
  documents_archived: number;
  document_versions: number;
  audit_log: number;
  document_links_removed: number;
  jobs_open: number;
  jobs_finished: number;
  job_outcomes: number;
  job_claims: number;
  job_touches: number;
  agents_live: number;
  agents_revoked: number;
  policy_documents: number;
}

export interface DeletePlan {
  namespace: string;
  registered: boolean;
  on_roster: boolean;
  counts: PlanCounts;
  jobs_by_status: Record<string, number>;
  ops_site: Record<string, unknown> | null;
  ops_site_revision: number | null;
  open_jobs: Array<{ id: string; status: string; title: string }>;
  live_agents: string[];
  policy_paths: string[];
  // Every live path in path order, at most NAMESPACE_DELETE_MAX_DOCUMENTS + 1 of them: one more than
  // fits says the namespace is over the cap. The perform deletes exactly these, and the token binds
  // them, so a document swapped for another refuses.
  live_paths: string[];
  live_paths_sha256: string;
}

export interface DeleteOptions {
  cascade: boolean;
  // allow_improve_paths keeps its name from the improve loop; it now covers only the signed policy
  // documents (policyWriteRefusal in src/signed-docs.ts).
  allowImprovePaths: boolean;
}

function count(result: D1Result | undefined): number {
  const row = result?.results?.[0] as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

export function rows<T>(result: D1Result | undefined): T[] {
  return (result?.results ?? []) as T[];
}

/**
 * Everything that names the namespace, read in one batch so the counts agree with each other.
 * Writes nothing.
 */
export async function readDeletePlan(db: D1Database, namespace: string): Promise<DeletePlan> {
  const open = JSON.stringify(OPEN_JOB_STATUSES);
  const results = await db.batch([
    db.prepare("SELECT namespace FROM namespaces WHERE namespace = ?1").bind(namespace),
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM documents WHERE namespace = ?1 AND path NOT LIKE 'archive/%'",
      )
      .bind(namespace),
    db
      .prepare("SELECT COUNT(*) AS n FROM documents WHERE namespace = ?1 AND path LIKE 'archive/%'")
      .bind(namespace),
    db.prepare("SELECT COUNT(*) AS n FROM document_versions WHERE namespace = ?1").bind(namespace),
    db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE namespace = ?1").bind(namespace),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM document_links
         WHERE (from_ns = ?1 AND from_path IN (SELECT path FROM documents WHERE namespace = ?1 AND path NOT LIKE 'archive/%'))
            OR (to_ns = ?1 AND to_path IN (SELECT path FROM documents WHERE namespace = ?1 AND path NOT LIKE 'archive/%'))`,
      )
      .bind(namespace),
    db
      .prepare("SELECT status, COUNT(*) AS n FROM jobs WHERE namespace = ?1 GROUP BY status")
      .bind(namespace),
    db
      .prepare(
        `SELECT id, status, title FROM jobs
         WHERE namespace = ?1 AND status IN (SELECT value FROM json_each(?2))
         ORDER BY created_at, id LIMIT 20`,
      )
      .bind(namespace, open),
    db.prepare("SELECT COUNT(*) AS n FROM job_outcomes WHERE namespace = ?1").bind(namespace),
    db.prepare("SELECT COUNT(*) AS n FROM job_claims WHERE namespace = ?1").bind(namespace),
    db.prepare("SELECT COUNT(*) AS n FROM job_touches WHERE namespace = ?1").bind(namespace),
    // The same reading of the scopes column as parseScopes (src/agents-schema.ts): a row that is not a
    // JSON object with a namespaces array names no namespace. The nested CASE fixes the evaluation
    // order, so json_type never sees malformed JSON.
    db
      .prepare(
        `SELECT name, revoked_at FROM agents
         WHERE CASE WHEN json_valid(scopes) THEN
           CASE WHEN json_type(scopes) = 'object' AND json_type(scopes, '$.namespaces') = 'array'
             THEN EXISTS (SELECT 1 FROM json_each(scopes, '$.namespaces') WHERE value = ?1) ELSE 0 END
         ELSE 0 END
         ORDER BY name`,
      )
      .bind(namespace),
    // The signed policy documents (policyWriteRefusal in src/signed-docs.ts), matched case-exactly on
    // the same prefix. Deleting one is a ruling, so it needs allow_improve_paths as a document delete
    // does.
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM documents WHERE namespace = ?1 AND substr(path, 1, length(?2)) = ?2",
      )
      .bind(namespace, POLICY_PREFIX),
    db
      .prepare(
        "SELECT path FROM documents WHERE namespace = ?1 AND substr(path, 1, length(?2)) = ?2 ORDER BY path LIMIT 20",
      )
      .bind(namespace, POLICY_PREFIX),
    db
      .prepare(
        `SELECT namespace, name, origin, health_path, platform, script, self_probe, revision, created_at, updated_at
         FROM ops_sites WHERE namespace = ?1`,
      )
      .bind(namespace),
    db
      .prepare(
        "SELECT path FROM documents WHERE namespace = ?1 AND path NOT LIKE 'archive/%' ORDER BY path LIMIT ?2",
      )
      .bind(namespace, NAMESPACE_DELETE_MAX_DOCUMENTS + 1),
  ]);

  const jobsByStatus: Record<string, number> = {};
  for (const row of rows<{ status: string; n: number }>(results[6]))
    jobsByStatus[row.status] = Number(row.n);
  let jobsOpen = 0;
  let jobsFinished = 0;
  for (const [status, n] of Object.entries(jobsByStatus)) {
    if ((OPEN_JOB_STATUSES as readonly string[]).includes(status)) jobsOpen += n;
    else jobsFinished += n;
  }
  const agents = rows<{ name: string; revoked_at: string | null }>(results[11]);
  const live = agents.filter((a) => a.revoked_at === null).map((a) => a.name);
  const site = rows<Record<string, unknown>>(results[14])[0] ?? null;

  const livePaths = rows<{ path: string }>(results[15]).map((r) => r.path);
  return {
    namespace,
    registered: rows(results[0]).length > 0,
    on_roster: onRoster(namespace),
    counts: {
      documents_live: count(results[1]),
      documents_archived: count(results[2]),
      document_versions: count(results[3]),
      audit_log: count(results[4]),
      document_links_removed: count(results[5]),
      jobs_open: jobsOpen,
      jobs_finished: jobsFinished,
      job_outcomes: count(results[8]),
      job_claims: count(results[9]),
      job_touches: count(results[10]),
      agents_live: live.length,
      agents_revoked: agents.length - live.length,
      policy_documents: count(results[12]),
    },
    jobs_by_status: jobsByStatus,
    ops_site: site,
    ops_site_revision: site ? Number(site.revision) : null,
    open_jobs: rows<{ id: string; status: string; title: string }>(results[7]),
    live_agents: live,
    live_paths: livePaths,
    live_paths_sha256: await sha256Hex(JSON.stringify(livePaths)),
    policy_paths: rows<{ path: string }>(results[13]).map((r) => r.path),
  };
}

function named(list: string[], total: number): string {
  const shown = list.slice(0, NAMED);
  const rest = total - shown.length;
  return rest > 0 ? `${shown.join(", ")}, and ${rest} more` : shown.join(", ");
}

/**
 * Why the delete may not happen, or an empty list. Pure. An unregistered namespace is the only
 * refusal, since nothing else about it matters.
 */
export function deleteRefusals(plan: DeletePlan, opts: DeleteOptions): string[] {
  const ns = plan.namespace;
  if (!plan.registered)
    return [`namespace not found: ${ns}. There is no registered namespace to delete.`];
  const refusals: string[] = [];
  if (plan.on_roster) {
    refusals.push(
      `${ns} is on the roster (ROSTER in src/roster.ts), which the watcher and maintenance iterate by name. Remove it from the roster in code first; this tool will not.`,
    );
  }
  if (plan.counts.jobs_open > 0) {
    const jobs = plan.open_jobs.map((j) => `${j.id} (${j.status}, '${j.title}')`);
    refusals.push(
      `${ns} has ${plural(plan.counts.jobs_open, "open job")}: ${named(jobs, plan.counts.jobs_open)}. ` +
        `cascade never reaches jobs. End each with the capsid_work_jobs tool: action 'supersede' for a queued job, action 'fail' for a claimed or blocked one (the admin may fail a job another credential holds), or 'release' then 'supersede'.`,
    );
  }
  if (plan.counts.agents_live > 0) {
    refusals.push(
      `${plan.counts.agents_live} live agent${plan.counts.agents_live === 1 ? " names" : "s name"} ${ns} in its scopes: ${named(plan.live_agents, plan.counts.agents_live)}. ` +
        `cascade never reaches agents. Use the capsid_admin_manage_agents tool: action 'revoke', or action 'update_scopes' to drop ${ns} from its namespaces.`,
    );
  }
  if (plan.counts.documents_live > NAMESPACE_DELETE_MAX_DOCUMENTS) {
    refusals.push(
      `${ns} holds ${plan.counts.documents_live} live documents, and one delete_namespace batch deletes at most ${NAMESPACE_DELETE_MAX_DOCUMENTS} ` +
        `(D1's ${D1_BATCH_STATEMENTS}-statement batch ceiling: ${FIXED_STATEMENTS} fixed statements plus ${STATEMENTS_PER_DOCUMENT} per document). ` +
        `Delete documents with capsid_delete_doc, or move them with capsid_write_doc action move, first, or ask the seat to rule a set-based helper.`,
    );
  }
  if (plan.counts.documents_live > 0 && !opts.cascade) {
    refusals.push(
      `${ns} holds ${plural(plan.counts.documents_live, "live document")}. Pass cascade: true to delete them; each is snapshotted to document_versions first. Archived documents (archive/...) are kept either way.`,
    );
  }
  if (plan.counts.policy_documents > 0 && !opts.allowImprovePaths) {
    refusals.push(
      `${ns} holds ${plural(plan.counts.policy_documents, "signed policy document")} (${named(plan.policy_paths, plan.counts.policy_documents)}). ` +
        `Deleting one is a ruling, so it needs allow_improve_paths: true, which needs the can_touch_protected flag and is audit-logged.`,
    );
  }
  return refusals;
}

export function planFingerprint(plan: DeletePlan): string {
  const counts: Record<string, number> = {};
  for (const key of Object.keys(plan.counts).sort())
    counts[key] = plan.counts[key as keyof PlanCounts];
  const jobs: Record<string, number> = {};
  for (const key of Object.keys(plan.jobs_by_status).sort()) jobs[key] = plan.jobs_by_status[key];
  return JSON.stringify({
    counts,
    jobs_by_status: jobs,
    ops_site_revision: plan.ops_site_revision,
    live_paths_sha256: plan.live_paths_sha256,
  });
}

export function fingerprintDifference(signed: string, current: string): string[] {
  let a: Record<string, unknown>;
  let b: Record<string, unknown>;
  try {
    a = JSON.parse(signed) as Record<string, unknown>;
    b = JSON.parse(current) as Record<string, unknown>;
  } catch {
    return ["the plan"];
  }
  const flat = (o: Record<string, unknown>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === "object" && !Array.isArray(v))
        for (const [k2, v2] of Object.entries(v)) out[`${k}.${k2}`] = JSON.stringify(v2);
      else out[k] = JSON.stringify(v);
    }
    return out;
  };
  const fa = flat(a);
  const fb = flat(b);
  const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort();
  return keys
    .filter((k) => fa[k] !== fb[k])
    .map((k) => `${k} ${fa[k] ?? "absent"} -> ${fb[k] ?? "absent"}`);
}

export function summarize(plan: DeletePlan): { will_delete: string[]; will_keep: string[] } {
  const c = plan.counts;
  return {
    will_delete: [
      `${c.documents_live} live document(s), each snapshotted to document_versions first`,
      `${c.document_links_removed} edge(s) touching those documents, recorded whole in the audit row (an already dangling edge touches none and stays)`,
      plan.ops_site
        ? `the ops_sites row (revision ${plan.ops_site_revision}), recorded whole in the audit row`
        : "no ops_sites row (there is none)",
      `the namespaces row and its repo mapping, recorded in the audit row`,
    ],
    will_keep: [
      `${c.documents_archived} archived document(s) under archive/, still readable by this namespace name; write, delete, move and restore refuse there until the namespace is registered again`,
      `${c.document_versions} document_versions row(s) and ${c.audit_log} audit_log row(s)`,
      `${c.jobs_finished} finished job(s), ${c.job_outcomes} job_outcomes, ${c.job_claims} job_claims, ${c.job_touches} job_touches row(s)`,
      `${c.agents_revoked} revoked agent(s) that name it`,
      "the nightly backup objects",
    ],
  };
}
