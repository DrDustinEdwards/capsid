import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, ListResourcesRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Agent } from "./agents";
import { checkScope } from "./scope";
import { b64urlDecode, b64urlEncode } from "./encoding";
import { MAX_ROWS } from "./limits";

// Scopes for resources and prompts. guardRegistrations wraps registerTool only, and
// a raw request handler is not a registration, so these handlers check scope here.
// Without it, an agent bearer on /ops/mcp could read every document by URI and list
// every prompt while the `read` tool refused it.
// They are checked as the `read` tool, so an agent narrowed away from `read` loses
// both and the two surfaces cannot disagree.
export function resourceRefusal(agent: Agent, namespace: string): string | null {
  return checkScope(agent, { tool: "read", grant: "read", namespace });
}

// A listing filters rather than refusing, which would leak that there is more.
export function namespaceFilter<T extends { namespace: string }>(agent: Agent, rows: T[]): T[] {
  const visibleNamespaces = agent.scopes.namespaces;
  return visibleNamespaces === "*" ? rows : rows.filter((row) => visibleNamespaces.includes(row.namespace));
}

// Stated once, used by the read registration and the list handler below. It spreads
// onto every listed resource, so keep it to fields true of every document.
const RESOURCE_METADATA = { title: "Capsid documents", mimeType: "text/markdown" };

export function registerDocumentResources(server: McpServer, agent: Agent, db: D1Database): void {
  const visibleNamespaces = agent.scopes.namespaces;

  // Resources: every document is addressable context at capsid://<namespace>/<path>.
  // Read-only, same visibility as the read tool.
  server.registerResource(
    "document",
    new ResourceTemplate("capsid://{namespace}/{+path}", {
      // Listing is served by the raw handler below: McpServer discards _meta and
      // nextCursor from a list callback, so a callback cannot say it was truncated,
      // and capping it here would make document 501 unreachable with nothing in the
      // response admitting it.
      list: undefined,
    }),
    RESOURCE_METADATA,
    async (uri, variables) => {
      const namespace = String(variables.namespace);
      const path = String(variables.path);
      const refusal = resourceRefusal(agent, namespace);
      if (refusal) throw new McpError(ErrorCode.InvalidParams, refusal);
      const row = await db
        .prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ body: string | null }>();
      if (!row) throw new McpError(ErrorCode.InvalidParams, `not found: ${uri.href}`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: row.body ?? "" }] };
    }
  );

  // resources/list, served directly because the request carries the cursor and the
  // McpServer wrapper does not pass it through.
  //
  // Keyset pagination compared as a tuple: a concatenated key would skip rows ('-'
  // sorts below '/').
  //
  // This overrides McpServer's handler, which is safe only while every resource is
  // served by the one template above. test/bounded-reads.test.ts pins that.
  server.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    // The grant, before the query.
    if (visibleNamespaces !== "*" && visibleNamespaces.length === 0) return { resources: [] };
    if (!agent.scopes.grants.includes("read")) {
      throw new McpError(ErrorCode.InvalidParams, `unauthorized: ${agent.actor} holds no read grant, so it lists no resources.`);
    }
    const cursor = request.params?.cursor;
    let afterNs = "";
    let afterPath = "";
    if (typeof cursor === "string" && cursor.length > 0) {
      try {
        const parsed = JSON.parse(b64urlDecode(cursor)) as { n?: unknown; p?: unknown };
        afterNs = String(parsed.n ?? "");
        afterPath = String(parsed.p ?? "");
      } catch {
        throw new McpError(ErrorCode.InvalidParams, "invalid resources/list cursor; omit it to start from the beginning");
      }
    }
    // Filtered in the query, so the LIMIT bounds what this caller can see rather than
    // what the store holds. A filter after the LIMIT gives a caller scoped to a
    // namespace that sorts late a page of rows it may not see, an empty page after
    // filtering and no cursor, so its own documents are unreachable. The keyset
    // cursor names the last row returned, which keeps the walk correct.
    //
    // One bound parameter rather than a spliced clause, so the statement text is fixed
    // and test-integration/query-plans.test.ts can plan it. Null is the unscoped caller.
    const visible = visibleNamespaces === "*" ? null : JSON.stringify(visibleNamespaces);
    const { results } = await db
      .prepare(
        `SELECT namespace, path, title FROM documents
         WHERE ((?1 = '' AND ?2 = '') OR (namespace > ?1 OR (namespace = ?1 AND path > ?2)))
           AND (?4 IS NULL OR namespace IN (SELECT value FROM json_each(?4)))
         ORDER BY namespace, path
         LIMIT ?3`
      )
      .bind(afterNs, afterPath, MAX_ROWS + 1, visible)
      .all<{ namespace: string; path: string; title: string | null }>();
    // A no-op second pass that still holds if an edit loses the predicate.
    const scoped = namespaceFilter(agent, results);
    const more = scoped.length > MAX_ROWS;
    const kept = more ? scoped.slice(0, MAX_ROWS) : scoped;
    const last = kept[kept.length - 1];
    return {
      resources: kept.map((row) => ({
        // Template metadata first, so a document's own title wins.
        ...RESOURCE_METADATA,
        uri: `capsid://${row.namespace}/${row.path}`,
        name: `${row.namespace}/${row.path}`,
        title: row.title ?? undefined,
        mimeType: "text/markdown",
      })),
      ...(more && last ? { nextCursor: b64urlEncode(JSON.stringify({ n: last.namespace, p: last.path })) } : {}),
    };
  });
}
