import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, GetPromptRequestSchema, ListPromptsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Agent } from "./agents";
import { namespaceFilter, resourceRefusal } from "./resources";

export function registerPrompts(server: McpServer, agent: Agent, db: D1Database): void {
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
      prompts: namespaceFilter(agent, results).map((row) => ({
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
    const refusal = resourceRefusal(agent, promptNs);
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
}
