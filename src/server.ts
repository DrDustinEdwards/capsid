import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Env } from "./env";
import { legacyAgent, type Agent } from "./agents";
import { checkScope, guardRegistrations } from "./scope";
import { b64urlDecode, b64urlEncode } from "./encoding";
import { MAX_ROWS } from "./limits";
import { registerDocTools, type ToolCtx, type ToolGrant } from "./tools/docs";
import { registerLintTools } from "./tools/lint";
import { registerRepoTools } from "./tools/repo";
import { registerImproveTools } from "./tools/improve";
import { registerJobTools } from "./tools/jobs";
import { registerAgentTools } from "./tools/agents";

export type { ToolGrant };

const SERVER_INFO = { name: "capsid", version: "1.0.0" };

// Warn, never refuse, when overwriting a document touched in the last hour without if_match.
const CONCURRENT_EDIT_WINDOW_MS = 60 * 60 * 1000;

export function concurrentEditWarning(updatedAt: string | null | undefined, now: number): string | null {
  if (!updatedAt) return null;
  // D1 stores datetime('now') in UTC with no zone, which Date.parse reads as local.
  // That would silence the warning on a machine behind UTC and fire it constantly on
  // one ahead.
  const parsed = Date.parse(`${updatedAt.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed)) return null;
  const age = now - parsed;
  if (age < 0 || age > CONCURRENT_EDIT_WINDOW_MS) return null;
  return (
    `possible concurrent edit: this document was last written at ${updatedAt} UTC, within the last hour, and no if_match was passed. ` +
    `The write went through and the prior body was snapshotted to document_versions, so nothing is lost, but if another session is working on this document your write may have just replaced its changes. ` +
    `Pass if_match (the sha256 this response returns) on the next write to make that a refusal instead of a warning.`
  );
}

// The caller is an agent (src/agents.ts). A bare grant plus an actor string means an
// unrestricted caller at that grant: the OPERATOR_KEY_HASH fallback, expressed once so
// there is no second code path where scopes do not apply.
export function buildServer(env: Env, caller: Agent | ToolGrant, actor = ""): McpServer {
  const agent = typeof caller === "string" ? legacyAgent(caller, actor) : caller;
  const server = new McpServer(SERVER_INFO);
  const db = env.DB;

  // Provenance: the actor from a document's latest audit_log entry, surfaced by read
  // and brief so a session can tell who wrote what it treats as context: a document
  // another client wrote is untrusted input. A separate read rather than a joined
  // subquery, so the document read stays a named-column projection. Null when the
  // document has no audit history.
  const lastActor = async (ns: string, path: string): Promise<string | null> => {
    const row = await db
      .prepare("SELECT actor FROM audit_log WHERE namespace = ?1 AND path = ?2 ORDER BY id DESC LIMIT 1")
      .bind(ns, path)
      .first<{ actor: string | null }>();
    return row?.actor ?? null;
  };

  const ctx: ToolCtx = {
    env,
    db,
    actor: agent.actor,
    agent,
    // The handler half of the one enforcement point, for checks that need the action,
    // mode or path.
    scope: (need) => checkScope(agent, need),
    lastActor,
  };

  // Before any registration, so every tool registered below is wrapped.
  guardRegistrations(server, agent);

  registerDocTools(server, ctx);
  registerLintTools(server, ctx);
  registerRepoTools(server, ctx);
  registerImproveTools(server, ctx);
  registerJobTools(server, ctx);
  registerAgentTools(server, ctx);

  // Scopes for resources and prompts. guardRegistrations wraps registerTool only, and
  // a raw request handler is not a registration, so these handlers check scope here.
  // Without it, an agent bearer on /ops/mcp could read every document by URI and list
  // every prompt while the `read` tool refused it.
  // They are checked as the `read` tool, so an agent narrowed away from `read` loses
  // both and the two surfaces cannot disagree.
  const resourceRefusal = (namespace: string): string | null => checkScope(agent, { tool: "read", grant: "read", namespace });

  // A listing filters rather than refusing, which would leak that there is more.
  const visibleNamespaces = agent.scopes.namespaces;
  const namespaceFilter = <T extends { namespace: string }>(rows: T[]): T[] =>
    visibleNamespaces === "*" ? rows : rows.filter((row) => visibleNamespaces.includes(row.namespace));

  // Stated once, used by the read registration and the list handler below. It spreads
  // onto every listed resource, so keep it to fields true of every document.
  const RESOURCE_METADATA = { title: "Capsid documents", mimeType: "text/markdown" };

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
      const refusal = resourceRefusal(namespace);
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
    const scoped = namespaceFilter(results);
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

  // Prompts: reusable templates stored as type 'prompt' documents whose bodies use
  // {{variable}} placeholders. Handled at the protocol level, since McpServer only
  // lists prompts registered at build time, so the D1 query runs lazily on
  // prompts/list and prompts/get.
  //
  // A prompt is named "<namespace>/<path without .md>", the way every other tool
  // addresses a document. A bare path is not a document key: two namespaces can both
  // hold prompts/brief.md.
  const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  const promptVariables = (body: string) => [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]))];
  // A title reaches the client's model as a description, which it trusts like a tool
  // description, and any write-grant session can write it, so it passes a character
  // allowlist (no backticks, braces or control characters) and a length cap.
  const PROMPT_TITLE_DISALLOWED = /[^A-Za-z0-9 ,.;:()'"!?_/-]+/g;
  const promptSafeTitle = (title: string | null): string | undefined => {
    if (!title) return undefined;
    const safe = title.replace(PROMPT_TITLE_DISALLOWED, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    return safe || undefined;
  };
  server.server.registerCapabilities({ prompts: { listChanged: false } });
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => {
    if (!agent.scopes.grants.includes("read")) {
      throw new McpError(ErrorCode.InvalidParams, `unauthorized: ${agent.actor} holds no read grant, so it lists no prompts.`);
    }
    const { results } = await db
      .prepare("SELECT namespace, path, title, body FROM documents WHERE type = 'prompt' ORDER BY namespace, path")
      .all<{ namespace: string; path: string; title: string | null; body: string | null }>();
    return {
      prompts: namespaceFilter(results).map((row) => ({
        name: `${row.namespace}/${row.path.replace(/\.md$/, "")}`,
        description: promptSafeTitle(row.title),
        arguments: promptVariables(row.body ?? "").map((name) => ({ name, required: true })),
      })),
    };
  });
  server.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    const args = request.params.arguments ?? {};
    // Split on the FIRST slash only: the namespace never contains one and the
    // path frequently does.
    const slash = name.indexOf("/");
    if (slash <= 0 || slash === name.length - 1) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `prompt name must be "<namespace>/<path>", got "${name}". Call prompts/list for the available names.`
      );
    }
    const promptNs = name.slice(0, slash);
    const promptPath = name.slice(slash + 1);
    const refusal = resourceRefusal(promptNs);
    if (refusal) throw new McpError(ErrorCode.InvalidParams, refusal);
    const row = await db
      .prepare(
        "SELECT title, body FROM documents WHERE type = 'prompt' AND namespace = ?1 AND (path = ?2 OR path = ?2 || '.md')"
      )
      .bind(promptNs, promptPath)
      .first<{ title: string | null; body: string | null }>();
    if (!row) throw new McpError(ErrorCode.InvalidParams, `prompt not found: ${name}`);
    const missing = new Set<string>();
    const text = (row.body ?? "").replace(PLACEHOLDER, (placeholder, variable: string) => {
      const value = args[variable];
      if (value === undefined) {
        missing.add(variable);
        return placeholder;
      }
      return String(value);
    });
    if (missing.size > 0) {
      throw new McpError(ErrorCode.InvalidParams, `missing arguments for prompt ${name}: ${[...missing].join(", ")}`);
    }
    return {
      description: promptSafeTitle(row.title),
      // The body is data, not the user's own words. Any write-grant session can write
      // it, and returning it as plain user text would hand whoever last wrote the row
      // a message the client's model reads as its human speaking. An embedded
      // resource is the protocol's shape for content from a store.
      messages: [
        {
          role: "user" as const,
          content: {
            type: "resource" as const,
            resource: { uri: `capsid://${promptNs}/${promptPath}`, mimeType: "text/markdown", text },
          },
        },
      ],
    };
  });

  return server;
}
