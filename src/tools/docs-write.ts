import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hintsFor } from "../tool-annotations";
import { z } from "zod";
import { IMPROVE_OVERRIDE_FLAGS } from "../scope";
import { sha256Hex } from "../auth";
import { auditStatement, documentUpsert, guardedCommit, isMissingRowAbort, requireBodyUnchanged, requireExists, snapshotLive, snapshotTaken } from "../store-guards";
import { normalizeDashes } from "../normalize";
import { parseLinks } from "../links";
import { validateDocStatus, validateDocType } from "../doc-meta";
import { bounded, MAX_BODY, MAX_DOC_STATUS, MAX_DOC_TYPE, MAX_LINKS_JSON, MAX_SHA, MAX_TAGS, MAX_TITLE, nsName, docPath } from "../limits";
import { assembleBody } from "../write-modes";
import { improveWriteRefusal } from "../improve-scores";
import { concurrentEditWarning } from "../server";
import { ok, fail, type ToolCtx, requireConfirmation, pathMutation, edgesTouching } from "./docs";

// The document tools that change the store: write, restore, delete and move.
// registerDocTools in ./docs registers them in the published order.

async function requireRegisteredNamespace(db: D1Database, namespace: string): Promise<string | null> {
  const row = await db.prepare("SELECT namespace FROM namespaces WHERE namespace = ?1").bind(namespace).first();
  if (row) return null;
  return (
    `unknown namespace '${namespace}'. Nothing was written. Documents can only live in a registered namespace, ` +
    `because an unregistered one is invisible to the namespaces list, the lint loop and every repo tool. ` +
    `Check the spelling against the namespaces tool, or create it with register_namespace.`
  );
}

// The improve control-surface check for write, restore, delete and move. First the
// override is itself scoped: allow_improve_paths is how a caller writes the loop's
// own control surface (its run documents, prompts, skills and anchors), and it is the
// document-side twin of the repo-side protected-path flag, so it asks for the same
// one (IMPROVE_OVERRIDE_FLAGS in src/scope.ts). Then improveWriteRefusal runs on every path the call changes, as what the path
// holds now against what it would hold. Returns the first refusal, or null.
async function improvePathsRefusal(
  ctx: ToolCtx,
  tool: "write" | "restore" | "delete" | "move",
  namespace: string,
  allowImprovePaths: boolean | undefined,
  changes: Array<{ path: string; before: string | null; after: string }>
): Promise<string | null> {
  const allow = allowImprovePaths === true;
  if (allow) {
    const overrideRefusal = ctx.scope({ tool, namespace, flags: IMPROVE_OVERRIDE_FLAGS });
    if (overrideRefusal) return overrideRefusal;
  }
  for (const change of changes) {
    const refusal = await improveWriteRefusal(namespace, change.path, change.before, change.after, allow);
    if (refusal) return refusal;
  }
  return null;
}

export function registerWriteTool(server: McpServer, ctx: ToolCtx): void {
  const { db, actor } = ctx;

  server.registerTool(
    "write",
    {
      annotations: hintsFor("write"),
      description:
        "Create or update a document. Snapshots the prior version and writes an audit log entry. mode selects how body is applied: 'replace' (default, full body, needs title and body), 'append' (body is added to the end; no title or confirmation needed), 'patch' (needs find and replace_with; find must occur EXACTLY ONCE or the write is refused), or 'meta' (change type, tags, status or title and leave the body byte-identical). Every response carries sha256 and bytes of the resulting body. Optional if_match: the sha256 of the body you believe is stored; when it does not match, the write is REFUSED and the error carries the current sha256. Overwriting with replace or patch needs confirmation: the server elicits it when the client supports elicitation, otherwise pass confirm: true. Optional links: a JSON array of outgoing edges [{\"type\":\"references\",\"to_path\":\"decisions.md\",\"to_ns\":\"capsid\"}] (types: governs, references, supersedes, replaces, depends-on; to_ns defaults to this namespace) that replaces this document's outgoing edges; omit it to keep them, pass [] to clear them. Needs the write grant.",
      inputSchema: {
        namespace: nsName,
        path: docPath,
        // title and body are required for mode 'replace' and validated as such below.
        // They are optional in the schema because append needs no title and patch
        // needs neither. Requiring them here would force a caller to resupply a title
        // it is not changing.
        title: bounded(MAX_TITLE).optional(),
        body: bounded(MAX_BODY).optional(),
        mode: z.enum(["replace", "append", "patch", "meta"]).optional(),
        find: bounded(MAX_BODY).optional(),
        replace_with: bounded(MAX_BODY).optional(),
        type: bounded(MAX_DOC_TYPE).optional(),
        tags: bounded(MAX_TAGS).optional(),
        status: bounded(MAX_DOC_STATUS).optional(),
        confirm: z.boolean().optional(),
        links: bounded(MAX_LINKS_JSON).optional(),
        if_match: bounded(MAX_SHA).optional(),
        // Opt-in to writing the improve loop's control surface (improve/prompts/,
        // improve/skills/, or the Anchors block of improve/scores.md). Refused
        // without it; audit-logged with it. See improveWriteRefusal.
        allow_improve_paths: z.boolean().optional(),
      },
    },
    async ({ namespace, path, title, body, mode, find, replace_with, type, tags, status, confirm, links, if_match, allow_improve_paths }) => {
      const writeMode = mode ?? "replace";
      const typeError = type === undefined ? null : validateDocType(type);
      if (typeError) return fail(typeError);
      const statusError = status === undefined ? null : validateDocStatus(status);
      if (statusError) return fail(statusError);
      const parsedLinks = links === undefined ? null : parseLinks(links, namespace);
      if (parsedLinks && "error" in parsedLinks) return fail(parsedLinks.error);
      const nsError = await requireRegisteredNamespace(db, namespace);
      if (nsError) return fail(nsError);

      const prior = await db
        .prepare("SELECT id, title, body, type, status, tags, updated_at FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ id: number; title: string | null; body: string | null; type: string | null; status: string | null; tags: string | null; updated_at: string }>();

      // Optimistic concurrency. if_match is the sha256 of the body the caller believes
      // is stored, which every write already returns. A lost update otherwise leaves
      // no trace in the result: the write succeeds, the prior body is snapshotted, and
      // nothing says anything went wrong. Fail closed, the same shape as a patch
      // anchor: on mismatch nothing is written and the error carries the current sha
      // so the caller can rebase and retry. Opt-in, because requiring it would break
      // append, which is safe by construction.
      const commit = guardedCommit({
        db,
        namespace,
        path,
        prior,
        if_match,
        refusals: {
          ifMatchOnMissing: `if_match was given but ${namespace}/${path} does not exist. Nothing was written. Omit if_match to create it.`,
          ifMatchMismatch: (currentSha, passed) =>
            `if_match mismatch on ${namespace}/${path}: the stored body is not the one you read. Nothing was written. ` +
            `Current sha256 is ${currentSha}; you passed ${passed}. ` +
            `Re-read the document, reapply your change to the current body, and retry.`,
          createCollision:
            `create collision on ${namespace}/${path}: the document did not exist when this write started and it does now, so another writer created it first. ` +
            `Nothing was written and the other writer's body is intact. ` +
            `Re-read the document and retry as an update if you still mean to change it.`,
          deletedInFlight: `conflict on ${namespace}/${path}: the document was deleted while this write was in flight. Nothing was written.`,
          bodyChanged: (currentSha, elicited) =>
            `${if_match !== undefined ? "if_match mismatch" : "stale confirmation"} on ${namespace}/${path}: the stored body changed after this write read it${elicited && if_match === undefined ? " and while the overwrite confirmation was pending" : ""}. Nothing was written. ` +
            `Current sha256 is ${currentSha}. ` +
            `Re-read the document, reapply your change to the current body, and retry.`,
          batchFailed: (reason) => `write failed, nothing was written: ${reason}`,
        },
      });
      const staleIfMatch = await commit.precheckIfMatch();
      if (staleIfMatch) return fail(staleIfMatch);

      // Normalize wide dashes server-side so no client can store an em dash (see
      // ./normalize). Only the caller's text is normalized, before assembly: body for
      // replace and append, replace_with for patch. Normalizing the assembled body
      // would rewrite stored text the caller did not touch, which conventions.md
      // forbids. find is not normalized, because it has to match the stored bytes.
      // meta takes no body, so the stored body stays byte-identical.
      if (title !== undefined) title = normalizeDashes(title, "title");
      if (body !== undefined) body = normalizeDashes(body, "prose");
      if (replace_with !== undefined) replace_with = normalizeDashes(replace_with, "prose");

      // Body assembly, per mode (./write-modes). Every mode returns the full new body,
      // so the write path below is the same for all of them and the version snapshot
      // and audit row apply identically. meta returns the stored body byte-identical.
      const assembled = assembleBody({
        mode: writeMode,
        exists: Boolean(prior),
        priorBody: prior?.body ?? null,
        title,
        body,
        find,
        replace_with,
      });
      if ("error" in assembled) return fail(`${assembled.error} (${namespace}/${path})`);
      body = assembled.body;
      if (writeMode === "meta" && title === undefined && type === undefined && tags === undefined && status === undefined) {
        return fail(`mode 'meta' needs at least one of title, type, tags or status to change (${namespace}/${path}).`);
      }

      // The improve control-surface guard, computed on the final assembled and
      // normalized body so it sees exactly what would be stored: a patch or append that
      // changes scores.md's anchor block is caught the same as a full replace. Refused
      // unless allow_improve_paths was passed.
      const improveRefusal = await improvePathsRefusal(ctx, "write", namespace, allow_improve_paths, [
        { path, before: prior?.body ?? null, after: body as string },
      ]);
      if (improveRefusal) return fail(improveRefusal);

      // append and meta are exempt from confirmation. Confirmation exists to stop an
      // accidental clobber of existing text, and an append destroys none: the prior
      // body is still snapshotted and the addition goes after it. Requiring a confirm
      // there would put more friction on the safe operation than on the dangerous one.
      // patch and replace both mutate existing text and are not exempt. `elicited` is whether a human answered a prompt. It arms the commit-time body
      // guard; why that consent goes stale is stated on requireConfirmation.
      let elicited = false;
      if (prior && confirm !== true && writeMode !== "append" && writeMode !== "meta") {
        const refusal = await requireConfirmation(server, confirm, {
          prompt: `Overwrite ${namespace}/${path}? The current version will be snapshotted to document_versions first.`,
          declined: `overwrite of ${namespace}/${path} declined`,
          unsupported: `confirmation required: ${namespace}/${path} already exists. Re-run write with confirm: true to overwrite it. The current version will be snapshotted to document_versions first.`,
        });
        if (!refusal.ok) return fail(refusal.message);
        elicited = refusal.elicited;
      }
      // The guard itself is armed by commit.run() below, from this same pre-read.
      const statements: D1PreparedStatement[] = [];
      if (prior) {
        // Snapshot from the live row, inside the batch. Binding the pre-read body would
        // file what this handler read, not what the table held at commit: on an
        // unguarded update, a body written in the gap would be overwritten while the
        // snapshot recorded its predecessor. The SELECT runs in the same transaction as
        // the overwrite.
        statements.push(snapshotLive(db, namespace, path));
      }
      statements.push(documentUpsert(db, namespace, path, title ?? null, body, type ?? null, tags ?? null, status ?? null));
      // The prior type, status, tags and title go into the audit params whenever a
      // write changes any of them, and this is the only place they survive:
      // document_versions snapshots title and body only. The snapshot schema stays
      // title plus body, because widening a version row would mean a migration plus a
      // rewrite of every restore path to answer a question the log already answers.
      const metaChanged = title !== undefined || type !== undefined || tags !== undefined || status !== undefined;
      statements.push(
        auditStatement(db, actor, "write", namespace, path, {
          title,
          type,
          tags,
          status,
          mode: writeMode,
          updated: Boolean(prior),
          ...(allow_improve_paths === true ? { allow_improve_paths: true } : {}),
          ...(prior && metaChanged
            ? { prior_meta: { title: prior.title, type: prior.type, status: prior.status, tags: prior.tags } }
            : {}),
        })
      );
      // links replaces this document's outgoing edges when provided. Left
      // untouched when omitted, so a routine body edit never drops edges.
      if (parsedLinks && "edges" in parsedLinks) {
        statements.push(
          db.prepare("DELETE FROM document_links WHERE from_ns = ?1 AND from_path = ?2").bind(namespace, path)
        );
        for (const edge of parsedLinks.edges) {
          statements.push(
            db
              .prepare(
                "INSERT OR IGNORE INTO document_links (from_ns, from_path, type, to_ns, to_path) VALUES (?1, ?2, ?3, ?4, ?5)"
              )
              .bind(namespace, path, edge.type, edge.to_ns, edge.to_path)
          );
        }
        statements.push(auditStatement(db, actor, "links", namespace, path, { edges: parsedLinks.edges.length }));
      }
      // The warning is computed from a read taken here, not from the pre-read: this
      // handler may have sat in a 90 second elicitation in between, which is when a
      // racing write is most likely to have landed. Reading it late costs one SELECT.
      const atCommit = prior
        ? await db
            .prepare("SELECT updated_at FROM documents WHERE namespace = ?1 AND path = ?2")
            .bind(namespace, path)
            .first<{ updated_at: string }>()
        : null;
      const committed = await commit.run(elicited, statements);
      if ("refusal" in committed) return fail(committed.refusal);
      // From the snapshot statement's own result, not from the pre-read: with no guard
      // armed, a row deleted between the pre-read and the batch is snapshotted by
      // nothing. The snapshot is statements[0] when present.
      const snapshotted = Boolean(prior) && snapshotTaken(committed.results[0]);
      // Warn, do not reject, when an edge points at a document that does not exist.
      // Rejecting would block asserting an edge before its target is written, and a
      // silent dangling edge is how they accumulate unnoticed. The lint loop reports
      // these per namespace; this is the same check when the edge is created.
      let danglingTargets: string[] = [];
      if (parsedLinks && "edges" in parsedLinks && parsedLinks.edges.length > 0) {
        // This read runs after the commit, so a failure here must not be reported as a
        // failed write: the document is stored.
        try {
          const checks = await db.batch(
            parsedLinks.edges.map((edge) =>
              db
                .prepare("SELECT 1 AS ok FROM documents WHERE namespace = ?1 AND path = ?2")
                .bind(edge.to_ns, edge.to_path)
            )
          );
          danglingTargets = parsedLinks.edges
            .filter((_, i) => (checks[i].results?.length ?? 0) === 0)
            .map((edge) => `${edge.to_ns}/${edge.to_path}`);
        } catch {
          // A failed dangling-edge read cannot fail a write that already committed.
        }
      }
      // The read-back: sha256 and byte length of the body now stored, so a caller can
      // verify the write without fetching the document and comparing it by eye. That
      // second read would itself be a transcription, with its own chance of error.
      // Hashes the assembled body, since D1 stores exactly what was bound.
      const bodySha = await sha256Hex(body);
      const bodyBytes = new TextEncoder().encode(body).length;

      return ok({
        namespace,
        path,
        action: prior ? "updated" : "created",
        mode: writeMode,
        sha256: bodySha,
        bytes: bodyBytes,
        ...(writeMode !== "replace" && prior
          ? { bytes_before: new TextEncoder().encode(prior.body ?? "").length }
          : {}),
        snapshotted,
        ...(prior && if_match === undefined
          ? (() => {
              const warning = concurrentEditWarning(atCommit?.updated_at ?? prior.updated_at, Date.now());
              return warning ? { concurrency_warning: warning } : {};
            })()
          : {}),
        ...(parsedLinks && "edges" in parsedLinks ? { links: parsedLinks.edges.length } : {}),
        ...(danglingTargets.length
          ? {
              warning: `${danglingTargets.length} link target(s) do not exist as Capsid documents: ${danglingTargets.join(", ")}. The edge was still written. This is fine if the target is a repo file or is about to be created; otherwise it is a dangling edge and the lint loop will report it.`,
            }
          : {}),
      });
    }
  );
}

export function registerRestoreTool(server: McpServer, ctx: ToolCtx): void {
  const { db, actor } = ctx;

  server.registerTool(
    "restore",
    {
      annotations: hintsFor("restore"),
      description:
        "Restore a document's title and body from one of its retained versions (see history). The current body is snapshotted first and the restore is audit-logged, so a restore can itself be undone. The stored bytes go back exactly, with no dash normalization; type, status, tags and links are not restored. Restoring a deleted document recreates it. Optional if_match: the sha256 of the body you believe is live; the restore is refused if it changed. Needs the write grant and confirm: true.",
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
      const version = await db
        .prepare("SELECT id, title, body, snapshot_at FROM document_versions WHERE id = ?1 AND namespace = ?2 AND path = ?3")
        .bind(version_id, namespace, path)
        .first<{ id: number; title: string | null; body: string | null; snapshot_at: string }>();
      if (!version) return fail(`no version ${version_id} for ${namespace}/${path}`);
      const prior = await db
        .prepare("SELECT id, title, body FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ id: number; title: string | null; body: string | null }>();
      // The improve control-surface guard (see improvePathsRefusal): restoring an old
      // improve/prompts/run.md installs an older system prompt for the attempt
      // generator. Same call shape as write: what is stored now, against what would be
      // stored.
      const restoreImproveRefusal = await improvePathsRefusal(ctx, "restore", namespace, allow_improve_paths, [
        { path, before: prior?.body ?? null, after: version.body ?? "" },
      ]);
      if (restoreImproveRefusal) return fail(restoreImproveRefusal);
      // The same protocol the write tool runs, with restore's wordings. On the
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
            `Current sha256 is ${currentSha}. Re-read history and retry.`,
          batchFailed: (reason) => `restore failed, nothing was written: ${reason}`,
        },
      });
      const staleIfMatch = await commit.precheckIfMatch();
      if (staleIfMatch) return fail(staleIfMatch);
      const restoreRefusal = await requireConfirmation(server, confirm, {
        prompt: `Restore ${namespace}/${path} to the version snapshotted at ${version.snapshot_at}? The current body will be snapshotted first.`,
        declined: `restore of ${namespace}/${path} declined`,
        unsupported: `confirmation required: re-run restore with confirm: true to overwrite ${namespace}/${path} with version ${version_id} (snapshotted ${version.snapshot_at}). The current body will be snapshotted first.`,
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

export function registerDeleteTool(server: McpServer, ctx: ToolCtx): void {
  const { db, actor } = ctx;

  server.registerTool(
    "delete",
    {
      annotations: hintsFor("delete"),
      description: "Delete a document. Snapshots it first and writes an audit log entry. Needs confirmation: the server elicits it when the client supports elicitation, otherwise pass confirm: true. Needs the write grant.",
      inputSchema: { namespace: nsName, path: docPath, confirm: z.boolean().optional(), allow_improve_paths: z.boolean().optional() },
    },
    async ({ namespace, path, confirm, allow_improve_paths }) => {
      const nsError = await requireRegisteredNamespace(db, namespace);
      if (nsError) return fail(nsError);
      const prior = await db
        .prepare("SELECT id, title, body FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ id: number; title: string | null; body: string | null }>();
      if (!prior) return fail(`not found: ${namespace}/${path}`);
      // The improve control-surface guard (see improvePathsRefusal). Removing
      // improve/prompts/run.md drops the loop back to the hardcoded default prompt and
      // removing a skill retires it, so a delete is a steering change even though it
      // installs nothing. The "" is the resulting body: for the two prefixes that is a
      // prefix match, and for scores.md an anchor block going from something to nothing.
      const deleteImproveRefusal = await improvePathsRefusal(ctx, "delete", namespace, allow_improve_paths, [
        { path, before: prior.body, after: "" },
      ]);
      if (deleteImproveRefusal) return fail(deleteImproveRefusal);
      const deleteRefusal = await requireConfirmation(server, confirm, {
        prompt: `Delete ${namespace}/${path}? It will be snapshotted to document_versions first, so it can be recovered.`,
        declined: `delete of ${namespace}/${path} declined`,
        unsupported: `confirmation required: re-run delete with confirm: true to remove ${namespace}/${path}. It will be snapshotted to document_versions first.`,
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

export function registerMoveTool(server: McpServer, ctx: ToolCtx): void {
  const { db, actor } = ctx;

  server.registerTool(
    "move",
    {
      annotations: hintsFor("move"),
      description: "Rename a document path within its namespace, repointing every typed edge that touches it. Audit logged. Needs confirmation: the server elicits it when the client supports elicitation, otherwise pass confirm: true. Needs the write grant.",
      inputSchema: { namespace: nsName, path: docPath, new_path: docPath, confirm: z.boolean().optional(), allow_improve_paths: z.boolean().optional() },
    },
    async ({ namespace, path, new_path, confirm, allow_improve_paths }) => {
      const nsError = await requireRegisteredNamespace(db, namespace);
      if (nsError) return fail(nsError);
      // Existence and the edge count are both read BEFORE the batch. D1's meta.changes
      // cannot be used for either: documents carries FTS5 sync triggers, so an UPDATE
      // reports the trigger's row changes too, and in a batch those accumulate across
      // statements.
      const exists = await db
        .prepare("SELECT 1 AS ok FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ ok: number }>();
      if (!exists) return fail(`not found: ${namespace}/${path}`);
      // The improve control-surface guard on both ends (see improvePathsRefusal).
      // Either path can steer the loop: moving a document into improve/skills/ installs
      // a skill other namespaces' runs re-inject, and moving run.md out of
      // improve/prompts/ drops the attempt generator to its hardcoded default. The
      // source is emptied, the destination is filled with the moved body.
      const moved = await db
        .prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ body: string | null }>();
      const movedBody = moved?.body ?? "";
      const moveImproveRefusal = await improvePathsRefusal(ctx, "move", namespace, allow_improve_paths, [
        { path, before: movedBody, after: "" },
        { path: new_path, before: null, after: movedBody },
      ]);
      if (moveImproveRefusal) return fail(moveImproveRefusal);
      // move needs confirmation: it repoints every edge and, unlike delete, leaves no
      // snapshot of the old path, only an audit row.
      const moveRefusal = await requireConfirmation(server, confirm, {
        prompt: `Rename ${namespace}/${path} to ${namespace}/${new_path}? Edges pointing at the old path are repointed.`,
        declined: `move of ${namespace}/${path} declined`,
        unsupported: `confirmation required: re-run move with confirm: true to rename ${namespace}/${path} to ${new_path}.`,
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
