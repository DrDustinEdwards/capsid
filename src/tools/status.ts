import { McpServer } from "@modelcontextprotocol/server";
import { nsName } from "../limits";
import { capsidStatus } from "../status";
import { fail, ok, type ToolCtx } from "./docs";

import { errorMessage } from "@dustinedwards/site-runtime/log";
export function defineStatusOperations(server: McpServer, ctx: ToolCtx): void {
  const { env } = ctx;

  ctx.ops.define(
    "status",
    {
      description:
        "Capsid's state per namespace: the latest lint report, the daily maintenance list and what needs Dustin. Also canon_paths (the canon documents and rulings an agent key may not change) and, for the admin, agents: every minted agent with its kind, namespaces, grants, the flags it holds, when it was last seen and whether it is revoked. Never returns a key or a stored verifier. Read-only.",
      inputSchema: {
        namespace: nsName
          .optional()
          .describe("Limit to one namespace. Omit for every app namespace."),
      },
    },
    async ({ namespace }) => {
      try {
        return ok(
          await capsidStatus(env, namespace, {
            namespaces: ctx.agent.scopes.namespaces,
            admin: ctx.agent.admin,
          }),
        );
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  );
}
