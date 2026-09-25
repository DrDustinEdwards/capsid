import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hintsFor } from "../tool-annotations";
import { z } from "zod";
import { AGENT_KINDS, SCOPE_FLAGS, AGENT_GRANTS } from "../agents-schema";
import { listAgents, mintAgent, revokeAgent, updateAgentScopes } from "../agents-admin";
import { bounded, MAX_DOC_TYPE, nsName } from "../limits";
import { fail, ok, type ToolCtx } from "./docs";

const AGENT_ACTIONS = ["mint", "list", "revoke", "update_scopes"] as const;

export function registerAgentTools(server: McpServer, ctx: ToolCtx): void {
  const { db, actor } = ctx;

  // The credential control plane's one tool, a ruled exception to the tool surface
  // rule (CLAUDE.md; capsid/decisions.md). Minting by hand would leave the scope rows
  // with no audit trail and no validation. Its actions share one tool because they
  // are one subsystem with one row shape.
  server.registerTool(
    "agents",
    {
      annotations: hintsFor("agents"),
      description:
        `Scoped credentials: one row per caller, with its own key, its own scopes and its own audit identity. ADMIN ONLY, every action: a minted agent cannot mint, revoke or re-scope another, because an agent that can widen itself has no scope. The admin is an OAuth session on /mcp or a write-grant OPERATOR_KEY_HASH entry on /ops/mcp. action "mint" creates an agent and RETURNS ITS KEY ONCE: the key is stored nowhere, the table holds its sha256, and a lost key is replaced by revoking and minting again. It takes name (unique forever, revoked names included, because it is the audit identity), kind (${AGENT_KINDS.join(" | ")}), namespaces (the list it may reach, or the single entry * for all), and optionally repos, tools, grants and flags. A new agent defaults to READ on its named namespaces with no flags; widen it deliberately. The flags are the blast radius, each naming an action whose consequence leaves this Worker: ${SCOPE_FLAGS.join(", ")}. action "list" is the inventory, REVOKED ROWS INCLUDED, with each agent's scopes, last_seen and a 12-hex fingerprint of its key digest; the stored verifier is never returned. action "revoke" sets revoked_at rather than deleting, so the audit rows an agent wrote still resolve to what it was allowed to do, and its key stops resolving immediately. action "update_scopes" replaces named axes and leaves the rest: a call naming one flag does not clear the others. Minting and re-scoping are audit-logged with the scopes and, for a mint, the key's fingerprint. Never the key.`,
      inputSchema: {
        action: z.enum(AGENT_ACTIONS).describe("mint | list | revoke | update_scopes."),
        name: bounded(64).optional().describe("For mint, revoke and update_scopes: the agent's name, which is its audit identity (agent:<name>)."),
        kind: bounded(MAX_DOC_TYPE).optional().describe(`For mint: ${AGENT_KINDS.join(" | ")}. Descriptive, not authorizing: what an agent may do is in its scopes.`),
        namespaces: z
          .array(nsName)
          .optional()
          .describe('For mint (required) and update_scopes: the namespaces this agent may reach, or the single entry "*" for every one.'),
        repos: z
          .array(bounded(128))
          .optional()
          .describe(
            'The repos this agent may reach, as "owner/name" entries, or the single entry "*". Omit it and the mint DERIVES the list from the live mapping of the namespaces it is scoped to, so the axis names real repos rather than the wildcard; a namespace that maps none refuses the mint instead of widening it. A namespace scope of "*" derives "*".'
          ),
        tools: z.array(bounded(64)).optional().describe('Tool names this agent may call, or the single entry "*". Defaults to every tool its grant allows. An entry may be qualified as "tool.action" (for example "manage_pr.comment"), which narrows that tool to the actions named and refuses its others.'),
        grants: z.array(z.enum(AGENT_GRANTS)).optional().describe(`read, or read and write. A new agent gets read.`),
        flags: z
          .object(Object.fromEntries(SCOPE_FLAGS.map((flag) => [flag, z.boolean().optional()])))
          .optional()
          .describe(`The blast-radius flags: ${SCOPE_FLAGS.join(", ")}. Absent means unchanged, never cleared. Every one defaults to false at mint.`),
      },
    },
    async (args) => {
      try {
        // Admin only, every action. TOOL_GRANTS.agents in src/scope.ts states it and the
        // registrar refuses a minted agent before this handler runs.
        const scopeArgs = { namespaces: args.namespaces, repos: args.repos, tools: args.tools, grants: args.grants, flags: args.flags };
        switch (args.action) {
          case "mint": {
            if (!args.name || !args.kind) return fail("mint needs a name and a kind.");
            return ok(await mintAgent(db, actor, { ...scopeArgs, name: args.name, kind: args.kind }));
          }
          case "list":
            return ok(await listAgents(db));
          case "revoke": {
            if (!args.name) return fail("revoke needs the agent's name.");
            return ok(await revokeAgent(db, actor, args.name));
          }
          case "update_scopes": {
            if (!args.name) return fail("update_scopes needs the agent's name.");
            return ok(await updateAgentScopes(db, actor, args.name, scopeArgs));
          }
        }
        return fail(`unknown agents action '${args.action}'.`);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
