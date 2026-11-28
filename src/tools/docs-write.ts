import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { IMPROVE_OVERRIDE_FLAGS } from "../scope";
import { toolSurfaceOf } from "./surface";

import {
  auditStatement,
  documentUpsert,
  guardedCommit,
  snapshotLive,
  snapshotTaken,
} from "../store-guards";
import { normalizeDashes } from "../normalize";
import { parseLinks, type LinkEdge } from "../links";
import { validateDocStatus, validateDocType } from "../doc-meta";
import {
  bounded,
  MAX_BODY,
  MAX_DOC_STATUS,
  MAX_DOC_TYPE,
  MAX_LINKS_JSON,
  MAX_SHA,
  MAX_TAGS,
  MAX_TITLE,
  nsName,
  docPath,
} from "../limits";
import { assembleBody } from "../write-modes";
import { policyWriteRefusal } from "../policy-docs";
import { concurrentEditWarning } from "../server";
import { canonGuarded, canonRefusal } from "../canon";
import { ruleDocWriteRefusal } from "../rule-docs";
import { ok, fail, type ToolCtx, requireConfirmation } from "./docs";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";

export async function requireRegisteredNamespace(
  db: D1Database,
  namespace: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT namespace FROM namespaces WHERE namespace = ?1")
    .bind(namespace)
    .first();
  if (row) return null;
  return (
    `unknown namespace '${namespace}'. Nothing was written. Documents can only live in a registered namespace, ` +
    `because an unregistered one is invisible to the namespaces list, the lint loop and every repo tool. ` +
    `Check the spelling against capsid_find_docs action namespaces, or have the admin create it with capsid_admin_manage_namespaces action register.`
  );
}

// allow_improve_paths is itself scoped: the document-side twin of the repo-side protected-path flag
// (IMPROVE_OVERRIDE_FLAGS in src/scope.ts).
export function policyPathsRefusal(
  ctx: ToolCtx,
  tool: "write" | "restore" | "delete" | "move",
  namespace: string,
  allowImprovePaths: boolean | undefined,
  paths: string[],
): string | null {
  const allow = allowImprovePaths === true;
  if (allow) {
    const overrideRefusal = ctx.scope({
      ...toolSurfaceOf(tool),
      namespace,
      flags: IMPROVE_OVERRIDE_FLAGS,
    });
    if (overrideRefusal) return overrideRefusal;
  }
  for (const path of paths) {
    const refusal = policyWriteRefusal(namespace, path, allow);
    if (refusal) return refusal;
  }
  return null;
}

// A supersedes or replaces edge makes the daily pass mark its target superseded (src/supersede.ts),
// so it asks what a write to the target asks.
function supersedingEdgeRefusal(ctx: ToolCtx, namespace: string, edges: LinkEdge[]): string | null {
  for (const edge of edges) {
    if (edge.type !== "supersedes" && edge.type !== "replaces") continue;
    const target = `${edge.to_ns}/${edge.to_path}`;
    if (edge.to_ns !== namespace) {
      const refusal = ctx.scope({
        ...toolSurfaceOf("write"),
        grant: "write",
        namespace: edge.to_ns,
      });
      if (refusal)
        return `a ${edge.type} edge to ${target} marks it superseded, so it needs the write grant on ${edge.to_ns}: ${refusal} Nothing was written.`;
    }
    if (canonGuarded(ctx.agent, edge.to_ns, edge.to_path)) {
      return `a ${edge.type} edge to ${target} would mark a canon document superseded, which is the seat's change to make. Nothing was written. Use references, or ask the seat.`;
    }
  }
  return null;
}

export function defineWriteOperation(server: McpServer, ctx: ToolCtx): void {
  const { db, actor, client } = ctx;

  ctx.ops.define(
    "write",
    {
      description:
        'Create or update a document. Snapshots the prior version and writes an audit log entry. mode selects how body is applied: \'replace\' (default, full body, needs title and body), \'append\' (body is added to the end; no title or confirmation needed), \'patch\' (needs find and replace_with; find must occur EXACTLY ONCE or the write is refused), or \'meta\' (change type, tags, status or title and leave the body byte-identical). Every response carries sha256 and bytes of the resulting body. Optional if_match: the sha256 of the body you believe is stored; when it does not match, the write is REFUSED and the error carries the current sha256. Overwriting with replace or patch needs confirmation: the server elicits it when the client supports elicitation, otherwise pass confirm: true. Optional links: a JSON array of outgoing edges [{"type":"references","to_path":"conventions.md","to_ns":"capsid"}] (types: governs, references, supersedes, replaces, depends-on; to_ns defaults to this namespace) that replaces this document\'s outgoing edges; omit it to keep them, pass [] to clear them. CANON: a write to capsid/conventions*.md, any namespace\'s core.md, decisions.md and its archived volumes, or a capsid/rulings/ record is REFUSED for an agent key; the admin and the seat write it like any document. Needs the write grant.',
      inputSchema: {
        namespace: nsName,
        path: docPath,
        // Optional in the schema because append and patch need no title; required for 'replace' and
        // validated below.
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
        allow_improve_paths: z.boolean().optional(),
      },
    },
    async ({
      namespace,
      path,
      title,
      body,
      mode,
      find,
      replace_with,
      type,
      tags,
      status,
      confirm,
      links,
      if_match,
      allow_improve_paths,
    }) => {
      const writeMode = mode ?? "replace";
      const typeError = type === undefined ? null : validateDocType(type);
      if (typeError) return fail(typeError);
      const statusError = status === undefined ? null : validateDocStatus(status);
      if (statusError) return fail(statusError);
      const parsedLinks = links === undefined ? null : parseLinks(links, namespace);
      if (parsedLinks && "error" in parsedLinks) return fail(parsedLinks.error);
      const edgeRefusal = parsedLinks
        ? supersedingEdgeRefusal(ctx, namespace, parsedLinks.edges)
        : null;
      if (edgeRefusal) return fail(edgeRefusal);
      const nsError = await requireRegisteredNamespace(db, namespace);
      if (nsError) return fail(nsError);

      const prior = await db
        .prepare(
          "SELECT id, title, body, type, status, tags, updated_at FROM documents WHERE namespace = ?1 AND path = ?2",
        )
        .bind(namespace, path)
        .first<{
          id: number;
          title: string | null;
          body: string | null;
          type: string | null;
          status: string | null;
          tags: string | null;
          updated_at: string;
        }>();

      // Optimistic concurrency: on an if_match mismatch nothing is written and the error carries
      // the current sha. Opt-in, because append is safe by construction.
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

      // Normalize only the caller's text before assembly: normalizing the assembled body would
      // rewrite stored text the caller did not touch (conventions.md); find is not normalized
      // because it must match stored bytes.
      if (title !== undefined) title = normalizeDashes(title, "title");
      if (body !== undefined) body = normalizeDashes(body, "prose");
      if (replace_with !== undefined) replace_with = normalizeDashes(replace_with, "prose");

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
      if (
        writeMode === "meta" &&
        title === undefined &&
        type === undefined &&
        tags === undefined &&
        status === undefined
      ) {
        return fail(
          `mode 'meta' needs at least one of title, type, tags or status to change (${namespace}/${path}).`,
        );
      }

      const policyRefusal = policyPathsRefusal(ctx, "write", namespace, allow_improve_paths, [
        path,
      ]);
      if (policyRefusal) return fail(policyRefusal);

      // A rule document (src/rule-docs.ts) may not be made worse: over its cap and larger than
      // before, or naming a tool the Worker does not serve.
      const ruleRefusal = ruleDocWriteRefusal(namespace, path, prior?.body ?? null, body as string);
      if (ruleRefusal) return fail(ruleRefusal);

      if (canonGuarded(ctx.agent, namespace, path))
        return fail(canonRefusal("write", namespace, path));

      // append and meta are exempt from confirmation (it stops accidental clobbers; an append
      // destroys nothing). `elicited` arms the commit-time body guard.
      let elicited = false;
      if (prior && confirm !== true && writeMode !== "append" && writeMode !== "meta") {
        const refusal = await requireConfirmation(server, confirm, {
          prompt: `Overwrite ${namespace}/${path}? The current version will be snapshotted to document_versions first.`,
          declined: `overwrite of ${namespace}/${path} declined`,
          unsupported: `confirmation required: ${namespace}/${path} already exists. Re-run capsid_write_doc with confirm: true to overwrite it. The current version will be snapshotted to document_versions first.`,
        });
        if (!refusal.ok) return fail(refusal.message);
        elicited = refusal.elicited;
      }
      const statements: D1PreparedStatement[] = [];
      if (prior) {
        // Snapshot from the live row inside the batch: binding the pre-read body would let a body
        // written in the gap be overwritten while the snapshot recorded its predecessor.
        statements.push(snapshotLive(db, namespace, path));
      }
      statements.push(
        documentUpsert(
          db,
          namespace,
          path,
          title ?? null,
          body,
          type ?? null,
          tags ?? null,
          status ?? null,
        ),
      );
      // document_versions snapshots title and body only; widening it would need a migration and a
      // rewrite of every restore path.
      const metaChanged =
        title !== undefined || type !== undefined || tags !== undefined || status !== undefined;
      statements.push(
        auditStatement(
          db,
          actor,
          "write",
          namespace,
          path,
          {
            title,
            type,
            tags,
            status,
            mode: writeMode,
            updated: Boolean(prior),
            ...(allow_improve_paths === true ? { allow_improve_paths: true } : {}),
            ...(prior && metaChanged
              ? {
                  prior_meta: {
                    title: prior.title,
                    type: prior.type,
                    status: prior.status,
                    tags: prior.tags,
                  },
                }
              : {}),
          },
          client,
        ),
      );
      // Omitted links leave edges untouched, so a body edit never drops them; replaced edges are
      // recorded before the DELETE so the audit row keeps them.
      if (parsedLinks && "edges" in parsedLinks) {
        statements.push(
          db
            .prepare(
              `INSERT INTO audit_log (actor, action, namespace, path, params, client)
               SELECT ?1, 'links', ?2, ?3, json_object('edges', ?4, 'edges_replaced', json_group_array(
                 json_object('type', type, 'to_ns', to_ns, 'to_path', to_path))), ?5
               FROM document_links WHERE from_ns = ?2 AND from_path = ?3`,
            )
            .bind(actor, namespace, path, parsedLinks.edges.length, client ?? null),
          db
            .prepare("DELETE FROM document_links WHERE from_ns = ?1 AND from_path = ?2")
            .bind(namespace, path),
        );
        for (const edge of parsedLinks.edges) {
          statements.push(
            db
              .prepare(
                "INSERT OR IGNORE INTO document_links (from_ns, from_path, type, to_ns, to_path) VALUES (?1, ?2, ?3, ?4, ?5)",
              )
              .bind(namespace, path, edge.type, edge.to_ns, edge.to_path),
          );
        }
      }
      // Read here, not from the pre-read: a 90 second elicitation in between is when a racing write
      // is most likely to have landed.
      const atCommit = prior
        ? await db
            .prepare("SELECT updated_at FROM documents WHERE namespace = ?1 AND path = ?2")
            .bind(namespace, path)
            .first<{ updated_at: string }>()
        : null;
      const committed = await commit.run(elicited, statements);
      if ("refusal" in committed) return fail(committed.refusal);
      // From the snapshot statement's own result: with no guard armed, a row deleted after the
      // pre-read is snapshotted by nothing.
      const snapshotted = Boolean(prior) && snapshotTaken(committed.results[0]);
      // Warn, do not reject, on a dangling edge: rejecting would block asserting an edge before its
      // target is written.
      let danglingTargets: string[] = [];
      if (parsedLinks && "edges" in parsedLinks && parsedLinks.edges.length > 0) {
        // Runs after the commit, so a failure here must not be reported as a failed write.
        try {
          const checks = await db.batch(
            parsedLinks.edges.map((edge) =>
              db
                .prepare("SELECT 1 AS ok FROM documents WHERE namespace = ?1 AND path = ?2")
                .bind(edge.to_ns, edge.to_path),
            ),
          );
          danglingTargets = parsedLinks.edges
            .filter((_, i) => (checks[i].results?.length ?? 0) === 0)
            .map((edge) => `${edge.to_ns}/${edge.to_path}`);
        } catch {}
      }
      // The read-back hash and length let a caller verify the write without a second read, itself a
      // chance of transcription error.
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
              const warning = concurrentEditWarning(
                atCommit?.updated_at ?? prior.updated_at,
                Date.now(),
              );
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
    },
  );
}
