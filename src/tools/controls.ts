import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONTROLS, PORTAL_ACTIONS, performControl, previewControl, TOKEN_TTL_SECONDS } from "../controls";
import { bounded, MAX_TITLE } from "../limits";
import type { PortalAction } from "../ops-types";
import { hintsFor } from "../tool-annotations";
import { fail, ok, type ToolCtx } from "./docs";

const MAX_PARAM = 1024;
const MAX_KEY = 64;
const MAX_TOKEN = 4096;
const ACCESS_PREFIX = "access:";

export function registerControlTools(server: McpServer, ctx: ToolCtx): void {
  const { env } = ctx;

  // The admin controls the Portal's buttons run, reachable from chat as one tool (a ruled
  // exception to the tool surface rule: capsid/decisions-vol-5.md, the controls ruling of
  // 2026-10-03, D1). One registry (src/controls.ts) is behind both surfaces, so a control
  // is implemented once and a test holds the two lists equal. Admin only in whole
  // (TOOL_GRANTS.controls): the registrar refuses every other caller before this handler
  // runs. The confirmation is the Portal's: preview returns the plan and a signed token for
  // five minutes that binds the action, its params and this administrator, and perform
  // takes only the token and spends it, so no confirmation is used twice.
  server.registerTool(
    "controls",
    {
      annotations: hintsFor("controls"),
      description: `The administrator's controls, the same ones Capsid Portal's buttons run: ${PORTAL_ACTIONS.join(", ")}. Admin only. Two steps, never one. action "list" returns each control, the params it takes and whether it needs a reason. action "preview" (control, params) reads the current state, WRITES NOTHING, and returns what will change, the audit rows it will write and a token good for ${TOKEN_TTL_SECONDS / 60} minutes. action "perform" (token) runs exactly what that preview described, once: the token binds the action, its params and you, and is spent when used, so a second perform of it is refused and you preview again. Performing from here writes a control-<action> audit row naming you and the surface; the Portal writes portal-<action>. Merging a pull request and minting a credential are deliberately not controls: a merge can start a deploy and stays with manage_pr behind can_merge, and a mint stays with agents. REFUSES: a caller that is not the administrator signed in through Access; an unknown control; a param the control does not take; a switch with no reason; a token that is malformed, expired, issued to someone else or already used.`,
      inputSchema: {
        action: z.enum(["list", "preview", "perform"]).describe("list | preview | perform."),
        control: z
          .enum(PORTAL_ACTIONS as unknown as [PortalAction, ...PortalAction[]])
          .optional()
          .describe("For preview: the control to preview."),
        params: z
          .record(bounded(MAX_KEY), bounded(MAX_PARAM))
          .optional()
          .describe(`For preview: the control's params, each a string (list says which). A reason is at most ${MAX_TITLE} characters.`),
        token: bounded(MAX_TOKEN).optional().describe("For perform: the token the preview returned. Nothing else is read."),
      },
    },
    async (args) => {
      const now = new Date();
      // The token binds an email, and a chat caller has one only when it is the administrator
      // signed in through Access (agent:access:<email>). An operator key or a minted agent
      // has none and cannot hold a control, whatever its grant.
      if (!ctx.actor.startsWith(ACCESS_PREFIX) || ctx.actor.length === ACCESS_PREFIX.length) {
        return fail(`controls needs the administrator signed in through Access; ${ctx.actor} is not.`);
      }
      const email = ctx.actor.slice(ACCESS_PREFIX.length);
      try {
        if (args.action === "list") {
          return ok({
            controls: CONTROLS.map((c) => ({ control: c.name, params: c.fields, reason_required: c.reasonRequired })),
            next: 'Call action "preview" with a control and its params, read the plan, then call action "perform" with the token.',
          });
        }
        if (args.action === "preview") {
          if (!args.control) return fail('preview needs a control. Call action "list" for the names.');
          const previewed = await previewControl(env, email, args.control, args.params ?? {}, now, "chat");
          return previewed.ok ? ok(previewed.preview) : fail(previewed.refusal);
        }
        if (!args.token) return fail("perform needs the token a preview returned.");
        const did = await performControl(env, email, args.token, null, now, "chat");
        return did.ok ? ok({ action: did.action, summary: did.result.summary, warning: did.result.warning }) : fail(did.refusal);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
