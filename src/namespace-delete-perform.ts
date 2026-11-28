import { errorMessage } from "@dustinedwards/site-runtime/log";
import type { Env } from "./env";
import { isMissingRowAbort } from "./store-guards";
import { pathMutation } from "./tools/docs";
import { confirmKeys } from "./auth";
import {
  mintConfirm,
  type Redeemed,
  redeemConfirm,
} from "@dustinedwards/site-runtime/confirm-token";
import {
  NAMESPACE_DELETE_MAX_DOCUMENTS,
  rows,
  deleteRefusals,
  planFingerprint,
  readDeletePlan,
  summarize,
  fingerprintDifference,
  type DeletePlan,
  type DeleteOptions,
} from "./namespace-delete";

const DELETE_TOKEN_TTL_SECONDS = 5 * 60;
/**
 * The delete confirmation's key label (auth.ts confirmKeys): its own, so a Portal control's token
 * never performs a delete here. A new label retires every outstanding token.
 */
const DELETE_CONFIRM_LABEL = "capsid-namespace-delete:v1";

export type ToolAnswer = { ok: true; data: unknown } | { ok: false; refusal: string };

export async function previewNamespaceDelete(
  env: Env,
  actor: string,
  namespace: string,
  opts: DeleteOptions,
  now: Date,
): Promise<ToolAnswer> {
  let plan: DeletePlan;
  try {
    plan = await readDeletePlan(env.DB, namespace);
  } catch (err) {
    return {
      ok: false,
      refusal: `delete_namespace preview failed, nothing changed: ${errorMessage(err)}`,
    };
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
    live_agents: plan.live_agents,
    live_paths: plan.live_paths,
    max_documents: NAMESPACE_DELETE_MAX_DOCUMENTS,
    policy_paths: plan.policy_paths,
    ops_site: plan.ops_site,
    ...summarize(plan),
  };
  if (refusals.length) return { ok: true, data: base };
  let minted: { token: string; expiresAt: string };
  try {
    minted = await mintConfirm({
      keys: await confirmKeys(env, DELETE_CONFIRM_LABEL),
      claims: {
        namespace,
        cascade: opts.cascade,
        allow_improve_paths: opts.allowImprovePaths,
        actor,
        plan: planFingerprint(plan),
      },
      ttlSeconds: DELETE_TOKEN_TTL_SECONDS,
      now: now.getTime(),
    });
  } catch (err) {
    return {
      ok: false,
      refusal: `delete_namespace preview failed, nothing changed: ${errorMessage(err)}`,
    };
  }
  return {
    ok: true,
    data: {
      ...base,
      token: minted.token,
      expires_at: minted.expiresAt,
      next: `Call capsid_admin_manage_namespaces with action 'delete_perform', the same namespace, cascade and allow_improve_paths, and this token within five minutes. Any change to what the preview counted refuses it.`,
    },
  };
}

// The batch's first statement: an INSERT that violates NOT NULL (the same abort as requireExists
// in src/store-guards.ts), fired unless the store is still what the plan read. The live set is
// pinned exactly: the count equals the plan's and no live path lies outside the plan's list (?5,
// JSON).
function planGuard(db: D1Database, plan: DeletePlan, pathsJson: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO document_versions (document_id, namespace, path)
       SELECT NULL, ?1, 'delete_namespace'
       WHERE NOT (
         EXISTS (SELECT 1 FROM namespaces WHERE namespace = ?1)
         AND (SELECT COUNT(*) FROM documents WHERE namespace = ?1 AND path NOT LIKE 'archive/%') = ?2
         AND NOT EXISTS (SELECT 1 FROM documents WHERE namespace = ?1 AND path NOT LIKE 'archive/%'
                         AND path NOT IN (SELECT value FROM json_each(?5)))
         AND (SELECT COUNT(*) FROM document_links
              WHERE (from_ns = ?1 AND from_path IN (SELECT value FROM json_each(?5)))
                 OR (to_ns = ?1 AND to_path IN (SELECT value FROM json_each(?5)))) = ?3
         AND NOT EXISTS (SELECT 1 FROM agents WHERE revoked_at IS NULL AND
           CASE WHEN json_valid(scopes) THEN
             CASE WHEN json_type(scopes) = 'object' AND json_type(scopes, '$.namespaces') = 'array'
               THEN EXISTS (SELECT 1 FROM json_each(scopes, '$.namespaces') WHERE value = ?1) ELSE 0 END
           ELSE 0 END)
         AND (SELECT revision FROM ops_sites WHERE namespace = ?1) IS ?4
       )`,
    )
    .bind(
      plan.namespace,
      plan.counts.documents_live,
      plan.counts.document_links_removed,
      plan.ops_site_revision,
      pathsJson,
    );
}

/**
 * Each live document is deleted by pathMutation(db, namespace, path, null), the one site that
 * deletes a documents row (path mutation invariant, test/path-mutation.test.ts), so the batch is
 * FIXED_STATEMENTS plus two per document and the cap refuses anything larger before it is built.
 */
export async function performNamespaceDelete(
  env: Env,
  actor: string,
  namespace: string,
  opts: DeleteOptions,
  token: string | undefined,
  now: Date,
): Promise<ToolAnswer> {
  if (typeof token !== "string" || token.length === 0) {
    return {
      ok: false,
      refusal:
        "delete_perform needs the token capsid_admin_manage_namespaces action delete_preview returned. Preview first.",
    };
  }
  let redeemed: Redeemed;
  try {
    redeemed = await redeemConfirm({
      keys: await confirmKeys(env, DELETE_CONFIRM_LABEL),
      token,
      expect: {
        actor,
        namespace,
        cascade: opts.cascade,
        allow_improve_paths: opts.allowImprovePaths,
      },
      now: now.getTime(),
    });
  } catch (err) {
    return {
      ok: false,
      refusal: `delete_namespace refused, nothing changed: ${errorMessage(err)}`,
    };
  }
  if (!redeemed.ok)
    return { ok: false, refusal: `delete_namespace refused, nothing changed: ${redeemed.reason}` };
  const signedPlan = redeemed.claims.plan;
  if (typeof signedPlan !== "string")
    return {
      ok: false,
      refusal:
        "delete_namespace refused, nothing changed: the confirmation token verifies but carries no plan: preview again.",
    };
  return deleteAsPlanned(env, actor, namespace, opts, signedPlan);
}

/**
 * The plan is read again, every refusal applies again, and the fingerprint the confirmation signed
 * must match it exactly.
 */
export async function deleteAsPlanned(
  env: Env,
  actor: string,
  namespace: string,
  opts: DeleteOptions,
  signedPlan: string,
): Promise<ToolAnswer> {
  const db = env.DB;
  let plan: DeletePlan;
  try {
    plan = await readDeletePlan(db, namespace);
  } catch (err) {
    return {
      ok: false,
      refusal: `delete_namespace failed, nothing changed: ${errorMessage(err)}`,
    };
  }
  const refusals = deleteRefusals(plan, opts);
  if (refusals.length)
    return {
      ok: false,
      refusal: `delete_namespace refused, nothing changed: ${refusals.join(" ")}`,
    };
  const current = planFingerprint(plan);
  if (current !== signedPlan) {
    const changed = fingerprintDifference(signedPlan, current);
    return {
      ok: false,
      refusal: `delete_namespace refused, nothing changed: the namespace changed since the preview (${changed.join("; ")}). Preview again.`,
    };
  }
  // The cap is in deleteRefusals, so this holds already; checked again because the batch below is
  // sized from this list, and a list the read truncated would delete part of the namespace.
  const paths = plan.live_paths;
  if (
    paths.length !== plan.counts.documents_live ||
    paths.length > NAMESPACE_DELETE_MAX_DOCUMENTS
  ) {
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
    documents_deleted: paths,
  });
  let results: D1Result[];
  try {
    results = await db.batch([
      planGuard(db, plan, pathsJson),
      // Exactly the paths pathMutation deletes below, bound, from the rows the table holds when the
      // batch runs. The guard has pinned the live set to this list.
      db
        .prepare(
          `INSERT INTO document_versions (document_id, namespace, path, title, body)
           SELECT id, namespace, path, title, body FROM documents
           WHERE namespace = ?1 AND path IN (SELECT value FROM json_each(?2))
           RETURNING id`,
        )
        .bind(namespace, pathsJson),
      // The one audit row, read inside the batch before anything is removed: the edges, the whole
      // ops_sites row and the namespaces row are recorded here and nowhere else afterwards; the deleted
      // paths ride in the plan. The aggregate always yields a row.
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
           RETURNING params`,
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
        refusal: `delete_namespace aborted, nothing changed: ${namespace} changed between the plan and the commit (a document, an edge, a live agent or its ops_sites row). Preview again.`,
      };
    }
    return {
      ok: false,
      refusal: `delete_namespace failed, nothing changed: ${errorMessage(err)}`,
    };
  }

  // Counted from RETURNING, never meta.changes (path mutation invariant,
  // test/path-mutation.test.ts). The batch committed, so the guard held: the live set was exactly
  // `paths`, and pathMutation deleted each of them.
  const snapshots = rows(results[1]).length;
  const auditParams = rows<{ params: string }>(results[2])[0]?.params;
  let edgesRemoved = 0;
  if (auditParams)
    edgesRemoved = (JSON.parse(auditParams) as { edges_removed: unknown[] }).edges_removed.length;
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
        agents_revoked: plan.counts.agents_revoked,
      },
    },
  };
}
