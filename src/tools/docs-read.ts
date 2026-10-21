import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { bounded, BRIEF_BUDGET, HISTORY_ROWS, MAX_DOC_STATUS, MAX_DOC_TYPE, MAX_GLOB, MAX_QUERY, MAX_ROWS, nsName, SEARCH_ROWS, docPath } from "../limits";
import { ok, fail, type ToolCtx } from "./docs";
import { surfaceOf } from "./surface";
import { isConventionsDoc, recordConventionsRead } from "../conventions-read";
import { describePortfolioDocs, isPortfolioPath, PORTFOLIO_DOCS, portfolioDocuments } from "../portfolio-docs";
import { portfolioOnly } from "../scope";
import { documentEdges, readDocument, searchDocuments } from "../doc-reads";
import { hybridSearch } from "../doc-index";

// The document tools that only read: list, read, brief, history, backlinks, find
// and search. defineDocOperations in ./docs registers them in the published order.

// Ask for one extra row so "exactly limit" is distinguishable from "there are more".
function boundedRows<T>(rows: T[], limit: number, advice: string) {
  const truncated = rows.length > limit;
  const kept = truncated ? rows.slice(0, limit) : rows;
  return {
    count: kept.length,
    limit,
    truncated,
    ...(truncated ? { note: `Returned the first ${limit} rows; there are more. ${advice}` } : {}),
    documents: kept,
  };
}

export function defineListOperation(server: McpServer, ctx: ToolCtx): void {
  const { db, agent } = ctx;

  ctx.ops.define(
    "list",
    {
      description: `List documents with optional namespace, type, and status filters. Returns metadata rows without bodies under \`documents\`: id, namespace, path, title, type, status, tags and timestamps. Bounded to ${MAX_ROWS} rows; when there are more it sets truncated:true with a note.`,
      inputSchema: {
        namespace: nsName.optional(),
        type: bounded(MAX_DOC_TYPE).optional(),
        status: bounded(MAX_DOC_STATUS).optional(),
      },
    },
    async ({ namespace, type, status }) => {
      // A caller outside capsid sees the portfolio documents there and nothing else
      // (src/portfolio-docs.ts). The set is small, so it is read whole and filtered here.
      if (portfolioOnly(agent, namespace)) {
        const rows = (await portfolioDocuments(db)).filter((r) => (type == null || r.type === type) && (status == null || r.status === status));
        return ok(boundedRows(rows, MAX_ROWS, "Narrow with type or status."));
      }
      const { results } = await db
        .prepare(
          // frontmatter and publish_at are not selected: nothing in this server reads
          // or writes them. They stay in the table, because dropping a column means a
          // migration, a rebuild of the FTS triggers and a change to the backup table
          // guard, to reclaim nothing.
          `SELECT id, namespace, path, title, type, status, tags, created_at, updated_at
           FROM documents
           WHERE (?1 IS NULL OR namespace = ?1) AND (?2 IS NULL OR type = ?2) AND (?3 IS NULL OR status = ?3)
           ORDER BY namespace, path
           LIMIT ?4`
        )
        .bind(namespace ?? null, type ?? null, status ?? null, MAX_ROWS + 1)
        .all();
      return ok(
        boundedRows(
          results,
          MAX_ROWS,
          namespace
            ? "Narrow with type or status, or use capsid_find_docs action glob with a path glob."
            : "Narrow with namespace (the usual case), type or status, or use capsid_find_docs action glob with a path glob."
        )
      );
    }
  );
}

export function defineReadOperation(server: McpServer, ctx: ToolCtx): void {
  const { db, actor, lastActor } = ctx;

  ctx.ops.define(
    "read",
    {
      description:
        "Read a full document by namespace and path. The response carries last_actor, the actor of the most recent audit_log entry for this document, or null when there is none.",
      inputSchema: { namespace: nsName, path: docPath },
    },
    async ({ namespace, path }) => {
      const row = await readDocument(db, namespace, path);
      if (!row) return fail(`not found: ${namespace}/${path}`);
      // Read first: the row recorded below is not addressed to this document, so it
      // cannot change last_actor, but the order keeps that from depending on it.
      const lastWriter = await lastActor(namespace, path);
      if (isConventionsDoc(namespace, path)) await recordConventionsRead(db, actor, "read", namespace);
      return ok({ ...row, last_actor: lastWriter });
    }
  );
}

export function defineBriefOperation(server: McpServer, ctx: ToolCtx): void {
  const { db, actor } = ctx;

  // One-call session start: assembles the read ritual so a session cannot skip a
  // piece of it. Pure assembly, no reasoning. Size-bounded so it stays loadable;
  // when trimmed it says so.
  ctx.ops.define(
    "brief",
    {
      description:
        `One-call session start for a namespace. Returns capsid/conventions.md, the namespace core.md, \`portfolio_documents\` (the capsid paths every driver reads first and may read: conventions, decisions and its volumes, rulings, core), its open task docs (non-archived and not status closed), the 3 most recent episodics, and the typed edges on core.md, each with updated_at so staleness shows. Read-only. Size-bounded near ${Math.round(BRIEF_BUDGET / 1000)}KB; if trimmed, the \`trimmed\` field lists what was dropped to metadata. When conventions and core.md alone exceed the budget nothing is trimmed and \`floor_exceeds_budget\` carries their sizes.`,
      inputSchema: { namespace: nsName },
    },
    async ({ namespace }) => {
      const doc = (ns: string, path: string) =>
        db
          .prepare("SELECT namespace, path, title, type, body, updated_at FROM documents WHERE namespace = ?1 AND path = ?2")
          .bind(ns, path)
          .first<{ namespace: string; path: string; title: string | null; type: string | null; body: string | null; updated_at: string }>();
      const [conventions, core, portfolio] = await Promise.all([
        doc("capsid", "conventions.md"),
        doc(namespace, "core.md"),
        portfolioDocuments(db),
      ]);
      // Not filtered on status (beyond 'closed' below): status records editorial
      // state and does not mark a task done, so filtering on 'published' would hide
      // most open task docs. archive/ is the only other exclusion.
      //
      // The four remaining reads run together: none depends on another's result.
      const [openTasksResult, recentEpisodicsResult, coreOutResult, coreInResult] = await Promise.all([
        db
          .prepare(
            // The closure predicate below is the only status filter in this query.
            // It excludes exactly one value, set deliberately to mean finished.
            // status is NOT NULL, so the comparison cannot swallow a row via NULL.
            //
            // test/doc-meta.test.ts asserts this predicate appears exactly once in
            // this file, so the lint loop can never grow one. Only the archive/
            // prefix takes a document out of memory.
            "SELECT namespace, path, title, type, body, updated_at FROM documents WHERE namespace = ?1 AND type = 'task' AND status != 'closed' AND path NOT LIKE 'archive/%' ORDER BY updated_at DESC"
          )
          .bind(namespace)
          .all<{ namespace: string; path: string; title: string | null; type: string | null; body: string | null; updated_at: string }>(),
        db
          .prepare(
            "SELECT namespace, path, title, type, body, updated_at FROM documents WHERE namespace = ?1 AND type = 'episodic' AND path NOT LIKE 'archive/%' ORDER BY created_at DESC LIMIT 3"
          )
          .bind(namespace)
          .all<{ namespace: string; path: string; title: string | null; type: string | null; body: string | null; updated_at: string }>(),
        db
          .prepare("SELECT type, to_ns, to_path FROM document_links WHERE from_ns = ?1 AND from_path = 'core.md' ORDER BY type, to_ns, to_path")
          .bind(namespace)
          .all(),
        db
          .prepare("SELECT type, from_ns, from_path FROM document_links WHERE to_ns = ?1 AND to_path = 'core.md' ORDER BY type, from_ns, from_path")
          .bind(namespace)
          .all(),
      ]);
      if (conventions) await recordConventionsRead(db, actor, "brief", namespace);
      const openTasks = openTasksResult.results;
      const recentEpisodics = recentEpisodicsResult.results;
      const coreOut = coreOutResult.results;
      const coreIn = coreInResult.results;

      // Provenance on every document in the packet: a poisoned task or core.md is
      // instructions at turn 0, and last_actor is how a session tells the operator's
      // own writing from another client's. Attached after the reads so each documents
      // SELECT stays a plain projection.
      //
      // One query for all of them. The pairs travel as one JSON parameter because D1
      // caps a statement at 100 bound parameters and the open-task list has no cap.
      // The correlated subquery is the lastActor query per pair, so it uses
      // audit_log_doc.
      type Keyed = { namespace: string; path: string };
      type Actored<T> = T & { last_actor: string | null };
      const present = [conventions, core, ...openTasks, ...recentEpisodics].filter((r): r is NonNullable<typeof r> => r !== null);
      const actors = new Map<string, string | null>();
      if (present.length) {
        // A plain SELECT rather than a CTE, and no comment inside prepare(), so
        // test-integration/query-plans.test.ts, which walks SELECT statements written
        // directly as prepare()'s argument, checks this plan too.
        const { results } = await db
          .prepare(
            `SELECT json_extract(w.value, '$[0]') AS ns, json_extract(w.value, '$[1]') AS path,
               (SELECT actor FROM audit_log
                WHERE namespace = json_extract(w.value, '$[0]') AND path = json_extract(w.value, '$[1]')
                ORDER BY id DESC LIMIT 1) AS actor
             FROM json_each(?1) AS w`
          )
          .bind(JSON.stringify(present.map((r) => [r.namespace, r.path])))
          .all<{ ns: string; path: string; actor: string | null }>();
        for (const row of results) actors.set(JSON.stringify([row.ns, row.path]), row.actor ?? null);
      }
      const withActor = <T extends Keyed>(row: T | null): Actored<T> | null =>
        row ? { ...row, last_actor: actors.get(JSON.stringify([row.namespace, row.path])) ?? null } : null;
      const withActors = <T extends Keyed>(rows: T[]): Actored<T>[] => rows.map((r) => withActor(r) as Actored<T>);
      const conventionsA = withActor(conventions);
      const coreA = withActor(core);
      const openTasksA = withActors(openTasks);
      const recentEpisodicsA = withActors(recentEpisodics);

      // Stay under budget by trimming the largest, most re-readable sections to
      // metadata first (episodics, then task bodies), and report what was cut.
      //
      // Only a cut that happened is reported. Nothing is cut when the two documents
      // that are never trimmed exceed the budget by themselves, since trimming the
      // rest cannot bring the packet under it; that is reported as
      // floor_exceeds_budget with the sizes.
      type Row = { namespace: string; path: string; title: string | null; body: string | null; updated_at: string; last_actor?: string | null };
      const bodyChars = (rows: Row[]) => rows.reduce((sum, r) => sum + (r.body?.length ?? 0), 0);
      const toStub = (rows: Row[]) =>
        rows.map((r) => ({ namespace: r.namespace, path: r.path, title: r.title, updated_at: r.updated_at, last_actor: r.last_actor ?? null, body: `(trimmed for size: read it with capsid_read_doc, ${r.namespace}/${r.path})` }));
      const sizes = {
        conventions: conventionsA?.body?.length ?? 0,
        core: coreA?.body?.length ?? 0,
      };
      const floorChars = sizes.conventions + sizes.core;
      const floorOver = floorChars > BRIEF_BUDGET;
      const trimmed: string[] = [];
      let total = floorChars + bodyChars(openTasksA as Row[]) + bodyChars(recentEpisodicsA as Row[]);
      let episodicsOut: unknown[] = recentEpisodicsA;
      let tasksOut: unknown[] = openTasksA;
      if (!floorOver && total > BRIEF_BUDGET && bodyChars(recentEpisodicsA as Row[]) > 0) {
        total -= bodyChars(recentEpisodicsA as Row[]);
        episodicsOut = toStub(recentEpisodicsA as Row[]);
        trimmed.push(`${recentEpisodicsA.length} episodic bodies`);
      }
      if (!floorOver && total > BRIEF_BUDGET && bodyChars(openTasksA as Row[]) > 0) {
        total -= bodyChars(openTasksA as Row[]);
        tasksOut = toStub(openTasksA as Row[]);
        trimmed.push(`${openTasksA.length} task bodies`);
      }

      return ok({
        namespace,
        conventions: conventionsA,
        core: coreA,
        open_tasks: tasksOut,
        recent_episodics: episodicsOut,
        core_links: { outgoing: coreOut, incoming: coreIn },
        // The portfolio rules, by path, for every namespace: a session reads these first.
        // Every namespace driver may read them in capsid and nothing else there.
        portfolio_documents: {
          namespace: PORTFOLIO_DOCS.namespace,
          read_first: portfolio.map((r) => r.path),
          allowlist: describePortfolioDocs(),
          note: `Read each with capsid_read_doc(namespace: "${PORTFOLIO_DOCS.namespace}", path). Any namespace driver may read these, and nothing else in ${PORTFOLIO_DOCS.namespace}.`,
        },
        approx_chars: total,
        ...(coreA ? {} : { warning: `no core.md for namespace ${namespace}` }),
        ...(trimmed.length ? { trimmed } : {}),
        ...(floorOver ? { floor_exceeds_budget: { ...sizes, floor: floorChars, budget: BRIEF_BUDGET } } : {}),
      });
    }
  );
}

export function defineHistoryOperation(server: McpServer, ctx: ToolCtx): void {
  const { db } = ctx;

  ctx.ops.define(
    "history",
    {
      description:
        "List the retained versions of a document (newest first) from document_versions, or fetch one body by passing version_id. Every overwrite and delete writes a snapshot, so a deleted document's history is readable. Retention is 90 days. Read-only. A version records title and body only; changes to type, status or tags are in the audit log.",
      inputSchema: { namespace: nsName, path: docPath, version_id: z.number().int().positive().optional() },
    },
    async ({ namespace, path, version_id }) => {
      if (version_id !== undefined) {
        const row = await db
          .prepare(
            "SELECT id, document_id, namespace, path, title, body, snapshot_at FROM document_versions WHERE id = ?1 AND namespace = ?2 AND path = ?3"
          )
          .bind(version_id, namespace, path)
          .first<{ id: number; body: string | null }>();
        // namespace and path are part of the lookup on purpose: an id alone would let
        // a caller walk every snapshot in the store by incrementing a number.
        if (!row) return fail(`no version ${version_id} for ${namespace}/${path}`);
        return ok({ ...row, bytes: new TextEncoder().encode(row.body ?? "").length });
      }
      const { results } = await db
        .prepare(
          // Bounded: retention is 90 days, so HISTORY_ROWS covers more than a
          // snapshot a day.
          `SELECT id, snapshot_at, title, LENGTH(body) AS bytes
           FROM document_versions
           WHERE namespace = ?1 AND path = ?2
           ORDER BY snapshot_at DESC, id DESC
           LIMIT ?3`
        )
        .bind(namespace, path, HISTORY_ROWS)
        .all();
      const live = await db
        .prepare("SELECT title, updated_at, LENGTH(body) AS bytes FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first();
      return ok({
        namespace,
        path,
        live: live ?? null,
        versions: results,
        ...(live ? {} : { note: "no live document at this path: these are the snapshots of a deleted or moved document" }),
      });
    }
  );
}

export function defineBacklinksOperation(server: McpServer, ctx: ToolCtx): void {
  const { db } = ctx;

  ctx.ops.define(
    "backlinks",
    {
      description:
        "Return the typed edges touching a document: outgoing (declared on this doc) and incoming (other docs pointing here). Edges are set by capsid_write_doc's links param. Endpoints may be Capsid documents or repo files addressed as namespace/path. Read-only.",
      inputSchema: { namespace: nsName, path: docPath },
    },
    async ({ namespace, path }) => {
      const { outgoing, incoming } = await documentEdges(db, namespace, path);
      // An incoming edge names a document in another namespace, so it is kept only when
      // the caller may read that document, asked through checkScope (Grok audit 2026-10, A2).
      const readable = incoming.filter((e) => ctx.scope({ ...surfaceOf("backlinks"), grant: "read", namespace: e.from_ns, path: e.from_path }) === null);
      return ok({ namespace, path, outgoing, incoming: readable });
    }
  );
}

export function defineFindOperation(server: McpServer, ctx: ToolCtx): void {
  const { db, agent } = ctx;

  ctx.ops.define(
    "find",
    {
      description: `Find documents whose path matches a glob pattern (SQLite GLOB, e.g. 'notes/*.md'). Optional namespace filter. Returns matches under \`documents\`, bounded to ${MAX_ROWS} rows; when there are more it sets truncated:true with a note.`,
      inputSchema: { namespace: nsName.optional(), glob: bounded(MAX_GLOB) },
    },
    async ({ namespace, glob }) => {
      const { results } = await db
        .prepare(
          `SELECT namespace, path, title, type, status, updated_at
           FROM documents
           WHERE path GLOB ?1 AND (?2 IS NULL OR namespace = ?2)
           ORDER BY namespace, path
           LIMIT ?3`
        )
        .bind(glob, namespace ?? null, MAX_ROWS + 1)
        .all<{ path: string }>();
      // A caller outside capsid keeps only the portfolio documents (src/portfolio-docs.ts).
      const kept = portfolioOnly(agent, namespace) ? results.filter((r) => isPortfolioPath(r.path)) : results;
      return ok(boundedRows(kept, MAX_ROWS, "Tighten the glob, or add a namespace filter."));
    }
  );
}

export function defineSearchOperation(server: McpServer, ctx: ToolCtx): void {
  const { db, agent } = ctx;

  ctx.ops.define(
    "search",
    {
      description: `Full text search across all documents (FTS5, ranked by bm25). Optional namespace and type filters. This is the cross-project search. Returns the top ${SEARCH_ROWS} matches under \`documents\`; when more matched it sets truncated:true. mode "hybrid" matches by meaning as well as by keyword, for a question phrased in other words than the document uses; each row says how it matched (\`match\`: keyword, meaning or both), closed and superseded documents are left out unless include_retired is true, and current canon ranks first. When the meaning index cannot answer, it falls back to the keyword search and says why under \`fallback\`.`,
      inputSchema: {
        query: bounded(MAX_QUERY),
        namespace: nsName.optional(),
        type: bounded(MAX_DOC_TYPE).optional(),
        mode: z.enum(["keyword", "hybrid"]).optional(),
        include_retired: z.boolean().optional(),
      },
    },
    async ({ query, namespace, type, mode, include_retired }) => {
      // A caller outside capsid searches the portfolio documents there and nothing else
      // (src/portfolio-docs.ts): the query is narrowed to the paths that exist, so the
      // page is not spent on rows that would be dropped, and every row is checked again
      // below, so the narrowing is never what keeps another document out.
      const restricted = portfolioOnly(agent, namespace);
      const allowed = restricted ? JSON.stringify((await portfolioDocuments(db)).map((r) => r.path)) : null;
      const bound = (rows: Array<{ path: string }>) =>
        boundedRows(
          restricted ? rows.filter((r) => isPortfolioPath(r.path)) : rows,
          SEARCH_ROWS,
          "Add a namespace or type filter, or make the query more specific."
        );
      const filter = { namespace: namespace ?? null, type: type ?? null, allowed };
      let fallback: string | undefined;
      if (mode === "hybrid") {
        const hybrid = await hybridSearch(ctx.env, query, { ...filter, includeRetired: include_retired === true });
        if (typeof hybrid !== "string") return ok({ mode: "hybrid", ...bound(hybrid) });
        fallback = hybrid;
      }
      try {
        const rows = bound(await searchDocuments(db, query, filter));
        return ok(fallback === undefined ? rows : { mode: "keyword", fallback, ...rows });
      } catch (err) {
        return fail(`search failed (check FTS5 query syntax): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );
}
