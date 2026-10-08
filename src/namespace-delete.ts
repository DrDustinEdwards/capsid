import { hmacHex, sha256Hex, timingSafeEqual } from "./auth";
import { b64urlDecode, b64urlEncode } from "./encoding";
import type { Env } from "./env";
import {
  anchorKey,
  bestKey,
  driverKey,
  onRoster,
  pausedKey,
  POLICY_PREFIX,
  PROMPTS_PREFIX,
  RUN_TASK_PREFIX,
  SCORES_PATH,
  SKILLS_PREFIX,
} from "./improve-schema";
import { OPEN_JOB_STATUSES } from "./jobs-schema";
import { D1_BATCH_STATEMENTS } from "./limits";
import { isMissingRowAbort } from "./store-guards";
import { pathMutation } from "./tools/docs";
import { logEvent } from "./log";

// delete_namespace: the plan, the refusals, the signed confirmation and the one batch.
// The tool is registered in src/tools/namespaces.ts, admin only (TOOL_GRANTS in
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
// recorded whole in the audit row; the namespaces row; and, after the batch commits,
// the namespace's four improve KV keys.
//
// WHAT IS KEPT, because it is history: archived documents (archive/...), every
// document_versions and audit_log row, finished jobs, job_outcomes, job_claims,
// job_touches, skill_evaluations, skill_failures, every improve_* row, improve_jti,
// revoked agents that name the namespace, the nightly backup objects, and the holdout
// bucket (CLAUDE.md, improve loop rule: only src/improve-scorer.ts names it). The kept
// archived documents still name a namespace that is no longer registered. The read
// tools (read, list, search, brief, history) still return them by that name; write,
// delete, move and restore refuse there until the namespace is registered again, and a
// later register_namespace of the same name brings them back into scope.
//
// WHAT ALWAYS REFUSES, whatever cascade says: an open job (queued, claimed, blocked),
// a live agent whose scopes name the namespace, and a namespace on the improve roster.
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
  skill_evaluations: number;
  skill_failures: number;
  improve_runs: number;
  improve_attempts: number;
  improve_scores: number;
  improve_skills: number;
  improve_jti: number;
  agents_live: number;
  agents_revoked: number;
  improve_control_documents: number;
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
  improve_control_paths: string[];
  // The improve KV keys that hold a value now.
  kv_keys: string[];
  // Every live path in path order, at most NAMESPACE_DELETE_MAX_DOCUMENTS + 1 of them:
  // one more than fits says the namespace is over the cap. The perform deletes exactly
  // these, and the token binds them, so a document swapped for another refuses.
  live_paths: string[];
  // sha256 of JSON.stringify(live_paths), which is what the fingerprint binds.
  live_paths_sha256: string;
}

export interface DeleteOptions {
  cascade: boolean;
  allowImprovePaths: boolean;
}

/** Every improve KV key the Worker keeps per namespace (src/improve-schema.ts). */
export function improveKvKeys(namespace: string): string[] {
  return [bestKey(namespace), pausedKey(namespace), anchorKey(namespace), driverKey(namespace)];
}

function count(result: D1Result | undefined): number {
  const row = result?.results?.[0] as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

function rows<T>(result: D1Result | undefined): T[] {
  return (result?.results ?? []) as T[];
}

/** Everything that names the namespace, read in one batch so the counts agree with
 *  each other. Writes nothing. A KV read that fails throws, and the caller fails
 *  closed with the reason (CLAUDE.md, no swallowed error rule). */
export async function readDeletePlan(db: D1Database, kv: KVNamespace, namespace: string): Promise<DeletePlan> {
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
    db.prepare("SELECT COUNT(*) AS n FROM skill_evaluations WHERE namespace = ?1").bind(namespace),
    db.prepare("SELECT COUNT(*) AS n FROM skill_failures WHERE namespace = ?1").bind(namespace),
    db.prepare("SELECT COUNT(*) AS n FROM improve_runs WHERE namespace = ?1").bind(namespace),
    db.prepare("SELECT COUNT(*) AS n FROM improve_attempts WHERE namespace = ?1").bind(namespace),
    db.prepare("SELECT COUNT(*) AS n FROM improve_scores WHERE namespace = ?1").bind(namespace),
    db.prepare("SELECT COUNT(*) AS n FROM improve_skills WHERE source_namespace = ?1").bind(namespace),
    db.prepare("SELECT COUNT(*) AS n FROM improve_jti WHERE scope = ?1").bind(namespace),
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
    // The improve loop's control surface (improveWriteRefusal in src/improve-scores.ts),
    // matched case-exactly on the same prefixes. Deleting one of these is a steering
    // change, so it needs allow_improve_paths as a document delete does.
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM documents WHERE namespace = ?1 AND (
           substr(path, 1, length(?2)) = ?2 OR substr(path, 1, length(?3)) = ?3 OR
           substr(path, 1, length(?4)) = ?4 OR substr(path, 1, length(?5)) = ?5 OR path = ?6)`
      )
      .bind(namespace, RUN_TASK_PREFIX, PROMPTS_PREFIX, POLICY_PREFIX, SKILLS_PREFIX, SCORES_PATH),
    db
      .prepare(
        `SELECT path FROM documents WHERE namespace = ?1 AND (
           substr(path, 1, length(?2)) = ?2 OR substr(path, 1, length(?3)) = ?3 OR
           substr(path, 1, length(?4)) = ?4 OR substr(path, 1, length(?5)) = ?5 OR path = ?6)
         ORDER BY path LIMIT 20`
      )
      .bind(namespace, RUN_TASK_PREFIX, PROMPTS_PREFIX, POLICY_PREFIX, SKILLS_PREFIX, SCORES_PATH),
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
  const agents = rows<{ name: string; revoked_at: string | null }>(results[18]);
  const live = agents.filter((a) => a.revoked_at === null).map((a) => a.name);
  const site = rows<Record<string, unknown>>(results[21])[0] ?? null;

  const kvKeys: string[] = [];
  for (const key of improveKvKeys(namespace)) {
    let value: string | null;
    try {
      value = await kv.get(key);
    } catch (err) {
      throw new Error(`reading KV ${key} failed (${err instanceof Error ? err.message : String(err)}), so the plan cannot say what the delete would leave behind`);
    }
    if (value !== null) kvKeys.push(key);
  }

  const livePaths = rows<{ path: string }>(results[22]).map((r) => r.path);
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
      skill_evaluations: count(results[11]),
      skill_failures: count(results[12]),
      improve_runs: count(results[13]),
      improve_attempts: count(results[14]),
      improve_scores: count(results[15]),
      improve_skills: count(results[16]),
      improve_jti: count(results[17]),
      agents_live: live.length,
      agents_revoked: agents.length - live.length,
      improve_control_documents: count(results[19]),
    },
    jobs_by_status: jobsByStatus,
    ops_site: site,
    ops_site_revision: site ? Number(site.revision) : null,
    open_jobs: rows<{ id: string; status: string; title: string }>(results[7]),
    live_agents: live,
    live_paths: livePaths,
    live_paths_sha256: await sha256Hex(JSON.stringify(livePaths)),
    improve_control_paths: rows<{ path: string }>(results[20]).map((r) => r.path),
    kv_keys: kvKeys,
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
      `${ns} is on the improve loop's roster (ROSTER in src/improve-schema.ts), which the loop, the backup and the scorer iterate by name. Remove it from the roster in code first; this tool will not.`
    );
  }
  if (plan.counts.jobs_open > 0) {
    const jobs = plan.open_jobs.map((j) => `${j.id} (${j.status}, '${j.title}')`);
    refusals.push(
      `${ns} has ${plan.counts.jobs_open} open job${plan.counts.jobs_open === 1 ? "" : "s"}: ${named(jobs, plan.counts.jobs_open)}. ` +
        `cascade never reaches jobs. End each with the jobs tool: action 'supersede' for a queued job, action 'fail' for a claimed or blocked one (the admin may fail a job another credential holds), or 'release' then 'supersede'.`
    );
  }
  if (plan.counts.agents_live > 0) {
    refusals.push(
      `${plan.counts.agents_live} live agent${plan.counts.agents_live === 1 ? " names" : "s name"} ${ns} in its scopes: ${named(plan.live_agents, plan.counts.agents_live)}. ` +
        `cascade never reaches agents. Use the agents tool: action 'revoke', or action 'update_scopes' to drop ${ns} from its namespaces.`
    );
  }
  if (plan.counts.documents_live > NAMESPACE_DELETE_MAX_DOCUMENTS) {
    refusals.push(
      `${ns} holds ${plan.counts.documents_live} live documents, and one delete_namespace batch deletes at most ${NAMESPACE_DELETE_MAX_DOCUMENTS} ` +
        `(D1's ${D1_BATCH_STATEMENTS}-statement batch ceiling: ${FIXED_STATEMENTS} fixed statements plus ${STATEMENTS_PER_DOCUMENT} per document). ` +
        `Delete or move documents with the delete tool first, or ask the seat to rule a set-based helper.`
    );
  }
  if (plan.counts.documents_live > 0 && !opts.cascade) {
    refusals.push(
      `${ns} holds ${plan.counts.documents_live} live document${plan.counts.documents_live === 1 ? "" : "s"}. Pass cascade: true to delete them; each is snapshotted to document_versions first. Archived documents (archive/...) are kept either way.`
    );
  }
  if (plan.counts.improve_control_documents > 0 && !opts.allowImprovePaths) {
    refusals.push(
      `${ns} holds ${plan.counts.improve_control_documents} improve loop control document${plan.counts.improve_control_documents === 1 ? "" : "s"} (${named(plan.improve_control_paths, plan.counts.improve_control_documents)}). ` +
        `Deleting one is a steering change, so it needs allow_improve_paths: true, which needs the can_touch_protected flag and is audit-logged.`
    );
  }
  return refusals;
}

/** The part of the plan a token binds, in one canonical spelling: every count, the
 *  jobs by status, the ops_sites revision, the KV keys present and the sha256 of the
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
    kv_keys: [...plan.kv_keys].sort(),
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
      `the improve KV keys, after the batch commits (holding a value now: ${plan.kv_keys.length ? plan.kv_keys.join(", ") : "none"})`,
    ],
    will_keep: [
      `${c.documents_archived} archived document(s) under archive/, still readable by this namespace name; write, delete, move and restore refuse there until the namespace is registered again`,
      `${c.document_versions} document_versions row(s) and ${c.audit_log} audit_log row(s)`,
      `${c.jobs_finished} finished job(s), ${c.job_outcomes} job_outcomes, ${c.job_claims} job_claims, ${c.job_touches} job_touches row(s)`,
      `${c.skill_evaluations} skill_evaluations, ${c.skill_failures} skill_failures row(s)`,
      `${c.improve_runs} improve_runs, ${c.improve_attempts} improve_attempts, ${c.improve_scores} improve_scores, ${c.improve_skills} improve_skills, ${c.improve_jti} improve_jti row(s)`,
      `${c.agents_revoked} revoked agent(s) that name it`,
      "the nightly backup objects and the holdout bucket",
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
    plan = await readDeletePlan(env.DB, env.APP_KV, namespace);
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
    improve_control_paths: plan.improve_control_paths,
    ops_site: plan.ops_site,
    kv_keys: plan.kv_keys,
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
      next: `Call delete_namespace with action 'perform', the same namespace, cascade and allow_improve_paths, and this token within five minutes. Any change to what the preview counted refuses it.`,
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
    return { ok: false, refusal: "perform needs the token a delete_namespace preview returned. Preview first." };
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
    plan = await readDeletePlan(db, env.APP_KV, namespace);
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
    kv_keys: plan.kv_keys,
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

  // KV after the commit: KV is not in the transaction. Every key is deleted, present
  // or not, and a failure is reported with the key, never dropped.
  const kvDeleted: string[] = [];
  const kvFailed: Array<{ key: string; error: string }> = [];
  for (const key of improveKvKeys(namespace)) {
    try {
      await env.APP_KV.delete(key);
      kvDeleted.push(key);
    } catch (err) {
      kvFailed.push({ key, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (kvFailed.length) logEvent("error", "DELETE_NAMESPACE_KV_FAILED", { message: `DELETE_NAMESPACE_KV_FAILED ${namespace}: ${kvFailed.map((f) => `${f.key}: ${f.error}`).join("; ")}` });

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
      kv_deleted: kvDeleted,
      kv_failed: kvFailed,
      ...(kvFailed.length
        ? {
            warning: `The namespace is deleted and its batch committed, but ${kvFailed.length} improve KV key(s) could not be deleted: ${kvFailed
              .map((f) => f.key)
              .join(", ")}. Delete them by hand; a stale improve:paused or improve:best key is read by the loop if the name is registered again.`,
          }
        : {}),
    },
  };
}
