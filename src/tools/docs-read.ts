import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hintsFor } from "../tool-annotations";
import { z } from "zod";
import { bounded, BRIEF_BUDGET, HISTORY_ROWS, MAX_DOC_STATUS, MAX_DOC_TYPE, MAX_GLOB, MAX_QUERY, MAX_ROWS, nsName, SEARCH_ROWS, docPath } from "../limits";
import { ok, fail, type ToolCtx } from "./docs";

// The document tools that only read: list, read, brief, history, backlinks, find
// and search. registerDocTools in ./docs registers them in the published order.

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

export function registerListTool(server: McpServer, ctx: ToolCtx): void {
  const { db } = ctx;

  server.registerTool(
    "list",
    {
      annotations: hintsFor("list"),
      description: `List documents with optional namespace, type, and status filters. Returns metadata rows without bodies under \`documents\`: id, namespace, path, title, type, status, tags and timestamps. Bounded to ${MAX_ROWS} rows; when there are more it sets truncated:true with a note.`,
      inputSchema: {
        namespace: nsName.optional(),
        type: bounded(MAX_DOC_TYPE).optional(),
        status: bounded(MAX_DOC_STATUS).optional(),
      },
    },
    async ({ namespace, type, status }) => {
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
            ? "Narrow with type or status, or use find with a path glob."
            : "Narrow with namespace (the usual case), type or status, or use find with a path glob."
        )
      );
    }
  );
}

export function registerReadTool(server: McpServer, ctx: ToolCtx): void {
  const { db, actor, lastActor } = ctx;

  server.registerTool(
    "read",
    {
      annotations: hintsFor("read"),
      description:
        "Read a full document by namespace and path. The response carries last_actor, the actor of the most recent audit_log entry for this document, or null when there is none.",
      inputSchema: { namespace: nsName, path: docPath },
    },
    async ({ namespace, path }) => {
      // Named columns: the set `list` returns plus the body. See `list` for why
      // frontmatter and publish_at are left out.
      const row = await db
        .prepare(
          `SELECT id, namespace, path, title, type, status, tags, created_at, updated_at, body
           FROM documents WHERE namespace = ?1 AND path = ?2`
        )
        .bind(namespace, path)
        .first();
      if (!row) return fail(`not found: ${namespace}/${path}`);
      return ok({ ...row, last_actor: await lastActor(namespace, path) });
    }
  );
}

export function registerBriefTool(server: McpServer, ctx: ToolCtx): void {
  const { db, actor, lastActor } = ctx;

  // One-call session start: assembles the read ritual so a session cannot skip a
  // piece of it. Pure assembly, no reasoning. Size-bounded so it stays loadable;
  // when trimmed it says so.
  server.registerTool(
    "brief",
    {
      annotations: hintsFor("brief"),
      description:
        `One-call session start for a namespace. Returns capsid/conventions.md, capsid/repo-structure.md, the namespace core.md, its open task docs (non-archived and not status closed), the 3 most recent episodics, and the typed edges on core.md, each with updated_at so staleness shows. Read-only. Size-bounded near ${Math.round(BRIEF_BUDGET / 1000)}KB; if trimmed, the \`trimmed\` field lists what was dropped to metadata. When conventions, repo-structure and core.md alone exceed the budget nothing is trimmed and \`floor_exceeds_budget\` carries their sizes.`,
      inputSchema: { namespace: nsName },
    },
    async ({ namespace }) => {
      const doc = (ns: string, path: string) =>
        db
          .prepare("SELECT namespace, path, title, type, body, updated_at FROM documents WHERE namespace = ?1 AND path = ?2")
          .bind(ns, path)
          .first<{ namespace: string; path: string; title: string | null; type: string | null; body: string | null; updated_at: string }>();
      const [conventions, repoStructure, core] = await Promise.all([
        doc("capsid", "conventions.md"),
        doc("capsid", "repo-structure.md"),
        doc(namespace, "core.md"),
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
      const present = [conventions, repoStructure, core, ...openTasks, ...recentEpisodics].filter((r): r is NonNullable<typeof r> => r !== null);
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
      const repoStructureA = withActor(repoStructure);
      const coreA = withActor(core);
      const openTasksA = withActors(openTasks);
      const recentEpisodicsA = withActors(recentEpisodics);

      // Stay under budget by trimming the largest, most re-readable sections to
      // metadata first (episodics, then task bodies), and report what was cut.
      //
      // Only a cut that happened is reported. Nothing is cut when the three documents
      // that are never trimmed exceed the budget by themselves, since trimming the
      // rest cannot bring the packet under it; that is reported as
      // floor_exceeds_budget with the sizes.
      type Row = { namespace: string; path: string; title: string | null; body: string | null; updated_at: string; last_actor?: string | null };
      const bodyChars = (rows: Row[]) => rows.reduce((sum, r) => sum + (r.body?.length ?? 0), 0);
      const toStub = (rows: Row[]) =>
        rows.map((r) => ({ namespace: r.namespace, path: r.path, title: r.title, updated_at: r.updated_at, last_actor: r.last_actor ?? null, body: `(trimmed for size: read ${r.namespace}/${r.path})` }));
      const sizes = {
        conventions: conventionsA?.body?.length ?? 0,
        repo_structure: repoStructureA?.body?.length ?? 0,
        core: coreA?.body?.length ?? 0,
      };
      const floorChars = sizes.conventions + sizes.repo_structure + sizes.core;
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
        repo_structure: repoStructureA,
        core: coreA,
        open_tasks: tasksOut,
        recent_episodics: episodicsOut,
        core_links: { outgoing: coreOut, incoming: coreIn },
        approx_chars: total,
        ...(coreA ? {} : { warning: `no core.md for namespace ${namespace}` }),
        ...(trimmed.length ? { trimmed } : {}),
        ...(floorOver ? { floor_exceeds_budget: { ...sizes, floor: floorChars, budget: BRIEF_BUDGET } } : {}),
      });
    }
  );
}

export function registerHistoryTool(server: McpServer, ctx: ToolCtx): void {
  const { db } = ctx;

  server.registerTool(
    "history",
    {
      annotations: hintsFor("history"),
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

export function registerBacklinksTool(server: McpServer, ctx: ToolCtx): void {
  const { db } = ctx;

  server.registerTool(
    "backlinks",
    {
      annotations: hintsFor("backlinks"),
      description:
        "Return the typed edges touching a document: outgoing (declared on this doc) and incoming (other docs pointing here). Edges are set by the write tool's links param. Endpoints may be Capsid documents or repo files addressed as namespace/path. Read-only.",
      inputSchema: { namespace: nsName, path: docPath },
    },
    async ({ namespace, path }) => {
      const outgoing = await db
        .prepare(
          "SELECT type, to_ns, to_path FROM document_links WHERE from_ns = ?1 AND from_path = ?2 ORDER BY type, to_ns, to_path"
        )
        .bind(namespace, path)
        .all();
      const incoming = await db
        .prepare(
          "SELECT type, from_ns, from_path FROM document_links WHERE to_ns = ?1 AND to_path = ?2 ORDER BY type, from_ns, from_path"
        )
        .bind(namespace, path)
        .all();
      return ok({ namespace, path, outgoing: outgoing.results, incoming: incoming.results });
    }
  );
}

export function registerFindTool(server: McpServer, ctx: ToolCtx): void {
  const { db } = ctx;

  server.registerTool(
    "find",
    {
      annotations: hintsFor("find"),
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
        .all();
      return ok(boundedRows(results, MAX_ROWS, "Tighten the glob, or add a namespace filter."));
    }
  );
}

export function registerSearchTool(server: McpServer, ctx: ToolCtx): void {
  const { db } = ctx;

  server.registerTool(
    "search",
    {
      annotations: hintsFor("search"),
      description: `Full text search across all documents (FTS5, ranked by bm25). Optional namespace and type filters. This is the cross-project search. Returns the top ${SEARCH_ROWS} matches under \`documents\`; when more matched it sets truncated:true.`,
      inputSchema: {
        query: bounded(MAX_QUERY),
        namespace: nsName.optional(),
        type: bounded(MAX_DOC_TYPE).optional(),
      },
    },
    async ({ query, namespace, type }) => {
      const run = (match: string) =>
        db
          .prepare(
            `SELECT d.id, d.namespace, d.path, d.title, d.type, d.status, d.updated_at,
                    snippet(documents_fts, 1, '[', ']', ' ... ', 16) AS snippet
             FROM documents_fts
             JOIN documents d ON d.id = documents_fts.rowid
             WHERE documents_fts MATCH ?1
               AND (?2 IS NULL OR d.namespace = ?2)
               AND (?3 IS NULL OR d.type = ?3)
             ORDER BY bm25(documents_fts)
             LIMIT ?4`
          )
          .bind(match, namespace ?? null, type ?? null, SEARCH_ROWS + 1)
          .all();
      const bound = (rows: unknown[]) =>
        boundedRows(rows, SEARCH_ROWS, "Add a namespace or type filter, or make the query more specific.");
      try {
        return ok(bound((await run(query)).results));
      } catch {
        // Hyphens, quotes, and bare AND/OR/NOT are FTS5 syntax. Retry the whole query
        // as a quoted phrase so plain text is always a safe input.
        try {
          return ok(bound((await run(`"${query.replace(/"/g, '""')}"`)).results));
        } catch (err) {
          return fail(`search failed (check FTS5 query syntax): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  );
}
