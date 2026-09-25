import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hintsFor } from "../tool-annotations";
import { z } from "zod";
import { repoBlobPaths, resolveRepo } from "../github";
import { auditStatement, documentUpsert, isMissingRowAbort, requireExists, snapshotLive } from "../store-guards";
import { authoritativeFor, scanCountClaims } from "../counts";
import { buildTruthReport, isUnscanned, renderTruthReport, reportPath, type ReportDoc, type ReportEdge } from "../truth-report";
import { docPath, GATHER_BUDGET, LINT_CONSUMED_MAX, nsName } from "../limits";
import { improveWriteRefusal } from "../improve-scores";
import { fail, ok, pathMutation, requireConfirmation, type ToolCtx } from "./docs";

// Exported so test/lint-description.test.ts can derive the check list from a real
// buildTruthReport response and assert this names every id.
export const LINT_DESCRIPTION =
  "Consolidation loop and truth report for a namespace. mode 'gather' (default, read-only) returns current core.md, the concept and decision docs, every unconsolidated episodic and source doc, and the capsid schema and conventions rules. After writing the updated core.md and concept docs via write, call mode 'finalize' with consumed: the episodic/source paths that were compiled. Finalize moves them under archive/ (never deletes, never touches core or concept docs) and writes one audit row. mode 'report' measures the store instead of compiling it. It runs six checks and the response names each one by these ids: `contradictions` (prose asserting a number the artifact disagrees with), `stale_decisions`, `unbound_specs`, `broken_links`, `doc_vs_code_drift` (a repo path named in canon that is no longer in the repo) and `unconsolidated` (the episodic and source backlog). It also counts documents by type and returns one integrity percentage, which excludes a check that could not run. It stores the result as <namespace>/reports/lint-<date>.md. lint reads only what the caller is scoped to, except capsid/schema.md and capsid/conventions.md, which every caller gets. An edge whose other end is in an out-of-scope namespace is left out of gather and report, and report skips the repo drift check when the namespace's repo is outside the caller's repo scope. finalize and report need the write grant. finalize, and a report that would overwrite one for the same date, need confirmation: elicited when the client supports it, otherwise pass confirm: true.";

export function registerLintTools(server: McpServer, ctx: ToolCtx): void {
  const { env, db, actor } = ctx;

  // Consolidation loop (the LLM Wiki maintenance step). The Worker does no reasoning:
  // a capable client calls gather, synthesizes the update with the read and write
  // tools, then calls finalize to archive what it consumed.
  //
  // The report's checks are named by their response ids, not paraphrased, so a test
  // can derive this list from the report itself. A description that miscounts what
  // sits beside it is the defect the count lint exists for.
  server.registerTool(
    "lint",
    {
      annotations: hintsFor("lint"),
      description: LINT_DESCRIPTION,
      inputSchema: {
        namespace: nsName,
        mode: z.enum(["gather", "finalize", "report"]).optional(),
        // Bounded: the finalize batch spends four statements per path plus one audit
        // row, and D1 caps a batch at 100 statements. The bound keeps the archive one atomic batch; see LINT_CONSUMED_MAX.
        consumed: z.array(docPath).max(LINT_CONSUMED_MAX).optional(),
        confirm: z.boolean().optional(),
      },
    },
    async ({ namespace, mode, consumed, confirm }) => {
      // lint reads only what the caller is scoped to. The registrar checks the
      // namespace argument, but gather and report also read the far end of every edge
      // that touches this namespace, and the namespace's repo tree. Each is asked of
      // checkScope with this call's action before it is read or returned. capsid's
      // schema and conventions are exempt: see the rules query in gather.
      const action = mode ?? "gather";
      const reaches = (other: string) => ctx.scope({ tool: "lint", action, namespace: other }) === null;
      const withinScope = <T extends { from_ns: unknown; to_ns: unknown }>(rows: T[]) =>
        rows.filter((e) => reaches(String(e.from_ns)) && reaches(String(e.to_ns)));
      if (action === "gather") {
        // Gather needs the read grant. lint is an "action" tool, so the registrar names
        // no grant and leaves it to the handler, where the mode is known, and gather
        // returns before the write-grant check below. Without this, gather would ask
        // for no grant at all.
        const gatherRefusal = ctx.scope({ tool: "lint", action: "gather", grant: "read", namespace });
        if (gatherRefusal) return fail(gatherRefusal);
        const core = await db
          .prepare("SELECT namespace, path, title, type, status, body, updated_at FROM documents WHERE namespace = ?1 AND path = 'core.md'")
          .bind(namespace)
          .first();
        const wiki = await db
          .prepare(
            `SELECT namespace, path, title, type, status, tags, body, updated_at
             FROM documents
             WHERE namespace = ?1 AND type IN ('concept', 'decision')
             ORDER BY path`
          )
          .bind(namespace)
          .all();
        // Not filtered on status: only the archive/ prefix removes a doc, which keeps
        // gather idempotent after finalize.
        const raw = await db
          .prepare(
            `SELECT namespace, path, title, type, status, tags, body, created_at, updated_at
             FROM documents
             WHERE namespace = ?1 AND type IN ('episodic', 'source')
               AND path NOT LIKE 'archive/%'
             ORDER BY created_at`
          )
          .bind(namespace)
          .all();
        // capsid/schema.md and capsid/conventions.md are exempt from the namespace
        // filter: they are the rules every caller's lint runs under. The exemption is these two paths only; no other
        // capsid document is read here.
        const rules = await db
          .prepare("SELECT namespace, path, title, body FROM documents WHERE namespace = 'capsid' AND path IN ('schema.md', 'conventions.md') ORDER BY path")
          .all();
        // Typed edges whose endpoint no longer exists. Gather is read-only and the
        // client judges, so these are reported, never auto-repaired: a dangling edge
        // usually means the target was renamed by hand or removed before delete
        // cascaded, and which of those decides whether the fix is repointing the edge
        // or dropping it. Both endpoints are checked. An edge whose other end is in a
        // namespace this caller is not scoped to is dropped: whether that document
        // exists is a fact about the other namespace.
        const danglingEdges = await db
          .prepare(
            `SELECT l.from_ns, l.from_path, l.type, l.to_ns, l.to_path,
                    CASE WHEN f.id IS NULL THEN 1 ELSE 0 END AS source_missing,
                    CASE WHEN t.id IS NULL THEN 1 ELSE 0 END AS target_missing
             FROM document_links l
             LEFT JOIN documents f ON f.namespace = l.from_ns AND f.path = l.from_path
             LEFT JOIN documents t ON t.namespace = l.to_ns AND t.path = l.to_path
             WHERE (f.id IS NULL OR t.id IS NULL)
               AND (l.from_ns = ?1 OR l.to_ns = ?1)
             ORDER BY l.from_ns, l.from_path, l.type`
          )
          .bind(namespace)
          .all<ReportEdge>();
        // Bounded to GATHER_BUDGET. Trim order follows what gather is for. The client needs core (the thing
        // being updated), the unconsolidated docs (the input being compiled), and the
        // wiki (current state). The wiki is the largest section and the most
        // re-readable one document at a time, so it stubs first. Unconsolidated bodies
        // are held back last, oldest kept, because oldest-first is the compile order.
        // core and rules are never trimmed: they are the rules of the job.
        type PacketRow = { namespace?: unknown; path?: unknown; body?: unknown };
        const bodyChars = (row: unknown) => String((row as PacketRow | null)?.body ?? "").length;
        const sumChars = (rows: unknown[]) => rows.reduce<number>((sum, r) => sum + bodyChars(r), 0);
        const toStub = (row: unknown) => {
          const r = row as PacketRow;
          return { ...(row as object), body: `(trimmed for size: read ${String(r.namespace)}/${String(r.path)})` };
        };

        const trimmed: string[] = [];
        const fixed = bodyChars(core) + sumChars(rules.results);
        let wikiOut: unknown[] = wiki.results;
        if (fixed + sumChars(wiki.results) + sumChars(raw.results) > GATHER_BUDGET) {
          wikiOut = wiki.results.map(toStub);
          trimmed.push(`${wiki.results.length} wiki bodies (concept and decision docs; read them individually by path)`);
        }

        // Keep whole documents, never half a body: a truncated markdown document is
        // worse than an honest stub, because the client cannot tell it is reading a
        // fragment.
        let running = fixed + sumChars(wikiOut);
        let heldBack = 0;
        const unconsolidatedOut = raw.results.map((row) => {
          if (running + bodyChars(row) <= GATHER_BUDGET) {
            running += bodyChars(row);
            return row;
          }
          heldBack++;
          return toStub(row);
        });
        if (heldBack > 0) {
          trimmed.push(
            `${heldBack} of ${raw.results.length} unconsolidated bodies (the oldest were kept, which is the compile order; finalize this batch and call gather again for the rest)`
          );
        }
        const packetChars = fixed + sumChars(wikiOut) + sumChars(unconsolidatedOut);
        // Prose counts checked against the artifacts they describe. Standing docs only; episodics record history and their numbers were right
        // when written. FLAG, never correct: the claims come back for a human to
        // judge, and nothing here rewrites a document.
        const standing = await db
          .prepare(
            `SELECT path, type, body FROM documents
             WHERE namespace = ?1 AND path NOT LIKE 'archive/%'`
          )
          .bind(namespace)
          .all<{ path: string; type: string | null; body: string | null }>();
        // Namespace-scoped: a namespace with no authoritative numbers of its own
        // gets no claims, rather than being measured against capsid's.
        const countClaims = scanCountClaims(standing.results, namespace);

        return ok({
          mode: "gather",
          namespace,
          core: core ?? null,
          wiki: wikiOut,
          unconsolidated: unconsolidatedOut,
          rules: rules.results,
          dangling_edges: withinScope(danglingEdges.results),
          authoritative_counts: authoritativeFor(namespace),
          count_claims: countClaims,
          packet_chars: packetChars,
          budget: GATHER_BUDGET,
          truncated: trimmed.length > 0,
          ...(trimmed.length ? { trimmed } : {}),
        });
      }

      // report and finalize both write documents, so the write grant is checked here,
      // where the mode is known.
      const modeRefusal = ctx.scope({ tool: "lint", grant: "write", namespace });
      if (modeRefusal) return fail(modeRefusal);

      // mode "report" measures the store and stores the result, so the trend is a
      // document (capsid/conventions.md: a number that lives only here can be wrong
      // forever and nothing notices). One document per namespace per day: a second
      // run the same date overwrites it.
      if (mode === "report") {
        const now = new Date();
        const docs = await db
          .prepare(
            `SELECT path, type, status, title, body, updated_at FROM documents
             WHERE namespace = ?1 ORDER BY path`
          )
          .bind(namespace)
          .all<ReportDoc>();
        const edges = await db
          .prepare(
            `SELECT from_ns, from_path, type, to_ns, to_path FROM document_links
             WHERE from_ns = ?1 OR to_ns = ?1`
          )
          .bind(namespace)
          .all<ReportEdge>();
        const dangling = await db
          .prepare(
            `SELECT l.from_ns, l.from_path, l.type, l.to_ns, l.to_path,
                    CASE WHEN f.id IS NULL THEN 1 ELSE 0 END AS source_missing,
                    CASE WHEN t.id IS NULL THEN 1 ELSE 0 END AS target_missing
             FROM document_links l
             LEFT JOIN documents f ON f.namespace = l.from_ns AND f.path = l.from_path
             LEFT JOIN documents t ON t.namespace = l.to_ns AND t.path = l.to_path
             WHERE (f.id IS NULL OR t.id IS NULL)
               AND (l.from_ns = ?1 OR l.to_ns = ?1)`
          )
          .bind(namespace)
          .all<ReportEdge>();
        // The count-claim scan wants standing documents only, same as gather.
        // `isUnscanned` is the one statement of which prefixes those are, so the
        // scanner and the report cannot disagree about what is a subject.
        const claims = scanCountClaims(
          docs.results.filter((d) => !isUnscanned(d.path)).map((d) => ({ path: d.path, type: d.type, body: d.body })),
          namespace
        );
        // Undefined, not an empty set, when the tree cannot be read or the repo is out
        // of this caller's scope: an empty set would report every path the canon names
        // as drift. buildTruthReport excludes the check from integrity instead.
        let repoPaths: Set<string> | undefined;
        try {
          const { full } = await resolveRepo(env, namespace);
          if (ctx.scope({ tool: "lint", action, namespace, repo: full }) === null) {
            repoPaths = (await repoBlobPaths(env, namespace, full)) ?? undefined;
          }
        } catch {
          repoPaths = undefined;
        }

        const report = buildTruthReport({
          namespace,
          now,
          docs: docs.results,
          // Both lists drop an edge whose other end is out of this caller's scope, so
          // broken_links counts subjects and findings over the same edges.
          edges: withinScope(edges.results),
          danglingEdges: withinScope(dangling.results),
          countClaims: claims.map((c) => ({ path: c.path, noun: c.noun, states: c.states, authoritative: c.authoritative, quote: c.quote })),
          repoPaths,
        });
        const path = reportPath(now);
        const body = renderTruthReport(report);
        // Snapshotted and audited like any other document (CLAUDE.md, snapshot rule).
        const prior = await db
          .prepare("SELECT id, title, body FROM documents WHERE namespace = ?1 AND path = ?2")
          .bind(namespace, path)
          .first<{ id: number; title: string | null; body: string | null }>();
        const title = `Truth report - ${namespace} - ${path.slice("reports/lint-".length, -3)}`;
        // The same confirmation `write` asks for, since a second run the same date
        // overwrites the first. The prior body is snapshotted either way, but without
        // asking, the caller gets no say and the response never mentions that a report
        // was replaced. A first report for the date needs none.
        if (prior) {
          const overwrite = await requireConfirmation(server, confirm, {
            prompt: `Overwrite the truth report at ${namespace}/${path}? The current version will be snapshotted to document_versions first.`,
            declined: `report for ${namespace}/${path} declined; nothing was written`,
            unsupported: `confirmation required: ${namespace}/${path} already exists. Re-run lint report with confirm: true to overwrite it. The current version will be snapshotted to document_versions first.`,
          });
          if (!overwrite.ok) return fail(overwrite.message);
        }
        const statements = [];
        if (prior) {
          statements.push(snapshotLive(db, namespace, path));
        }
        // The same upsert the `write` tool issues, from the one helper both call.
        statements.push(documentUpsert(db, namespace, path, title, body, "reference", null, "published"));
        statements.push(
          auditStatement(db, actor, "lint_report", namespace, path, { integrity: report.integrity, findings: report.findings.length })
        );
        await db.batch(statements);
        return ok({ mode: "report", stored: `${namespace}/${path}`, ...report });
      }

      const paths = [...new Set(consumed ?? [])];
      if (paths.length === 0) {
        return fail("finalize requires consumed: the episodic/source paths that were compiled into the wiki");
      }
      const problems: string[] = [];
      for (const path of paths) {
        const row = await db
          .prepare("SELECT type FROM documents WHERE namespace = ?1 AND path = ?2")
          .bind(namespace, path)
          .first<{ type: string | null }>();
        if (!row) problems.push(`not found: ${namespace}/${path}`);
        else if (path.startsWith("archive/")) problems.push(`already archived: ${namespace}/${path}`);
        else if (row.type !== "episodic" && row.type !== "source") {
          problems.push(`not consumable: ${namespace}/${path} has type '${row.type}' (only episodic and source docs are archived)`);
        }
      }
      if (problems.length > 0) return fail(`finalize aborted, nothing archived:\n${problems.join("\n")}`);
      // The improve control-surface guard. finalize is type-gated to episodic and
      // source documents and improve documents are task, prompt and reference, so this
      // looks unreachable. It is not: a document written to an improve path with the
      // opt-in flag can carry type 'source', and finalize would then archive the run
      // prompt out from under the loop. No opt-in here: archiving the loop's control
      // surface is never right.
      const consumedImproveRefusals = (
        await Promise.all(paths.map((consumedPath) => improveWriteRefusal(namespace, consumedPath, null, "", false)))
      ).filter((r): r is string => r !== null);
      if (consumedImproveRefusals.length > 0) {
        return fail(`finalize aborted, nothing archived:\n${consumedImproveRefusals.join("\n")}`);
      }
      // finalize needs confirmation: one call renames every consumed document.
      const finalizeRefusal = await requireConfirmation(server, confirm, {
        prompt: `Archive ${paths.length} document(s) in ${namespace} by moving them under archive/?`,
        declined: `finalize of ${namespace} declined`,
        unsupported: `confirmation required: re-run lint finalize with confirm: true to archive ${paths.length} document(s) in ${namespace}.`,
      });
      if (!finalizeRefusal.ok) return fail(finalizeRefusal.message);
      // Archiving is a rename to archive/<path>, so it goes through the same helper as
      // move and drags its edges along for the same reason.
      //
      // Each path carries its own in-batch existence guard, because the loop above
      // read each path in a separate transaction, and a partial archive would silently
      // drop documents out of the lint loop's view.
      const statements = paths.flatMap((path) => [
        requireExists(db, namespace, path),
        ...pathMutation(db, namespace, path, `archive/${path}`),
      ]);
      statements.push(auditStatement(db, actor, "lint", namespace, null, { consolidated: paths.length, consumed: paths }));
      try {
        await db.batch(statements);
      } catch (err) {
        if (isMissingRowAbort(err)) {
          return fail(
            "finalize aborted, nothing archived: one of the consumed paths no longer exists. Another session moved or removed it after this call started. Re-run gather and finalize the current set."
          );
        }
        return fail(`finalize failed, nothing archived (an archive/ target may already exist): ${err instanceof Error ? err.message : String(err)}`);
      }
      return ok({
        mode: "finalize",
        namespace,
        consolidated: paths.length,
        archived: paths.map((path) => ({ from: path, to: `archive/${path}` })),
      });
    }
  );
}
