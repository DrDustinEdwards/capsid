// The registrar gate: guards every tool registration with checkScope.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Agent } from "./agents";
import { errorMessage } from "@dustinedwards/site-runtime/log";
import {
  appendAudit,
  correlationId,
  loggedArgs,
  loggedResult,
  recordAudit,
  type AuditEnv,
} from "@dustinedwards/site-runtime/audit-log";
import { outsideResult, toolScopeChallenge } from "@dustinedwards/site-runtime/mcp-server";
import { describeScope } from "./agents-schema";
import { withCallSignal } from "./call-signal";
import {
  checkScope,
  declaredScope,
  JOBS_TOOL,
  needFor,
  needsStepUp,
  recordStepUp,
  requiredForAction,
  requiredGrant,
  SCOPES,
  sharedGrantRefusal,
} from "./scope";

// The same shape as fail() in tools/docs.ts, spelled here so the enforcement point
// does not import the tool modules it guards (a cycle).
function deny(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// An omitted namespace means "every namespace" on tools such as capsid_find_docs (list, glob,
// search), capsid_read_status action status and capsid_work_jobs action list. For a narrowed caller
// that would be an unchecked hole, so a namespace-restricted caller that omits it is refused.
function namespaceRefusal(agent: Agent, tool: string): string | null {
  if (agent.scopes.namespaces === "*") return null;
  return (
    `unauthorized: ${agent.actor} is scoped to ${describeScope(agent.scopes.namespaces)}, so it must name a namespace on '${tool}'. ` +
    `Omitting it asks for every namespace, which is wider than this caller's scope.`
  );
}

interface RegisteredConfig {
  inputSchema?: Record<string, unknown> | z.ZodObject;
  // A composite tool's actions whose operation takes a namespace (src/tools/surface.ts). The merged
  // schema declares `namespace` when any action takes one, and an action that takes none
  // (capsid_find_docs action namespaces) must not be refused for omitting it.
  namespaceActions?: readonly string[];
}

type ToolHandler = (...args: unknown[]) => unknown;
type ScopeChallengeHandler = (context: {
  request: { params?: Record<string, unknown> };
  authInfo?: { scopes: string[]; clientId?: string; extra?: Record<string, unknown> };
}) => ReturnType<ReturnType<typeof toolScopeChallenge>>;

// Whether a handler's result is a success. An error result is not, and neither is a
// domain refusal, which the tools return as an ordinary result whose JSON says ok:false
// (the call was legitimate and the answer was no, so nothing was done).
function toolSucceeded(result: unknown): boolean {
  const r = result as { isError?: boolean; content?: Array<{ text?: unknown }> } | null;
  if (r?.isError === true) return false;
  const text = r?.content?.[0]?.text;
  if (typeof text !== "string" || !text.startsWith("{")) return true;
  try {
    return (JSON.parse(text) as { ok?: unknown }).ok !== false;
  } catch {
    // Text that looks like JSON and is not is no proof of success: it does not reset the clock.
    return false;
  }
}

// Which argument names what a tool is asked to do (lint spells it `mode`). The registrar needs it
// to populate need.action; a tool absent here cannot be narrowed below the tool name.
const ACTION_ARG: Record<string, string> = {
  capsid_find_docs: "action",
  capsid_read_doc: "action",
  capsid_write_doc: "action",
  capsid_lint_namespace: "mode",
  capsid_read_repo: "action",
  capsid_inspect_repo: "action",
  capsid_close_pr: "action",
  capsid_work_jobs: "action",
  capsid_read_status: "action",
  capsid_admin_manage_namespaces: "action",
  capsid_admin_manage_agents: "action",
  capsid_admin_read_claims: "action",
  capsid_admin_read_ops: "action",
  capsid_admin_run_controls: "action",
  capsid_admin_manage_switches: "action",
};

// The action a tool falls back to when the caller omits an optional one.
const DEFAULT_ACTION: Record<string, string> = {
  capsid_find_docs: "list",
  capsid_read_doc: "read",
  capsid_write_doc: "write",
  capsid_lint_namespace: "gather",
  capsid_read_status: "status",
  capsid_admin_read_claims: "aggregate",
};

/** The action a call means when the caller omits the argument, or undefined. */
export function defaultActionFor(tool: string): string | undefined {
  return Object.hasOwn(DEFAULT_ACTION, tool) ? DEFAULT_ACTION[tool] : undefined;
}

export function actionArgFor(tool: string): string | undefined {
  return Object.hasOwn(ACTION_ARG, tool) ? ACTION_ARG[tool] : undefined;
}

// The action this call asks for, read off the tool's own declared argument so an unrelated property
// spelled "action" cannot narrow it.
function declaredShape(config: RegisteredConfig): Record<string, unknown> | undefined {
  const schema = config?.inputSchema;
  if (schema instanceof z.ZodObject) return schema.shape as Record<string, unknown>;
  return schema;
}

function actionOf(
  tool: string,
  config: RegisteredConfig,
  args: Record<string, unknown>,
): string | undefined {
  const key = actionArgFor(tool);
  if (!key) return undefined;
  const shape = declaredShape(config);
  if (!shape || !Object.hasOwn(shape, key)) return undefined;
  const value = args[key];
  if (typeof value === "string") return value;
  return defaultActionFor(tool);
}

// The registrar gate. Wraps the registration method once, before any tool module runs, so every
// registration that follows is guarded whether or not its author thought about scopes. A new tool
// cannot forget it, because a tool has to be registered to exist.
export interface CallLog {
  env: Partial<AuditEnv>;
  server: { name: string; version: string };
  clientId?: string;
  clientName?: string;
}

// The tools whose answers carry text written outside Capsid, and its label: a repository's files,
// code search hits, pull request titles and bodies, review comments and CI logs, all written by
// whoever can push or comment.
const OUTSIDE_TOOLS: Record<string, string> = {
  capsid_read_repo: "repo",
  capsid_inspect_repo: "repo",
};

/** A successful result of a tool in OUTSIDE_TOOLS, marked as outside data; anything else as it is. */
function markOutside(tool: string, result: unknown): unknown {
  const label = Object.hasOwn(OUTSIDE_TOOLS, tool) ? OUTSIDE_TOOLS[tool] : undefined;
  const r = result as {
    isError?: boolean;
    content?: Array<{ text?: unknown }>;
    structuredContent?: unknown;
  } | null;
  if (!label || !r || r.isError === true || !Array.isArray(r.content)) return result;
  const structured = r.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured))
    return outsideResult(label, structured as Record<string, unknown>);
  return outsideResult(
    label,
    r.content.map((c) => (typeof c.text === "string" ? c.text : "")).join("\n"),
  );
}

/** An MCP icon, as serverInfo and tools/list carry it. */
export type ToolIcon = { src: string; mimeType?: string; sizes?: string[] };

// Whether this caller's grant could ever call the tool, whatever the arguments: the grant
// TOOL_GRANTS names.
export function toolListed(agent: Agent, tool: string): boolean {
  const { grant } = needFor(requiredGrant(tool));
  return grant === undefined || agent.scopes.grants.includes(grant);
}

export function guardRegistrations(
  server: McpServer,
  agent: Agent,
  stepUpKv?: KVNamespace,
  log?: CallLog,
  icons?: readonly ToolIcon[],
): void {
  const original = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    handler: ToolHandler,
  ) => unknown;
  const patched = (name: string, config: RegisteredConfig, handler: ToolHandler) => {
    if (!toolListed(agent, name)) return undefined;
    const shape = declaredShape(config);
    const declared = Boolean(shape && Object.hasOwn(shape, "namespace"));
    const namespaceActions = config?.namespaceActions;
    const takesNamespace = (action: string | undefined): boolean =>
      namespaceActions && action !== undefined ? namespaceActions.includes(action) : declared;
    // Why this call may not run, or null.
    const refusalFor = async (
      args: Record<string, unknown>,
      action: string | undefined,
    ): Promise<string | null> => {
      const shared = sharedGrantRefusal(agent, name, action);
      if (shared) return shared;
      const namespace = typeof args.namespace === "string" ? args.namespace : undefined;
      // Only a full owner/name can be compared to the axis here; the repo tools
      // resolve a label and check the result (scopedRepo in src/tools/repo.ts).
      const selector = typeof args.repo === "string" ? args.repo : undefined;
      const repo = selector?.includes("/") ? selector : undefined;
      const refusal = checkScope(agent, {
        tool: name,
        namespace,
        repo,
        path: typeof args.path === "string" ? args.path : undefined,
        action,
        stepUp: needsStepUp(name, action),
        ...(name === JOBS_TOOL
          ? {
              call: {
                jobId: typeof args.id === "string" ? args.id : undefined,
                filtered:
                  args.view !== undefined || args.stale !== undefined || args.status !== undefined,
              },
            }
          : {}),
        // An "action" tool outside TOOL_ACTION_GRANTS (jobs, lint) is checked by its
        // handler, where the namespace is known, so the registrar names no grant.
        ...needFor(requiredForAction(name, action)),
      });
      if (refusal) return refusal;
      // A run key's call has already passed benchRunRefusal, which binds it to its one
      // job in bench, so an omitted namespace asks for nothing wider.
      if (takesNamespace(action) && namespace === undefined && !agent.benchRun) {
        const missing = namespaceRefusal(agent, name);
        if (missing) return missing;
      }
      return null;
    };
    const run = async (
      callArgs: unknown[],
      action: string | undefined,
      signal: AbortSignal | undefined,
    ): Promise<unknown> => {
      // The request's abort signal reaches every outbound request the handler makes
      // (src/call-signal.ts).
      const result = markOutside(name, await withCallSignal(signal, () => handler(...callArgs)));
      // A step-up action that succeeded resets the idle clock (STEP_UP). A refused or
      // failed one does not: it proves nothing about the person being there.
      const signedInAt = agent.signedInAt;
      if (
        stepUpKv &&
        signedInAt !== undefined &&
        signedInAt !== null &&
        needsStepUp(name, action) &&
        toolSucceeded(result)
      ) {
        await recordStepUp(stepUpKv, agent, signedInAt, Date.now());
      }
      return result;
    };
    // Every call is logged when the server keeps the log (site-runtime's ToolCallLog), whoever
    // makes it and whatever it does: one `refused` row, or `started` before the handler and
    // `finished` after it.
    const guarded: ToolHandler = async (...callArgs: unknown[]) => {
      const args = (callArgs[0] ?? {}) as Record<string, unknown>;
      const action = actionOf(name, config, args);
      const mcpReq = (
        callArgs[1] as
          | { mcpReq?: { _meta?: { traceparent?: unknown }; signal?: AbortSignal } }
          | undefined
      )?.mcpReq;
      const meta = mcpReq?._meta;
      const signal = mcpReq?.signal;
      const row = log && {
        callId: crypto.randomUUID(),
        caller: agent.actor,
        tool: name,
        args: await loggedArgs(args),
        server: log.server,
        clientId: log.clientId,
        clientName: log.clientName,
        correlationId: correlationId(meta),
      };
      const refusal = await refusalFor(args, action);
      if (refusal) {
        const out = deny(refusal);
        if (log && row)
          await recordAudit(log.env, { ...row, phase: "refused", result: loggedResult(out) });
        return out;
      }
      if (log && row) {
        try {
          await appendAudit(log.env, { ...row, phase: "started" });
        } catch (cause) {
          return deny(
            `refused: the tool-call log could not be written (${errorMessage(cause)}), and no tool runs unlogged. Nothing was done.`,
          );
        }
      }
      // A client that left before the handler ran gets nothing run; one that leaves during it
      // is logged canceled (site-runtime's invokeTool does the same).
      if (signal?.aborted) {
        const out = deny(
          "canceled: the client closed the call before the tool ran. Nothing was done.",
        );
        if (log && row)
          await recordAudit(log.env, {
            ...row,
            phase: "finished",
            result: { ...loggedResult(out), canceled: true },
          });
        return out;
      }
      const canceled = () => (signal?.aborted ? { canceled: true } : {});
      let result: unknown;
      try {
        result = await run(callArgs, action, signal);
      } catch (error) {
        // A handler that throws still ends its call in the log, so no `started` row is left
        // without its `finished` (the log's /health check counts those).
        if (log && row)
          await recordAudit(log.env, {
            ...row,
            phase: "finished",
            result: {
              isError: true,
              text: `threw: ${errorMessage(error)}`.slice(0, 1000),
              ...canceled(),
            },
          });
        throw error;
      }
      if (log && row)
        await recordAudit(log.env, {
          ...row,
          phase: "finished",
          result: {
            ...loggedResult(result as { isError?: boolean; content: Array<{ text: string }> }),
            ...canceled(),
          },
        });
      return result;
    };
    // An OAuth token without the scope the call needs is answered 403 insufficient_scope before the
    // handler runs, naming every scope it needs, so the client can step up instead of the person
    // reconnecting by hand. A key carries no token and gets the refusal above in words.
    const challenge =
      log &&
      toolScopeChallenge(
        log.env,
        { site: "Capsid", scopes: SCOPES, ...log.server },
        {
          name,
          scope: (args: Record<string, unknown>) =>
            declaredScope(name, actionOf(name, config, args)),
        },
      );
    const scopeChallenge: ScopeChallengeHandler | undefined =
      challenge &&
      ((context) =>
        challenge({
          ...context,
          authInfo: context.authInfo && {
            ...context.authInfo,
            scopes: context.authInfo.scopes.length > 0 ? context.authInfo.scopes : [SCOPES.read],
          },
        }));
    const { namespaceActions: _namespaceActions, ...declaredConfig } = config ?? {};
    // Each tool carries the server's icon unless it names its own.
    const served =
      icons && !(declaredConfig as { icons?: unknown }).icons
        ? { ...declaredConfig, icons }
        : declaredConfig;
    return original(name, scopeChallenge ? { ...served, scopeChallenge } : served, guarded);
  };
  (server as unknown as { registerTool: unknown }).registerTool = patched;
}
