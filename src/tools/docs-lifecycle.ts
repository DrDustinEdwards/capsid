import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { auditStatement, guardedCommit, isMissingRowAbort, requireBodyUnchanged, requireExists, snapshotLive, snapshotTaken } from "../store-guards";
import { bounded, MAX_SHA, nsName, docPath } from "../limits";
import { canonGuarded, canonRefusal } from "../canon";
import { ruleDocCap, ruleDocWriteRefusal } from "../rule-docs";
import { ok, fail, type ToolCtx, requireConfirmation, pathMutation, edgesTouching } from "./docs";
import { policyPathsRefusal, requireRegisteredNamespace } from "./docs-write";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";

// The document lifecycle beyond writing (src/tools/docs-write.ts writes): restore an
// earlier version, delete, and move.

export function defineRestoreOperation(server: McpServer, ctx: ToolCtx): void {
  const { db, actor } = ctx;

  ctx.ops.define(
    "restore",
    {
      description:
        "Restore a document's title and body from one of its retained versions (see capsid_read_doc action versions). The current body is snapshotted first and the restore is audit-logged, so a restore can itself be undone. The stored bytes go back exactly, with no dash normalization; type, status, tags and links are not restored. Restoring a deleted document recreates it. Refused on a canon document for a key scoped to some namespaces (see capsid_write_doc action write). Optional if_match: the sha256 of the body you believe is live; the restore is refused if it changed. Needs the write grant and confirm: true.",
      inputSchema: {
        namespace: nsName,
        path: docPath,
        version_id: z.number().int().positive(),
        confirm: z.boolean().optional(),
        if_match: bounded(MAX_SHA).optional(),
        allow_improve_paths: z.boolean().optional(),
      },
    },
    async ({ namespace, path, version_id, confirm, if_match, allow_improve_paths }) => {
      const nsError = await requireRegisteredNamespace(db, namespace);
      if (nsError) return fail(nsError);
      if (canonGuarded(ctx.agent, namespace, path)) return fail(canonRefusal("restore", namespace, path));
      const version = await db
        .prepare("SELECT id, title, body, snapshot_at FROM document_versions WHERE id = ?1 AND namespace = ?2 AND path = ?3")
        .bind(version_id, namespace, path)
        .first<{ id: number; title: string | null; body: string | null; snapshot_at: string }>();
      if (!version) return fail(`no version ${version_id} for ${namespace}/${path}`);
      const prior = await db
        .prepare("SELECT id, title, body FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ id: number; title: string | null; body: string | null }>();
      // The policy-document guard (see policyPathsRefusal).
      const restorePolicyRefusal = policyPathsRefusal(ctx, "restore", namespace, allow_improve_paths, [path]);
      if (restorePolicyRefusal) return fail(restorePolicyRefusal);
      // A rule document is held to the same checks as a write (src/rule-docs.ts). A restore
      // that recreates a deleted document puts back what was there, so it is judged
      // against the version itself and passes.
      const restoreRuleRefusal = ruleDocWriteRefusal(namespace, path, prior ? (prior.body ?? "") : (version.body ?? ""), version.body ?? "");
      if (restoreRuleRefusal) return fail(restoreRuleRefusal);
      // The same protocol capsid_write_doc action write runs, with restore's wordings. On the
      // recreate path the guard is the ABSENCE of a row: the snapshot statement is
      // only added when the pre-read saw one, so a racing create would otherwise be
      // overwritten with nothing kept.
      const commit = guardedCommit({
        db,
        namespace,
        path,
        prior,
        if_match,
        refusals: {
          ifMatchOnMissing: `if_match was given but ${namespace}/${path} does not exist. Nothing was written. Omit if_match to recreate it from a version.`,
          ifMatchMismatch: (currentSha, passed) =>
            `if_match mismatch on ${namespace}/${path}: the live body is not the one you read. Nothing was restored. ` +
            `Current sha256 is ${currentSha}; you passed ${passed}.`,
          createCollision: `create collision on ${namespace}/${path}: it did not exist when this restore started and it does now, so another writer created it first. Nothing was written and that body is intact.`,
          deletedInFlight: `conflict on ${namespace}/${path}: the document was deleted while this restore was in flight. Nothing was written.`,
          bodyChanged: (currentSha) =>
            `conflict on ${namespace}/${path}: the live body changed after this restore read it. Nothing was written. ` +
            `Current sha256 is ${currentSha}. Re-read the versions with capsid_read_doc action versions and retry.`,
          batchFailed: (reason) => `restore failed, nothing was written: ${reason}`,
        },
      });
      const staleIfMatch = await commit.precheckIfMatch();
      if (staleIfMatch) return fail(staleIfMatch);
      const restoreRefusal = await requireConfirmation(server, confirm, {
        prompt: `Restore ${namespace}/${path} to the version snapshotted at ${version.snapshot_at}? The current body will be snapshotted first.`,
        declined: `restore of ${namespace}/${path} declined`,
        unsupported: `confirmation required: re-run capsid_write_doc action restore with confirm: true to overwrite ${namespace}/${path} with version ${version_id} (snapshotted ${version.snapshot_at}). The current body will be snapshotted first.`,
      });
      if (!restoreRefusal.ok) return fail(restoreRefusal.message);
      const elicited = restoreRefusal.elicited;
      // The stored body goes back EXACTLY as snapshotted, with no dash normalization.
      // A snapshot is a record of what the document said.
      const body = version.body ?? "";
      const statements: D1PreparedStatement[] = [];
      if (prior) {
        // Snapshot from the live row, inside the batch, as on write. Restore elicits a
        // confirmation, so the gap between the read and the commit can be the full 90
        // second prompt.
        statements.push(snapshotLive(db, namespace, path));
      }
      statements.push(
        db
          .prepare(
            `INSERT INTO documents (namespace, path, title, body)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(namespace, path) DO UPDATE SET
               title = ?3,
               body = excluded.body,
               updated_at = datetime('now')`
          )
          .bind(namespace, path, version.title, body)
      );
      statements.push(
        auditStatement(db, actor, "restore", namespace, path, {
          version_id,
          snapshot_at: version.snapshot_at,
          recreated: !prior,
          snapshotted: Boolean(prior),
        })
      );
      const committed = await commit.run(elicited, statements);
      if ("refusal" in committed) return fail(committed.refusal);
      return ok({
        namespace,
        path,
        action: prior ? "restored" : "recreated",
        version_id,
        snapshot_at: version.snapshot_at,
        sha256: await sha256Hex(body),
        bytes: new TextEncoder().encode(body).length,
        // From the snapshot statement's result, as on write.
        snapshotted: Boolean(prior) && snapshotTaken(committed.results[0]),
        ...(prior ? {} : { note: "the document did not exist and was recreated; its type, status, tags and links are defaults, not the ones it had" }),
      });
    }
  );
}

export function defineDeleteOperation(server: McpServer, ctx: ToolCtx): void {
  const { db, actor } = ctx;

  ctx.ops.define(
    "delete",
    {
      description: "Delete a document. Snapshots it first and writes an audit log entry. Refused on a canon document for a key scoped to some namespaces (see capsid_write_doc). Needs confirmation: the server elicits it when the client supports elicitation, otherwise pass confirm: true. Needs the write grant.",
      inputSchema: { namespace: nsName, path: docPath, confirm: z.boolean().optional(), allow_improve_paths: z.boolean().optional() },
    },
    async ({ namespace, path, confirm, allow_improve_paths }) => {
      const nsError = await requireRegisteredNamespace(db, namespace);
      if (nsError) return fail(nsError);
      if (canonGuarded(ctx.agent, namespace, path)) return fail(canonRefusal("delete", namespace, path));
      const prior = await db
        .prepare("SELECT id, title, body FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ id: number; title: string | null; body: string | null }>();
      if (!prior) return fail(`not found: ${namespace}/${path}`);
      // The policy-document guard (see policyPathsRefusal).
      const deletePolicyRefusal = policyPathsRefusal(ctx, "delete", namespace, allow_improve_paths, [path]);
      if (deletePolicyRefusal) return fail(deletePolicyRefusal);
      const deleteRefusal = await requireConfirmation(server, confirm, {
        prompt: `Delete ${namespace}/${path}? It will be snapshotted to document_versions first, so it can be recovered.`,
        declined: `delete of ${namespace}/${path} declined`,
        unsupported: `confirmation required: re-run capsid_delete_doc with confirm: true to remove ${namespace}/${path}. It will be snapshotted to document_versions first.`,
      });
      if (!deleteRefusal.ok) return fail(deleteRefusal.message);
      const elicited = deleteRefusal.elicited;
      // The edges are recorded inside the batch, before pathMutation removes them, so
      // an edge added after an earlier read is still recorded; the audit row is the
      // only place they survive. The aggregate always yields one row ('[]' when there
      // are no edges), and RETURNING hands the list back for the count.
      //
      // The guard is not redundant with the `prior` read, which is a separate
      // transaction: a delete matching zero rows would otherwise snapshot a body, write
      // an audit row saying 'delete', and answer "deleted" having removed nothing.
      // After an elicitation the guard is the body one: the human consented to deleting
      // the body they were shown, so a body written in that window must abort the
      // delete. The snapshot itself SELECTs the live row inside the batch.
      let edgesRemoved = 0;
      try {
        const results = await db.batch([
          elicited ? requireBodyUnchanged(db, namespace, path, prior.body) : requireExists(db, namespace, path),
          snapshotLive(db, namespace, path),
          db
            .prepare(
              `INSERT INTO audit_log (actor, action, namespace, path, params)
               SELECT ?1, 'delete', ?2, ?3, json_object('edges_removed', json_group_array(
                 json_object('from_ns', from_ns, 'from_path', from_path, 'type', type, 'to_ns', to_ns, 'to_path', to_path)))
               FROM document_links WHERE (from_ns = ?2 AND from_path = ?3) OR (to_ns = ?2 AND to_path = ?3)
               RETURNING params`
            )
            .bind(actor, namespace, path),
          ...pathMutation(db, namespace, path, null),
        ]);
        const recordedParams = (results[2]?.results?.[0] as { params?: string } | undefined)?.params;
        if (recordedParams) edgesRemoved = (JSON.parse(recordedParams) as { edges_removed: unknown[] }).edges_removed.length;
      } catch (err) {
        if (isMissingRowAbort(err)) {
          return fail(
            elicited
              ? `delete aborted, nothing changed: ${namespace}/${path} changed or was removed while the confirmation was open. Re-read it and try again.`
              : `delete aborted, nothing changed: ${namespace}/${path} no longer exists. Another session removed it after this call started.`
          );
        }
        return fail(`delete failed, nothing changed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return ok({
        namespace,
        path,
        action: "deleted",
        snapshotted: true,
        edges_removed: edgesRemoved,
      });
    }
  );
}

export function defineMoveOperation(server: McpServer, ctx: ToolCtx): void {
  const { db, actor } = ctx;

  ctx.ops.define(
    "move",
    {
      description: "Rename a document path within its namespace, repointing every typed edge that touches it. Audit logged. Refused when either path is a canon document, for a key scoped to some namespaces (see capsid_write_doc action write). Needs confirmation: the server elicits it when the client supports elicitation, otherwise pass confirm: true. Needs the write grant.",
      inputSchema: { namespace: nsName, path: docPath, new_path: docPath, confirm: z.boolean().optional(), allow_improve_paths: z.boolean().optional() },
    },
    async ({ namespace, path, new_path, confirm, allow_improve_paths }) => {
      const nsError = await requireRegisteredNamespace(db, namespace);
      if (nsError) return fail(nsError);
      // Both ends: moving canon away empties it, and moving a document onto a canon path
      // that does not exist yet creates canon from a caller that may not write it.
      for (const end of [path, new_path]) {
        if (canonGuarded(ctx.agent, namespace, end)) return fail(canonRefusal("move", namespace, end));
      }
      // Existence and the edge count are both read BEFORE the batch. D1's meta.changes
      // cannot be used for either: documents carries FTS5 sync triggers, so an UPDATE
      // reports the trigger's row changes too, and in a batch those accumulate across
      // statements.
      const exists = await db
        .prepare("SELECT 1 AS ok FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ ok: number }>();
      if (!exists) return fail(`not found: ${namespace}/${path}`);
      // The policy-document guard on both ends (see policyPathsRefusal).
      const movePolicyRefusal = policyPathsRefusal(ctx, "move", namespace, allow_improve_paths, [path, new_path]);
      if (movePolicyRefusal) return fail(movePolicyRefusal);
      const moved = await db
        .prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ body: string | null }>();
      const movedBody = moved?.body ?? "";
      // Moving a document onto a rule path makes it a rule document, held to the same
      // checks as a write that creates one (src/rule-docs.ts). Moving one away is free, and
      // so is moving a rule document to another rule path: the
      // body is the one already held to the checks.
      const moveRuleRefusal = ruleDocWriteRefusal(namespace, new_path, ruleDocCap(namespace, path) !== null ? movedBody : null, movedBody);
      if (moveRuleRefusal) return fail(moveRuleRefusal);
      // move needs confirmation: it repoints every edge and, unlike delete, leaves no
      // snapshot of the old path, only an audit row.
      const moveRefusal = await requireConfirmation(server, confirm, {
        prompt: `Rename ${namespace}/${path} to ${namespace}/${new_path}? Edges pointing at the old path are repointed.`,
        declined: `move of ${namespace}/${path} declined`,
        unsupported: `confirmation required: re-run capsid_write_doc action move with confirm: true to rename ${namespace}/${path} to ${new_path}.`,
      });
      if (!moveRefusal.ok) return fail(moveRefusal.message);
      const { results: movingEdges } = await edgesTouching(db, namespace, path).all();
      const repointed = movingEdges.length;
      // One batch: the guard, the rename, the edge repointing and the audit row, so a
      // move cannot succeed without a record or be recorded without happening.
      try {
        await db.batch([
          requireExists(db, namespace, path),
          ...pathMutation(db, namespace, path, new_path),
          auditStatement(db, actor, "move", namespace, path, { new_path, edges_repointed: repointed }),
        ]);
      } catch (err) {
        if (isMissingRowAbort(err)) {
          return fail(`move aborted, nothing changed: ${namespace}/${path} no longer exists. Another session moved or removed it after this call started.`);
        }
        return fail(`move failed, nothing changed (target may already exist): ${err instanceof Error ? err.message : String(err)}`);
      }
      return ok({ namespace, path, new_path, action: "moved", edges_repointed: repointed });
    }
  );
}
