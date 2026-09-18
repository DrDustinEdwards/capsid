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
  // D1 stores datetime('now') as "YYYY-MM-DD HH:MM:SS" in UTC, which Date.parse reads
  // as LOCAL time unless the zone is made explicit. Getting that wrong would silence
  // the warning on a machine behind UTC and fire it constantly on one ahead.
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

// THE CALLER IS AN AGENT (src/agents.ts). The legacy shape, a bare grant plus an
// actor string, is still accepted and means exactly what it always did: an
// unrestricted caller at that grant. That is not a convenience for the tests, it is
// the OPERATOR_KEY_HASH fallback itself, expressed once so there is no second code
// path where scopes do not apply.
export function buildServer(env: Env, caller: Agent | ToolGrant, actor = ""): McpServer {
  const agent = typeof caller === "string" ? legacyAgent(caller, actor) : caller;
  // One definition of "may this caller write", so no tool can invent its own.
  const grant: ToolGrant = agent.scopes.grants.includes("write") ? "write" : "read";
  const mayWrite = grant === "write";
  const server = new McpServer(SERVER_INFO);
  const db = env.DB;

  // PROVENANCE (audit 2026-09-06). The actor from the most recent audit_log entry for
  // a document, surfaced by read and brief so a session can tell who wrote what it is
  // about to treat as context. A document another client wrote is untrusted input.
  // Kept as a separate read rather than a joined subquery so the document read stays
  // a plain named-column projection. Null when the document has no audit history.
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
    grant,
    mayWrite,
    actor: agent.actor,
    agent,
    // The handler half of the one enforcement point. The registrar below covers what
    // is knowable before a handler runs; this is what an "action" tool and every repo
    // mutation call at the point where the action, the mode and the path are known.
    scope: (need) => checkScope(agent, need),
    lastActor,
  };

  // BEFORE ANY REGISTRATION. Every server.registerTool call below this line is
  // wrapped, whether or not its author thought about scopes, which is the property
  // the per-tool gate it replaces could not have.
  guardRegistrations(server, agent);

  registerDocTools(server, ctx);
  registerLintTools(server, ctx);
  registerRepoTools(server, ctx);
  registerImproveTools(server, ctx);
  registerJobTools(server, ctx);
  registerAgentTools(server, ctx);

  // ---- SCOPES FOR RESOURCES AND PROMPTS ------------------------------------------
  //
  // guardRegistrations wraps registerTool and nothing else, so the four protocol
  // handlers below sat outside the one enforcement point entirely: an agent bearer on
  // /ops/mcp could read every document in every namespace by URI, and list every
  // prompt in the store, while the `read` tool refused it (audit 2026-09-13,
  // finding 6). Spelled here rather than in the registrar because a raw request
  // handler is not a registration and the registrar cannot see one.
  //
  // Checked as the `read` tool, because that is what these are: the resource comment
  // above has said "same visibility as the read tool" since they were added, and this
  // makes the sentence true. An agent narrowed away from `read` loses both, which is
  // the answer that keeps the two surfaces from disagreeing.
  const resourceRefusal = (namespace: string): string | null => checkScope(agent, { tool: "read", grant: "read", namespace });

  // The namespaces a listing may show. A listing FILTERS rather than refusing: a
  // caller asking what it can see should be told what it can see, and refusing the
  // whole call would leak that there is more.
  const visibleNamespaces = agent.scopes.namespaces;
  const namespaceFilter = <T extends { namespace: string }>(rows: T[]): T[] =>
    visibleNamespaces === "*" ? rows : rows.filter((row) => visibleNamespaces.includes(row.namespace));

  // Template metadata spreads onto every listed resource, so it is stated ONCE and
  // applied by both the read registration and the list handler below.
  const RESOURCE_METADATA = { title: "Capsid documents", mimeType: "text/markdown" };

  // Resources: every document is addressable context at capsid://<namespace>/<path>.
  // Read-only, same visibility as the read tool. The D1 queries run lazily, only
  // when a client actually calls resources/list or resources/read.
  server.registerResource(
    "document",
    new ResourceTemplate("capsid://{namespace}/{+path}", {
      // LISTING IS SERVED BY THE RAW HANDLER BELOW. McpServer builds its
      // ListResources reply as `{ resources: [...] }` and discards every other field
      // the callback returns, including _meta AND nextCursor, so a list callback
      // cannot say it was truncated. Capping it here would make document 501
      // unreachable with nothing in the response admitting it.
      list: undefined,
    }),
    // Keep RESOURCE_METADATA to fields that are true per document: it spreads onto
    // every listed resource.
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

  // resources/list, served directly for the same reason prompts are: the request
  // itself is needed and the McpServer wrapper does not pass it through. Here that
  // request carries the CURSOR, which is what makes the bound safe rather than a
  // ceiling on what the store can expose.
  //
  // Keyset pagination, not OFFSET: the cursor names the last (namespace, path)
  // returned and the next page asks for rows after it, compared as a TUPLE. A single
  // concatenated key would be wrong: 'a-x' sorts before 'a' once a separator is glued
  // on ('-' is below '/') and rows would be skipped.
  //
  // This overrides the handler McpServer installs. It is safe only while every
  // resource is served by the one template below; a statically registered resource
  // would be silently dropped. test/bounded-reads.test.ts pins that.
  server.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    // The grant, before the query. A caller with no read grant lists nothing rather
    // than listing everything.
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
    // FILTERED IN THE QUERY, so the LIMIT bounds what this caller can SEE rather than
    // what the store holds. The comment here claimed that for months while the filter
    // ran in JS over an already-cut page (audit 2026-09-16, defect 6): a caller scoped
    // to a namespace that sorts late got 501 rows it may not see, an empty page after
    // filtering, and NO CURSOR, so the walk ended on page one and its own documents
    // were unreachable. The keyset cursor still names the last row RETURNED, which is
    // what keeps the walk correct now that the page is whole.
    //
    // ONE BOUND PARAMETER RATHER THAN A SPLICED CLAUSE, so the statement is the same
    // text on every call: scripts/sql-statements.mjs walks src/ for prepared
    // statements and test-integration/query-plans.test.ts plans each one against the
    // real schema, and a statement assembled per caller is one it reports as
    // unreconstructable and cannot check. json_each turns the JSON array into rows.
    // Null is the unscoped caller, and the predicate is then a constant.
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
    // Kept as a second pass on purpose: it is a no-op against the query above, and it
    // is what still holds if a later edit loses the predicate.
    const scoped = namespaceFilter(results);
    const more = scoped.length > MAX_ROWS;
    const kept = more ? scoped.slice(0, MAX_ROWS) : scoped;
    const last = kept[kept.length - 1];
    return {
      resources: kept.map((row) => ({
        // Template metadata first, per-document fields second: the same order the
        // McpServer wrapper used, so a document's own title still wins.
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
  // addresses a document. It used to be the bare path, which is not a document key:
  // two namespaces can both hold prompts/brief.md and the lookup ended in `LIMIT 1`.
  // One prompt document exists today, so this collides with nothing yet.
  const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  const promptVariables = (body: string) => [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]))];
  // TITLES ARE STORED TEXT AND REACH THE CLIENT'S MODEL AS A DESCRIPTION (audit
  // 2026-09-06, Grok MAJOR 8). A description is trusted UI text the way a tool
  // description is, and a D1 row is writable by any write-grant session, so the title
  // passes a CHARACTER ALLOWLIST: no backticks, no braces, no control characters,
  // capped well under the title bound.
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
      // THE BODY IS DATA, NOT THE USER'S OWN WORDS (audit 2026-09-06, Grok MAJOR 8;
      // the Fable audit's "prompts/get as role:user"). A document body is writable by
      // any write-grant session, and returning it as plain user text hands whoever
      // last wrote the row a message the client's model reads as its human speaking.
      // An embedded resource is the protocol's shape for content from a store.
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
