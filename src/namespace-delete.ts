import { hmacHex, sha256Hex, timingSafeEqual } from "./auth";
import { b64urlDecode, b64urlEncode } from "./encoding";
import type { Env } from "./env";
import { onRoster } from "./roster";
import { POLICY_PREFIX } from "./signed-docs";
import { OPEN_JOB_STATUSES } from "./jobs-schema";
import { D1_BATCH_STATEMENTS } from "./limits";
import { isMissingRowAbort } from "./store-guards";
import { pathMutation } from "./tools/docs";

// Deleting a namespace (capsid_admin_manage_namespaces actions delete_preview and
// delete_perform): the plan, the refusals, the signed confirmation and the one batch.
// Its operation is registered in src/tools/namespaces.ts, admin only (TOOL_GRANTS in
// src/scope.ts). Ruled 2026-09-29, "Capsid MCP roadmap, build or don't build".
//
// Two calls, as the Portal's controls are (src/portal-actions.ts). The preview reads
// everything that names the namespace, writes nothing, and when nothing refuses returns
// a token signed over the namespace, cascade, allow_improve_paths, the plan's counts,
// the caller's actor and a five-minute expiry. The perform re-reads the plan, requires
// the token to match it exactly, and commits one batch whose first statement aborts it
// unless the store still is what the plan read.
//
// WHAT IS DELETED: every live document (any path not under archive/), each snapshotted
// to document_versions inside the batch before it goes and removed by
// pathMutation(db, ns, path, null), the one path mutation site (CLAUDE.md, path
// mutation rule); every edge touching one of those documents, removed by the same
// helper and recorded whole in the audit row; the ops_sites row,
// recorded whole in the audit row; and the namespaces row.
//
// WHAT IS KEPT, because it is history: archived documents (archive/...), every
// document_versions and audit_log row, finished jobs, job_outcomes, job_claims,
// job_touches, revoked agents that name the namespace, and the nightly backup
// objects. The kept
// archived documents still name a namespace that is no longer registered. The read
// tools (capsid_read_doc, capsid_find_docs, capsid_start_session) still return them by
// that name; capsid_write_doc and capsid_delete_doc refuse there until the namespace is registered again, and a
// later capsid_admin_manage_namespaces action register of the same name brings them back into scope.
//
// WHAT ALWAYS REFUSES, whatever cascade says: an open job (queued, claimed, blocked),
// a live agent whose scopes name the namespace, and a namespace on the roster.
// cascade reaches documents only. A namespace with more live documents than one batch
// can delete (NAMESPACE_DELETE_MAX_DOCUMENTS) is refused too, never half deleted.
//
// An edge whose end in this namespace names a path no document holds (already
// dangling) touches no deleted document, so pathMutation leaves it, as a document
// delete would; docs/schema.md, "Links", says dangling edges are reported, never
// repaired.

// The statements every perform batch carries besides the per-document ones: the plan
// guard, the snapshot, the audit row, the ops_sites delete and the namespaces delete.
const FIXED_STATEMENTS = 5;
// pathMutation(db, ns, path, null) is two statements: the edges, then the row.
const STATEMENTS_PER_DOCUMENT = 2;
/** The most live documents one delete_namespace batch can remove, from D1's batch
 *  ceiling (D1_BATCH_STATEMENTS in src/limits.ts). */
export const NAMESPACE_DELETE_MAX_DOCUMENTS = Math.floor((D1_BATCH_STATEMENTS - FIXED_STATEMENTS) / STATEMENTS_PER_DOCUMENT);

// Its own context string, so this key differs from the Portal's confirmation key and
// every other key derived from COOKIE_ENCRYPTION_KEY: a Portal token never verifies
// here. A version bump retires every outstanding token.
const TOKEN_CONTEXT = "capsid-namespace-delete:v1";
const DELETE_TOKEN_TTL_SECONDS = 5 * 60;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/;
// How many of each blocker a refusal names. The counts are always whole.
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
  // The whole ops_sites row, or null when the namespace has none.
  ops_site: Record<string, unknown> | null;
  ops_site_revision: number | null;
  open_jobs: Array<{ id: string; status: string; title: string }>;
  live_agents: string[];
  policy_paths: string[];
  // Every live path in path order, at most NAMESPACE_DELETE_MAX_DOCUMENTS + 1 of them:
  // one more than fits says the namespace is over the cap. The perform deletes exactly
  // these, and the token binds them, so a document swapped for another refuses.
  live_paths: string[];
  // sha256 of JSON.stringify(live_paths), which is what the fingerprint binds.
  live_paths_sha256: string;
}

export interface DeleteOptions {
  cascade: boolean;
  // allow_improve_paths keeps its name from the improve loop; it now covers only the
  // signed policy documents (policyWriteRefusal in src/signed-docs.ts).
  allowImprovePaths: boolean;
}

function count(result: D1Result | undefined): number {
  const row = result?.results?.[0] as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

function rows<T>(result: D1Result | undefined): T[] {
  return (result?.results ?? []) as T[];
}

/** Everything that names the namespace, read in one batch so the counts agree with
 *  each other. Writes nothing. */
export async function readDeletePlan(db: D1Database, namespace: string): Promise<DeletePlan> {
  const open = JSON.stringify(OPEN_JOB_STATUSES);
  const results = await db.batch([
    db.prepare("SELECT namespace FROM namespaces WHERE namespace = ?1").bind(namespace),
    db.prepare("SELECT COUNT(*) AS n FROM documents WHERE namespace = ?1 AND path NOT LIKE 'archive/%'").bind(namespace),
    db.prepare("SELECT COUNT(*) AS n FROM documents WHERE namespace = ?1 AND path LIKE 'archive/%'").bind(namespace),
    db.prepare("SELECT COUNT(*) AS n FROM document_versions WHERE namespace = ?1").bind(namespace),
    db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE namespace = ?1").bind(namespace),
    // The edges pathMutation will remove: those touching a live document.
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM document_links
         WHERE (from_ns = ?1 AND from_path IN (SELECT path FROM documents WHERE namespace = ?1 AND path NOT LIKE 'archive/%'))
            OR (to_ns = ?1 AND to_path IN (SELECT path FROM documents WHERE namespace = ?1 AND path NOT LIKE 'archive/%'))`
      )
      .bind(namespace),
    db.prepare("SELECT status, COUNT(*) AS n FROM jobs WHERE namespace = ?1 GROUP BY status").bind(namespace),
    db
      .prepare(
        `SELECT id, status, title FROM jobs
         WHERE namespace = ?1 AND status IN (SELECT value FROM json_each(?2))
         ORDER BY created_at, id LIMIT 20`
      )
      .bind(namespace, open),
    db.prepare("SELECT COUNT(*) AS n FROM job_outcomes WHERE namespace = ?1").bind(namespace),
    db.prepare("SELECT COUNT(*) AS n FROM job_claims WHERE namespace = ?1").bind(namespace),
    db.prepare("SELECT COUNT(*) AS n FROM job_touches WHERE namespace = ?1").bind(namespace),
    // The same reading of the scopes column as parseScopes (src/agents-schema.ts): a
    // row that is not a JSON object with a namespaces array names no namespace. The
    // nested CASE fixes the evaluation order, so json_type never sees malformed JSON.
    db
      .prepare(
        `SELECT name, revoked_at FROM agents
         WHERE CASE WHEN json_valid(scopes) THEN
           CASE WHEN json_type(scopes) = 'object' AND json_type(scopes, '$.namespaces') = 'array'
             THEN EXISTS (SELECT 1 FROM json_each(scopes, '$.namespaces') WHERE value = ?1) ELSE 0 END
         ELSE 0 END
         ORDER BY name`
      )
      .bind(namespace),
    // The signed policy documents (policyWriteRefusal in src/signed-docs.ts), matched
    // case-exactly on the same prefix. Deleting one is a ruling, so it needs
    // allow_improve_paths as a document delete does.
    db.prepare("SELECT COUNT(*) AS n FROM documents WHERE namespace = ?1 AND substr(path, 1, length(?2)) = ?2").bind(namespace, POLICY_PREFIX),
    db
      .prepare("SELECT path FROM documents WHERE namespace = ?1 AND substr(path, 1, length(?2)) = ?2 ORDER BY path LIMIT 20")
      .bind(namespace, POLICY_PREFIX),
    db
      .prepare(
        `SELECT namespace, name, origin, health_path, platform, script, self_probe, revision, created_at, updated_at
         FROM ops_sites WHERE namespace = ?1`
      )
      .bind(namespace),
    db
      .prepare("SELECT path FROM documents WHERE namespace = ?1 AND path NOT LIKE 'archive/%' ORDER BY path LIMIT ?2")
      .bind(namespace, NAMESPACE_DELETE_MAX_DOCUMENTS + 1),
  ]);

  const jobsByStatus: Record<string, number> = {};
  for (const row of rows<{ status: string; n: number }>(results[6])) jobsByStatus[row.status] = Number(row.n);
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

// The first NAMED entries, and how many more the count holds.
function named(list: string[], total: number): string {
  const shown = list.slice(0, NAMED);
  const rest = total - shown.length;
  return rest > 0 ? `${shown.join(", ")}, and ${rest} more` : shown.join(", ");
}

/** Why the delete may not happen, or an empty list. Pure. An unregistered namespace
 *  is the only refusal, since nothing else about it matters. */
export function deleteRefusals(plan: DeletePlan, opts: DeleteOptions): string[] {
  const ns = plan.namespace;
  if (!plan.registered) return [`namespace not found: ${ns}. There is no registered namespace to delete.`];
  const refusals: string[] = [];
  if (plan.on_roster) {
    refusals.push(
      `${ns} is on the roster (ROSTER in src/roster.ts), which the watcher, auto-merge and maintenance iterate by name. Remove it from the roster in code first; this tool will not.`
    );
  }
  if (plan.counts.jobs_open > 0) {
    const jobs = plan.open_jobs.map((j) => `${j.id} (${j.status}, '${j.title}')`);
    refusals.push(
      `${ns} has ${plan.counts.jobs_open} open job${plan.counts.jobs_open === 1 ? "" : "s"}: ${named(jobs, plan.counts.jobs_open)}. ` +
        `cascade never reaches jobs. End each with the capsid_work_jobs tool: action 'supersede' for a queued job, action 'fail' for a claimed or blocked one (the admin may fail a job another credential holds), or 'release' then 'supersede'.`
    );
  }
  if (plan.counts.agents_live > 0) {
    refusals.push(
      `${plan.counts.agents_live} live agent${plan.counts.agents_live === 1 ? " names" : "s name"} ${ns} in its scopes: ${named(plan.live_agents, plan.counts.agents_live)}. ` +
        `cascade never reaches agents. Use the capsid_admin_manage_agents tool: action 'revoke', or action 'update_scopes' to drop ${ns} from its namespaces.`
    );
  }
  if (plan.counts.documents_live > NAMESPACE_DELETE_MAX_DOCUMENTS) {
    refusals.push(
      `${ns} holds ${plan.counts.documents_live} live documents, and one delete_namespace batch deletes at most ${NAMESPACE_DELETE_MAX_DOCUMENTS} ` +
        `(D1's ${D1_BATCH_STATEMENTS}-statement batch ceiling: ${FIXED_STATEMENTS} fixed statements plus ${STATEMENTS_PER_DOCUMENT} per document). ` +
        `Delete documents with capsid_delete_doc, or move them with capsid_write_doc action move, first, or ask the seat to rule a set-based helper.`
    );
  }
  if (plan.counts.documents_live > 0 && !opts.cascade) {
    refusals.push(
      `${ns} holds ${plan.counts.documents_live} live document${plan.counts.documents_live === 1 ? "" : "s"}. Pass cascade: true to delete them; each is snapshotted to document_versions first. Archived documents (archive/...) are kept either way.`
    );
  }
  if (plan.counts.policy_documents > 0 && !opts.allowImprovePaths) {
    refusals.push(
      `${ns} holds ${plan.counts.policy_documents} signed policy document${plan.counts.policy_documents === 1 ? "" : "s"} (${named(plan.policy_paths, plan.counts.policy_documents)}). ` +
        `Deleting one is a ruling, so it needs allow_improve_paths: true, which needs the can_touch_protected flag and is audit-logged.`
    );
  }
  return refusals;
}

/** The part of the plan a token binds, in one canonical spelling: every count, the
 *  jobs by status, the ops_sites revision and the sha256 of the
 *  live path list (a digest, so fifty 512-character paths do not ride in the token).
 *  Any change between the preview and the perform changes this string. */
export function planFingerprint(plan: DeletePlan): string {
  const counts: Record<string, number> = {};
  for (const key of Object.keys(plan.counts).sort()) counts[key] = plan.counts[key as keyof PlanCounts];
  const jobs: Record<string, number> = {};
  for (const key of Object.keys(plan.jobs_by_status).sort()) jobs[key] = plan.jobs_by_status[key];
  return JSON.stringify({
    counts,
    jobs_by_status: jobs,
    ops_site_revision: plan.ops_site_revision,
    live_paths_sha256: plan.live_paths_sha256,
  });
}

/** The keys of two fingerprints that differ, for the refusal. Pure. */
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
      if (v && typeof v === "object" && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) out[`${k}.${k2}`] = JSON.stringify(v2);
      else out[k] = JSON.stringify(v);
    }
    return out;
  };
  const fa = flat(a);
  const fb = flat(b);
  const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort();
  return keys.filter((k) => fa[k] !== fb[k]).map((k) => `${k} ${fa[k] ?? "absent"} -> ${fb[k] ?? "absent"}`);
}

// ---- The confirmation token --------------------------------------------------------

export interface DeleteClaims {
  v: 1;
  namespace: string;
  cascade: boolean;
  allow_improve_paths: boolean;
  actor: string;
  plan: string;
  exp: number;
}

function canonicalClaims(c: DeleteClaims): string {
  return JSON.stringify({
    v: c.v,
    namespace: c.namespace,
    cascade: c.cascade,
    allow_improve_paths: c.allow_improve_paths,
    actor: c.actor,
    plan: c.plan,
    exp: c.exp,
  });
}

async function tokenKey(env: Pick<Env, "COOKIE_ENCRYPTION_KEY">): Promise<string> {
  // Fails closed: with no root secret there is nothing to sign with, and an empty key
  // would sign with a value anybody knows.
  if (!env.COOKIE_ENCRYPTION_KEY) throw new Error("COOKIE_ENCRYPTION_KEY is unset, so no delete confirmation can be signed or checked");
  return hmacHex(env.COOKIE_ENCRYPTION_KEY, TOKEN_CONTEXT);
}

export async function signDeleteToken(env: Pick<Env, "COOKIE_ENCRYPTION_KEY">, claims: DeleteClaims): Promise<string> {
  const payload = b64urlEncode(canonicalClaims(claims));
  return `${payload}.${await hmacHex(await tokenKey(env), payload)}`;
}

type Verified = { ok: true; claims: DeleteClaims } | { ok: false; refusal: string };

/** Checks the signature, the shape, the caller, the expiry and the arguments the token
 *  was signed for. The plan is compared by the caller after it re-reads it. */
export async function verifyDeleteToken(
  env: Pick<Env, "COOKIE_ENCRYPTION_KEY">,
  token: string,
  expect: { actor: string; namespace: string; cascade: boolean; allowImprovePaths: boolean },
  now: Date
): Promise<Verified> {
  if (!TOKEN_SHAPE.test(token)) return { ok: false, refusal: "the confirmation token is malformed: preview again." };
  const dot = token.indexOf(".");
  const payload = token.slice(0, dot);
  if (!timingSafeEqual(token.slice(dot + 1), await hmacHex(await tokenKey(env), payload))) {
    return { ok: false, refusal: "the confirmation token does not verify: preview again." };
  }
  let claims: DeleteClaims;
  try {
    claims = JSON.parse(b64urlDecode(payload)) as DeleteClaims;
  } catch (err) {
    // Signed by this Worker and unreadable: a defect, said so.
    return { ok: false, refusal: `the confirmation token verifies but does not parse (${err instanceof Error ? err.message : String(err)}): preview again.` };
  }
  if (
    claims?.v !== 1 ||
    typeof claims.namespace !== "string" ||
    typeof claims.cascade !== "boolean" ||
    typeof claims.allow_improve_paths !== "boolean" ||
    typeof claims.actor !== "string" ||
    typeof claims.plan !== "string" ||
    typeof claims.exp !== "number"
  ) {
    return { ok: false, refusal: "the confirmation token verifies but its claims are not the shape this Worker signs: preview again." };
  }
  if (claims.actor !== expect.actor) return { ok: false, refusal: "the confirmation was issued to another caller: preview again." };
  if (claims.exp * 1000 <= now.getTime()) return { ok: false, refusal: "the confirmation expired: preview again." };
  if (claims.namespace !== expect.namespace) {
    return { ok: false, refusal: `the confirmation was issued for namespace ${claims.namespace}, not ${expect.namespace}: preview again.` };
  }
  if (claims.cascade !== expect.cascade) {
    return { ok: false, refusal: `the confirmation was issued with cascade ${claims.cascade}, and this call passes ${expect.cascade}: preview again with the arguments you mean.` };
  }
  if (claims.allow_improve_paths !== expect.allowImprovePaths) {
    return {
      ok: false,
      refusal: `the confirmation was issued with allow_improve_paths ${claims.allow_improve_paths}, and this call passes ${expect.allowImprovePaths}: preview again with the arguments you mean.`,
    };
  }
  return { ok: true, claims };
}

// ---- Preview and perform ------------------------------------------------------------

function summarize(plan: DeletePlan): { will_delete: string[]; will_keep: string[] } {
  const c = plan.counts;
  return {
    will_delete: [
      `${c.documents_live} live document(s), each snapshotted to document_versions first`,
      `${c.document_links_removed} edge(s) touching those documents, recorded whole in the audit row (an already dangling edge touches none and stays)`,
      plan.ops_site ? `the ops_sites row (revision ${plan.ops_site_revision}), recorded whole in the audit row` : "no ops_sites row (there is none)",
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

export type ToolAnswer = { ok: true; data: unknown } | { ok: false; refusal: string };

export async function previewNamespaceDelete(
  env: Env,
  actor: string,
  namespace: string,
  opts: DeleteOptions,
  now: Date
): Promise<ToolAnswer> {
  let plan: DeletePlan;
  try {
    plan = await readDeletePlan(env.DB, namespace);
  } catch (err) {
    return { ok: false, refusal: `delete_namespace preview failed, nothing changed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const refusals = deleteRefusals(plan, opts);
  if (!plan.registered) return { ok: false, refusal: refusals[0] };
  const base = {
    namespace,
    action: "preview",
    verdict: refusals.length ? "refused" : "allowed",
    refusals,
    cascade: opts.cascade,
    allow_improve_paths: opts.allowImprovePaths,
    counts: plan.counts,
    jobs_by_status: plan.jobs_by_status,
    open_jobs: plan.open_jobs,
    live_agents: plan.live_agents,
    live_paths: plan.live_paths,
    max_documents: NAMESPACE_DELETE_MAX_DOCUMENTS,
    policy_paths: plan.policy_paths,
    ops_site: plan.ops_site,
    ...summarize(plan),
  };
  if (refusals.length) return { ok: true, data: base };
  const exp = Math.floor(now.getTime() / 1000) + DELETE_TOKEN_TTL_SECONDS;
  let token: string;
  try {
    token = await signDeleteToken(env, {
      v: 1,
      namespace,
      cascade: opts.cascade,
      allow_improve_paths: opts.allowImprovePaths,
      actor,
      plan: planFingerprint(plan),
      exp,
    });
  } catch (err) {
    return { ok: false, refusal: `delete_namespace preview failed, nothing changed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return {
    ok: true,
    data: {
      ...base,
      token,
      expires_at: new Date(exp * 1000).toISOString(),
      next: `Call capsid_admin_manage_namespaces with action 'delete_perform', the same namespace, cascade and allow_improve_paths, and this token within five minutes. Any change to what the preview counted refuses it.`,
    },
  };
}

// The batch's first statement: an INSERT that violates NOT NULL (the same abort as
// requireExists in src/store-guards.ts), fired unless the store is still what the plan
// read. The preview's reads are another transaction, so this is what makes the
// refusals and the counts hold at commit. The live set is pinned exactly: the count
// equals the plan's, and no live path lies outside the plan's list (?6, JSON), so a
// document swapped for another in between aborts too, and every live document the
// batch finds is one pathMutation below deletes.
function planGuard(db: D1Database, plan: DeletePlan, pathsJson: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO document_versions (document_id, namespace, path)
       SELECT NULL, ?1, 'delete_namespace'
       WHERE NOT (
         EXISTS (SELECT 1 FROM namespaces WHERE namespace = ?1)
         AND (SELECT COUNT(*) FROM documents WHERE namespace = ?1 AND path NOT LIKE 'archive/%') = ?2
         AND NOT EXISTS (SELECT 1 FROM documents WHERE namespace = ?1 AND path NOT LIKE 'archive/%'
                         AND path NOT IN (SELECT value FROM json_each(?6)))
         AND (SELECT COUNT(*) FROM document_links
              WHERE (from_ns = ?1 AND from_path IN (SELECT value FROM json_each(?6)))
                 OR (to_ns = ?1 AND to_path IN (SELECT value FROM json_each(?6)))) = ?3
         AND NOT EXISTS (SELECT 1 FROM jobs WHERE namespace = ?1 AND status IN (SELECT value FROM json_each(?4)))
         AND NOT EXISTS (SELECT 1 FROM agents WHERE revoked_at IS NULL AND
           CASE WHEN json_valid(scopes) THEN
             CASE WHEN json_type(scopes) = 'object' AND json_type(scopes, '$.namespaces') = 'array'
               THEN EXISTS (SELECT 1 FROM json_each(scopes, '$.namespaces') WHERE value = ?1) ELSE 0 END
           ELSE 0 END)
         AND (SELECT revision FROM ops_sites WHERE namespace = ?1) IS ?5
       )`
    )
    .bind(
      plan.namespace,
      plan.counts.documents_live,
      plan.counts.document_links_removed,
      JSON.stringify(OPEN_JOB_STATUSES),
      plan.ops_site_revision,
      pathsJson
    );
}

/**
 * The perform: the token, the plan read again, then one batch. Each live document is
 * deleted by pathMutation(db, namespace, path, null), the one site that deletes a
 * documents row (CLAUDE.md, path mutation rule), so the batch is FIXED_STATEMENTS plus
 * two per document and the cap refuses anything larger before it is built.
 */
export async function performNamespaceDelete(
  env: Env,
  actor: string,
  namespace: string,
  opts: DeleteOptions,
  token: string | undefined,
  now: Date
): Promise<ToolAnswer> {
  const db = env.DB;
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, refusal: "delete_perform needs the token capsid_admin_manage_namespaces action delete_preview returned. Preview first." };
  }
  let verified: Verified;
  try {
    verified = await verifyDeleteToken(env, token, { actor, namespace, cascade: opts.cascade, allowImprovePaths: opts.allowImprovePaths }, now);
  } catch (err) {
    return { ok: false, refusal: `delete_namespace refused, nothing changed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!verified.ok) return { ok: false, refusal: `delete_namespace refused, nothing changed: ${verified.refusal}` };

  let plan: DeletePlan;
  try {
    plan = await readDeletePlan(db, namespace);
  } catch (err) {
    return { ok: false, refusal: `delete_namespace failed, nothing changed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const refusals = deleteRefusals(plan, opts);
  if (refusals.length) return { ok: false, refusal: `delete_namespace refused, nothing changed: ${refusals.join(" ")}` };
  const current = planFingerprint(plan);
  if (current !== verified.claims.plan) {
    const changed = fingerprintDifference(verified.claims.plan, current);
    return {
      ok: false,
      refusal: `delete_namespace refused, nothing changed: the namespace changed since the preview (${changed.join("; ")}). Preview again.`,
    };
  }
  // The cap is in deleteRefusals, so this holds already; checked again because the
  // batch below is sized from this list, and a list the read truncated would delete
  // part of the namespace.
  const paths = plan.live_paths;
  if (paths.length !== plan.counts.documents_live || paths.length > NAMESPACE_DELETE_MAX_DOCUMENTS) {
    return {
      ok: false,
      refusal: `delete_namespace failed, nothing changed: the plan read ${paths.length} live paths for ${plan.counts.documents_live} live documents, with a cap of ${NAMESPACE_DELETE_MAX_DOCUMENTS}.`,
    };
  }
  const pathsJson = JSON.stringify(paths);
  const deletion = paths.flatMap((path) => pathMutation(db, namespace, path, null));

  // What the audit row carries besides what it reads inside the batch.
  const recorded = JSON.stringify({
    cascade: opts.cascade,
    allow_improve_paths: opts.allowImprovePaths,
    counts: plan.counts,
    jobs_by_status: plan.jobs_by_status,
    documents_deleted: paths,
  });
  let results: D1Result[];
  try {
    results = await db.batch([
      planGuard(db, plan, pathsJson),
      // Exactly the paths pathMutation deletes below, bound, from the rows the table
      // holds when the batch runs. The guard has pinned the live set to this list.
      db
        .prepare(
          `INSERT INTO document_versions (document_id, namespace, path, title, body)
           SELECT id, namespace, path, title, body FROM documents
           WHERE namespace = ?1 AND path IN (SELECT value FROM json_each(?2))
           RETURNING id`
        )
        .bind(namespace, pathsJson),
      // The one audit row, read inside the batch before anything is removed: the
      // edges, the whole ops_sites row and the namespaces row are recorded here and
      // nowhere else afterwards; the deleted paths ride in the plan. The aggregate
      // always yields a row.
      db
        .prepare(
          `INSERT INTO audit_log (actor, action, namespace, path, params)
           SELECT ?1, 'namespace-delete', ?2, NULL, json_object(
             'plan', json(?3),
             'edges_removed', json_group_array(json_object('from_ns', from_ns, 'from_path', from_path, 'type', type, 'to_ns', to_ns, 'to_path', to_path)),
             'ops_site', json((SELECT json_object('namespace', namespace, 'name', name, 'origin', origin, 'health_path', health_path,
                 'platform', platform, 'script', script, 'self_probe', self_probe, 'revision', revision,
                 'created_at', created_at, 'updated_at', updated_at) FROM ops_sites WHERE namespace = ?2)),
             'namespace_row', json((SELECT json_object('namespace', namespace, 'repos', repos, 'created_at', created_at) FROM namespaces WHERE namespace = ?2)))
           FROM document_links
           WHERE (from_ns = ?2 AND from_path IN (SELECT value FROM json_each(?4)))
              OR (to_ns = ?2 AND to_path IN (SELECT value FROM json_each(?4)))
           RETURNING params`
        )
        .bind(actor, namespace, recorded, pathsJson),
      db.prepare("DELETE FROM ops_sites WHERE namespace = ?1 RETURNING namespace").bind(namespace),
      db.prepare("DELETE FROM namespaces WHERE namespace = ?1 RETURNING namespace").bind(namespace),
      ...deletion,
    ]);
  } catch (err) {
    if (isMissingRowAbort(err)) {
      return {
        ok: false,
        refusal: `delete_namespace aborted, nothing changed: ${namespace} changed between the plan and the commit (a document, an edge, an open job, a live agent or its ops_sites row). Preview again.`,
      };
    }
    return { ok: false, refusal: `delete_namespace failed, nothing changed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Counted from RETURNING, never meta.changes (CLAUDE.md, path mutation rule). The
  // batch committed, so the guard held: the live set was exactly `paths`, and
  // pathMutation deleted each of them.
  const snapshots = rows(results[1]).length;
  const auditParams = rows<{ params: string }>(results[2])[0]?.params;
  let edgesRemoved = 0;
  if (auditParams) edgesRemoved = (JSON.parse(auditParams) as { edges_removed: unknown[] }).edges_removed.length;
  const siteRemoved = rows(results[3]).length > 0;
  const documentsDeleted = paths.length;

  return {
    ok: true,
    data: {
      namespace,
      action: "deleted",
      documents_deleted: documentsDeleted,
      snapshots,
      edges_removed: edgesRemoved,
      ops_site_removed: siteRemoved,
      kept: {
        documents_archived: plan.counts.documents_archived,
        document_versions: plan.counts.document_versions + snapshots,
        jobs_finished: plan.counts.jobs_finished,
        agents_revoked: plan.counts.agents_revoked,
      },
    },
  };
}
