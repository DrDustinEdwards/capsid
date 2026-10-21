import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { IMPROVE_OVERRIDE_FLAGS } from "../scope";
import { surfaceOf } from "./surface";
import { sha256Hex } from "../auth";
import { auditStatement, documentUpsert, guardedCommit, snapshotLive, snapshotTaken } from "../store-guards";
import { normalizeDashes } from "../normalize";
import { parseLinks, type LinkEdge } from "../links";
import { JOB_DOC_PREFIX } from "../jobs-schema";
import { validateDocStatus, validateDocType } from "../doc-meta";
import { bounded, MAX_BODY, MAX_DOC_STATUS, MAX_DOC_TYPE, MAX_LINKS_JSON, MAX_SHA, MAX_TAGS, MAX_TITLE, nsName, docPath } from "../limits";
import { assembleBody } from "../write-modes";
import { policyWriteRefusal } from "../signed-docs";
import { concurrentEditWarning } from "../server";
import { canonGuarded, proposeCanon } from "../canon";
import { ruleDocWriteRefusal } from "../rule-docs";
import { ok, fail, type ToolCtx, requireConfirmation } from "./docs";

// The document tools that change the store: write, restore, delete and move.
// defineDocOperations in ./docs registers them in the published order.

export async function requireRegisteredNamespace(db: D1Database, namespace: string): Promise<string | null> {
  const row = await db.prepare("SELECT namespace FROM namespaces WHERE namespace = ?1").bind(namespace).first();
  if (row) return null;
  return (
    `unknown namespace '${namespace}'. Nothing was written. Documents can only live in a registered namespace, ` +
    `because an unregistered one is invisible to the namespaces list, the lint loop and every repo tool. ` +
    `Check the spelling against capsid_find_docs action namespaces, or have the admin create it with capsid_admin_manage_namespaces action register.`
  );
}

// The policy-document check for write, restore, delete and move. First the override
// is itself scoped: allow_improve_paths is how a caller writes a signed policy
// document, and it is the document-side twin of the repo-side protected-path flag, so
// it asks for the same one (IMPROVE_OVERRIDE_FLAGS in src/scope.ts). Then
// policyWriteRefusal runs on every path the call changes, and so does the job-mirror
// check. Returns the first refusal, or null.
export function policyPathsRefusal(
  ctx: ToolCtx,
  tool: "write" | "restore" | "delete" | "move",
  namespace: string,
  allowImprovePaths: boolean | undefined,
  paths: string[]
): string | null {
  const allow = allowImprovePaths === true;
  if (allow) {
    const overrideRefusal = ctx.scope({ ...surfaceOf(tool), namespace, flags: IMPROVE_OVERRIDE_FLAGS });
    if (overrideRefusal) return overrideRefusal;
  }
  for (const path of paths) {
    const refusal = policyWriteRefusal(namespace, path, allow) ?? jobMirrorRefusal(tool, namespace, path);
    if (refusal) return refusal;
  }
  return null;
}

// A document under jobs/ is a job's mirror (jobDocPath in src/jobs-schema.ts): a
// projection of the jobs row, written only by the jobs code in the same batch as the
// row. The brief serves it as a task, so one written here could stand in for a signed job
// that was never posted (Grok audit 2026-10, M2). No caller and no flag writes one by hand.
function jobMirrorRefusal(tool: "write" | "restore" | "delete" | "move", namespace: string, path: string): string | null {
  if (!path.startsWith(JOB_DOC_PREFIX)) return null;
  return (
    `${namespace}/${path} is under ${JOB_DOC_PREFIX}, where each document mirrors a job and is written only by capsid_work_jobs. ` +
    `A ${tool} here is refused for every caller. Nothing changed. Change the job through capsid_work_jobs.`
  );
}

// A supersedes or replaces edge makes the daily pass mark its target superseded
// (src/supersede.ts), so it is a change to the target and asks what a write to the target
// asks: the write grant on its namespace, through checkScope
// (one enforcement point, test/scope.test.ts), and the seat for a canon document (Grok audit 2026-10, M4). Other edge
// types change nothing and may point anywhere. The refusal, or null.
function supersedingEdgeRefusal(ctx: ToolCtx, namespace: string, edges: LinkEdge[]): string | null {
  for (const edge of edges) {
    if (edge.type !== "supersedes" && edge.type !== "replaces") continue;
    const target = `${edge.to_ns}/${edge.to_path}`;
    if (edge.to_ns !== namespace) {
      const refusal = ctx.scope({ ...surfaceOf("write"), grant: "write", namespace: edge.to_ns });
      if (refusal) return `a ${edge.type} edge to ${target} marks it superseded, so it needs the write grant on ${edge.to_ns}: ${refusal} Nothing was written.`;
    }
    if (canonGuarded(ctx.agent, edge.to_ns, edge.to_path)) {
      return `a ${edge.type} edge to ${target} would mark a canon document superseded, which is the seat's change to make. Nothing was written. Use references, or ask the seat.`;
    }
  }
  return null;
}

export function defineWriteOperation(server: McpServer, ctx: ToolCtx): void {
  const { db, actor } = ctx;

  ctx.ops.define(
    "write",
    {
      description:
        "Create or update a document. Snapshots the prior version and writes an audit log entry. mode selects how body is applied: 'replace' (default, full body, needs title and body), 'append' (body is added to the end; no title or confirmation needed), 'patch' (needs find and replace_with; find must occur EXACTLY ONCE or the write is refused), or 'meta' (change type, tags, status or title and leave the body byte-identical). Every response carries sha256 and bytes of the resulting body. Optional if_match: the sha256 of the body you believe is stored; when it does not match, the write is REFUSED and the error carries the current sha256. Overwriting with replace or patch needs confirmation: the server elicits it when the client supports elicitation, otherwise pass confirm: true. Optional links: a JSON array of outgoing edges [{\"type\":\"references\",\"to_path\":\"conventions.md\",\"to_ns\":\"capsid\"}] (types: governs, references, supersedes, replaces, depends-on; to_ns defaults to this namespace) that replaces this document's outgoing edges; omit it to keep them, pass [] to clear them. CANON: a write to capsid/conventions*.md, any namespace's core.md, or decisions.md and its archived volumes, by a caller that is not the seat or the admin, is NOT applied: it is stored as a proposal for the seat or Dustin to approve and returns action 'pending_review' with the proposal id (links are refused on such a write). Needs the write grant.",
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
        // Opt-in to writing a signed policy document (policy/). Refused without it;
        // audit-logged with it. See policyWriteRefusal.
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
      const edgeRefusal = parsedLinks ? supersedingEdgeRefusal(ctx, namespace, parsedLinks.edges) : null;
      if (edgeRefusal) return fail(edgeRefusal);
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

      // The policy-document guard. Refused unless allow_improve_paths was passed.
      const policyRefusal = policyPathsRefusal(ctx, "write", namespace, allow_improve_paths, [path]);
      if (policyRefusal) return fail(policyRefusal);

      // A rule document (src/rule-docs.ts) may not be made worse: over its cap and
      // larger than before, or naming a tool the Worker does not serve. Checked before
      // the canon branch, so a proposal that could never be applied is refused too.
      const ruleRefusal = ruleDocWriteRefusal(namespace, path, prior?.body ?? null, body as string);
      if (ruleRefusal) return fail(ruleRefusal);

      // Canon write-protection (src/canon.ts). A driver's write to a canon document is
      // stored as a proposal for the seat or Dustin to approve, never applied here. It
      // needs no overwrite confirmation, because it overwrites nothing. links are not
      // carried by a proposal, so a canon write that sets them is refused rather than
      // having them dropped without a word.
      if (canonGuarded(ctx.agent, namespace, path)) {
        if (parsedLinks) {
          return fail(`${namespace}/${path} is canon, so this write becomes a proposal, and a proposal carries no links. Nothing was written. Write it again without links.`);
        }
        const proposed = await proposeCanon(db, actor, new Date(), {
          namespace,
          path,
          title: title ?? null,
          body: body as string,
          type: type ?? null,
          tags: tags ?? null,
          status: status ?? null,
          mode: writeMode,
          priorBody: prior?.body ?? null,
          priorExists: Boolean(prior),
        });
        return ok({
          namespace,
          path,
          action: "pending_review",
          proposal: proposed.id,
          base_sha256: proposed.base_sha,
          directive_lines: proposed.directive_lines,
          note:
            `${namespace}/${path} is canon (src/canon.ts). Nothing was written to it: proposal ${proposed.id} waits for the seat or Dustin to approve it in Capsid Portal. ` +
            `It is applied only if the document is still the one you read; if it changes first, the proposal is rejected and you write it again.` +
            (proposed.directive_lines.length ? ` ${proposed.directive_lines.length} added line(s) read as instructions to agents and are highlighted for the reviewer.` : ""),
        });
      }

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
          unsupported: `confirmation required: ${namespace}/${path} already exists. Re-run capsid_write_doc with confirm: true to overwrite it. The current version will be snapshotted to document_versions first.`,
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
      // The edges replaced are recorded before the DELETE in the same batch, as a delete
      // records the edges it removes, so the audit row is where they survive.
      if (parsedLinks && "edges" in parsedLinks) {
        statements.push(
          db
            .prepare(
              `INSERT INTO audit_log (actor, action, namespace, path, params)
               SELECT ?1, 'links', ?2, ?3, json_object('edges', ?4, 'edges_replaced', json_group_array(
                 json_object('type', type, 'to_ns', to_ns, 'to_path', to_path)))
               FROM document_links WHERE from_ns = ?2 AND from_path = ?3`
            )
            .bind(actor, namespace, path, parsedLinks.edges.length),
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
