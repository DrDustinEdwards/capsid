import { McpServer } from "@modelcontextprotocol/server";
import { readDocument } from "../doc-reads";
import { z } from "zod";
import { repoBlobPaths, resolveRepo } from "../github";
import {
  auditStatement,
  documentUpsert,
  isMissingRowAbort,
  requireExists,
  snapshotLive,
} from "../store-guards";
import { authoritativeFor, scanCountClaims } from "../counts";
import {
  buildTruthReport,
  isUnscanned,
  renderTruthReport,
  reportPath,
  type ReportDoc,
  type ReportEdge,
} from "../truth-report";
import { docPath, GATHER_BUDGET, LINT_CONSUMED_MAX, nsName } from "../limits";
import { canonGuarded, canonRefusal } from "../canon";
import { policyPathsRefusal } from "./docs-write";
import { fail, ok, pathMutation, requireConfirmation, type ToolCtx } from "./docs";

import { errorMessage } from "@dustinedwards/site-runtime/log";
const LINT_TOOL = "capsid_lint_namespace";

// Exported so test/lint-description.test.ts can check it names every report id.
export const LINT_DESCRIPTION =
  "Consolidation loop and truth report for a namespace. mode 'gather' (default, read-only) returns current core.md, the concept and decision docs, every unconsolidated episodic and source doc, and capsid/conventions.md, the rules. After writing the updated core.md and concept docs with capsid_write_doc, call mode 'finalize' with consumed: the episodic/source paths that were compiled. Finalize moves them under archive/ (never deletes, never touches core or concept docs) and writes one audit row. mode 'report' measures the store instead of compiling it. It runs eight checks and the response names each one by these ids: `contradictions` (prose asserting a number the artifact disagrees with), `stale_decisions`, `unbound_specs`, `broken_links`, `doc_vs_code_drift` (a repo path named in canon that is no longer in the repo), `unconsolidated` (the episodic and source backlog), `rule_doc_caps` (a rule document over its cap: core.md 8KB, the others 20KB) and `stale_tool_names` (a rule document naming a tool or action the Worker does not serve). It also counts documents by type and returns one integrity percentage, which excludes a check that could not run. It stores the result as <namespace>/reports/lint-<date>.md. capsid_lint_namespace reads only what the caller is scoped to, except capsid/conventions.md, which every caller gets. An edge whose other end is in an out-of-scope namespace is left out of gather and report, and report skips the repo drift check when the namespace's repo is outside the caller's repo scope. finalize and report need the write grant. finalize, and a report that would overwrite one for the same date, need confirmation: elicited when the client supports it, otherwise pass confirm: true.";

export function defineLintOperations(server: McpServer, ctx: ToolCtx): void {
  const { env, db, actor } = ctx;

  // The Worker does no reasoning: a client calls gather, synthesizes with capsid_read_doc and
  // capsid_write_doc, then finalize archives what it consumed. The report's checks are named by
  // response id so a test can derive this list.
  ctx.ops.define(
    "lint",
    {
      description: LINT_DESCRIPTION,
      inputSchema: {
        namespace: nsName,
        mode: z.enum(["gather", "finalize", "report"]).optional(),
        // D1 caps a batch at 100 statements; finalize spends four per path plus one audit row
        // (LINT_CONSUMED_MAX).
        consumed: z.array(docPath).max(LINT_CONSUMED_MAX).optional(),
        confirm: z.boolean().optional(),
      },
    },
    async ({ namespace, mode, consumed, confirm }) => {
      // gather and report also read the far end of every edge and the repo tree, so each is asked
      // of checkScope with this call's action; capsid's conventions is exempt (see the rules query
      // in gather).
      const action = mode ?? "gather";
      const reaches = (other: string) =>
        ctx.scope({ tool: LINT_TOOL, action, namespace: other }) === null;
      const withinScope = <T extends { from_ns: unknown; to_ns: unknown }>(rows: T[]) =>
        rows.filter((e) => reaches(String(e.from_ns)) && reaches(String(e.to_ns)));
      if (action === "gather") {
        // lint is an "action" tool, so the handler asks the read grant for gather, which returns
        // before the write-grant check below.
        const gatherRefusal = ctx.scope({
          tool: LINT_TOOL,
          action: "gather",
          grant: "read",
          namespace,
        });
        if (gatherRefusal) return fail(gatherRefusal);
        const core = await db
          .prepare(
            "SELECT namespace, path, title, type, status, body, updated_at FROM documents WHERE namespace = ?1 AND path = 'core.md'",
          )
          .bind(namespace)
          .first();
        const wiki = await db
          .prepare(
            `SELECT namespace, path, title, type, status, tags, body, updated_at
             FROM documents
             WHERE namespace = ?1 AND type IN ('concept', 'decision')
             ORDER BY path`,
          )
          .bind(namespace)
          .all();
        // Not filtered on status: only the archive/ prefix removes a doc, which keeps gather
        // idempotent after finalize.
        const raw = await db
          .prepare(
            `SELECT namespace, path, title, type, status, tags, body, created_at, updated_at
             FROM documents
             WHERE namespace = ?1 AND type IN ('episodic', 'source')
               AND path NOT LIKE 'archive/%'
             ORDER BY created_at`,
          )
          .bind(namespace)
          .all();
        // capsid/conventions.md is exempt from the namespace filter: it is the rules every lint
        // runs under; no other capsid document is read.
        const rules = await db
          .prepare(
            "SELECT namespace, path, title, body FROM documents WHERE namespace = 'capsid' AND path IN ('conventions.md') ORDER BY path",
          )
          .all();
        // Reported, never auto-repaired: the right fix depends on whether the target was renamed or
        // removed. An edge whose other end is in an out-of-scope namespace is dropped.
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
             ORDER BY l.from_ns, l.from_path, l.type`,
          )
          .bind(namespace)
          .all<ReportEdge>();
        // Trim order: the wiki stubs first, unconsolidated bodies last, core and rules never (they
        // are the rules of the job).
        type PacketRow = { namespace?: unknown; path?: unknown; body?: unknown };
        const bodyChars = (row: unknown) => {
          const body = (row as PacketRow | null)?.body;
          return typeof body === "string" ? body.length : 0;
        };
        const sumChars = (rows: unknown[]) =>
          rows.reduce<number>((sum, r) => sum + bodyChars(r), 0);
        const toStub = (row: unknown) => {
          const r = row as PacketRow;
          return {
            ...(row as object),
            body: `(trimmed for size: read it with capsid_read_doc, ${String(r.namespace)}/${String(r.path)})`,
          };
        };

        const trimmed: string[] = [];
        const fixed = bodyChars(core) + sumChars(rules.results);
        let wikiOut: unknown[] = wiki.results;
        if (fixed + sumChars(wiki.results) + sumChars(raw.results) > GATHER_BUDGET) {
          wikiOut = wiki.results.map(toStub);
          trimmed.push(
            `${wiki.results.length} wiki bodies (concept and decision docs; read them individually by path with capsid_read_doc)`,
          );
        }

        // Whole documents, never half a body: a truncated document is worse than an honest stub,
        // because the client cannot tell.
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
            `${heldBack} of ${raw.results.length} unconsolidated bodies (the oldest were kept, which is the compile order; finalize this batch and call gather again for the rest)`,
          );
        }
        const packetChars = fixed + sumChars(wikiOut) + sumChars(unconsolidatedOut);
        // FLAG, never correct: claims come back for a human to judge. Standing docs only;
        // episodics' numbers were right when written.
        const standing = await db
          .prepare(
            `SELECT path, type, body FROM documents
             WHERE namespace = ?1 AND path NOT LIKE 'archive/%'`,
          )
          .bind(namespace)
          .all<{ path: string; type: string | null; body: string | null }>();
        // A namespace with no authoritative numbers of its own gets no claims, rather than being
        // measured against capsid's.
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

      const modeRefusal = ctx.scope({ tool: LINT_TOOL, grant: "write", namespace });
      if (modeRefusal) return fail(modeRefusal);

      // mode "report" stores the result so the trend is a document (capsid/conventions.md); one per
      // namespace per day, a second run overwrites.
      if (mode === "report") {
        const now = new Date();
        const docs = await db
          .prepare(
            `SELECT path, type, status, title, body, updated_at FROM documents
             WHERE namespace = ?1 ORDER BY path`,
          )
          .bind(namespace)
          .all<ReportDoc>();
        const edges = await db
          .prepare(
            `SELECT from_ns, from_path, type, to_ns, to_path FROM document_links
             WHERE from_ns = ?1 OR to_ns = ?1`,
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
               AND (l.from_ns = ?1 OR l.to_ns = ?1)`,
          )
          .bind(namespace)
          .all<ReportEdge>();
        // `isUnscanned` is the one statement of which prefixes are standing, so the scanner and
        // report cannot disagree.
        const claims = scanCountClaims(
          docs.results
            .filter((d) => !isUnscanned(d.path))
            .map((d) => ({ path: d.path, type: d.type, body: d.body })),
          namespace,
        );
        // Undefined, not an empty set, when the tree is unreadable or out of scope: an empty set
        // would report every canon path as drift.
        let repoPaths: Set<string> | undefined;
        try {
          const { full } = await resolveRepo(env, namespace);
          if (ctx.scope({ tool: LINT_TOOL, action, namespace, repo: full }) === null) {
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
          countClaims: claims.map((c) => ({
            path: c.path,
            noun: c.noun,
            states: c.states,
            authoritative: c.authoritative,
            quote: c.quote,
          })),
          repoPaths,
        });
        const path = reportPath(now);
        const body = renderTruthReport(report);
        const prior = await readDocument(db, namespace, path);
        const title = `Truth report - ${namespace} - ${path.slice("reports/lint-".length, -3)}`;
        // Same confirmation as capsid_write_doc: a second report the same date overwrites the
        // first, and without asking the response never mentions the replacement.
        if (prior) {
          const overwrite = await requireConfirmation(server, confirm, {
            prompt: `Overwrite the truth report at ${namespace}/${path}? The current version will be snapshotted to document_versions first.`,
            declined: `report for ${namespace}/${path} declined; nothing was written`,
            unsupported: `confirmation required: ${namespace}/${path} already exists. Re-run capsid_lint_namespace mode report with confirm: true to overwrite it. The current version will be snapshotted to document_versions first.`,
          });
          if (!overwrite.ok) return fail(overwrite.message);
        }
        const statements = [];
        if (prior) {
          statements.push(snapshotLive(db, namespace, path));
        }
        statements.push(
          documentUpsert(db, namespace, path, title, body, "reference", null, "published"),
        );
        statements.push(
          auditStatement(db, actor, "lint_report", namespace, path, {
            integrity: report.integrity,
            findings: report.findings.length,
          }),
        );
        await db.batch(statements);
        return ok({ mode: "report", stored: `${namespace}/${path}`, ...report });
      }

      const paths = [...new Set(consumed ?? [])];
      if (paths.length === 0) {
        return fail(
          "finalize requires consumed: the episodic/source paths that were compiled into the wiki",
        );
      }
      const problems: string[] = [];
      for (const path of paths) {
        const row = await db
          .prepare("SELECT type FROM documents WHERE namespace = ?1 AND path = ?2")
          .bind(namespace, path)
          .first<{ type: string | null }>();
        if (!row) problems.push(`not found: ${namespace}/${path}`);
        else if (path.startsWith("archive/"))
          problems.push(`already archived: ${namespace}/${path}`);
        else if (row.type !== "episodic" && row.type !== "source") {
          problems.push(
            `not consumable: ${namespace}/${path} has type '${row.type}' (only episodic and source docs are archived)`,
          );
        }
      }
      if (problems.length > 0)
        return fail(`finalize aborted, nothing archived:\n${problems.join("\n")}`);
      // Archiving is a move: it asks what move asks (docs-lifecycle.ts), since a canon or policy
      // document can carry an archivable type.
      for (const consumedPath of paths) {
        for (const end of [consumedPath, `archive/${consumedPath}`]) {
          if (canonGuarded(ctx.agent, namespace, end))
            return fail(
              `finalize aborted, nothing archived:\n${canonRefusal("move", namespace, end)}`,
            );
        }
      }
      const policyRefusal = policyPathsRefusal(ctx, "move", namespace, false, paths);
      if (policyRefusal) return fail(`finalize aborted, nothing archived:\n${policyRefusal}`);
      const finalizeRefusal = await requireConfirmation(server, confirm, {
        prompt: `Archive ${paths.length} document(s) in ${namespace} by moving them under archive/?`,
        declined: `finalize of ${namespace} declined`,
        unsupported: `confirmation required: re-run capsid_lint_namespace mode finalize with confirm: true to archive ${paths.length} document(s) in ${namespace}.`,
      });
      if (!finalizeRefusal.ok) return fail(finalizeRefusal.message);
      // Each path carries its own in-batch existence guard: the loop above read each in a separate
      // transaction, and a partial archive would silently drop documents from the lint loop's view.
      const statements = paths.flatMap((path) => [
        requireExists(db, namespace, path),
        ...pathMutation(db, namespace, path, `archive/${path}`),
      ]);
      statements.push(
        auditStatement(db, actor, "lint", namespace, null, {
          consolidated: paths.length,
          consumed: paths,
        }),
      );
      try {
        await db.batch(statements);
      } catch (err) {
        if (isMissingRowAbort(err)) {
          return fail(
            "finalize aborted, nothing archived: one of the consumed paths no longer exists. Another session moved or removed it after this call started. Re-run gather and finalize the current set.",
          );
        }
        return fail(
          `finalize failed, nothing archived (an archive/ target may already exist): ${errorMessage(err)}`,
        );
      }
      return ok({
        mode: "finalize",
        namespace,
        consolidated: paths.length,
        archived: paths.map((path) => ({ from: path, to: `archive/${path}` })),
      });
    },
  );
}
