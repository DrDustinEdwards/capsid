import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hintsFor } from "../tool-annotations";
import { z } from "zod";
import { bounded, docPath, MAX_BODY, MAX_DOC_STATUS, MAX_TITLE, nsName } from "../limits";
import { ROSTER as IMPROVE_ROSTER, onRoster, RUN_CONDITIONS } from "../improve-schema";
import { improveControl, improveRunManual, improveStatus } from "../improve-run";
import { signPolicyDocument } from "../policy-sign";
import { registerSkill } from "../skills-register";
import { fail, ok, type ToolCtx } from "./docs";

// A declared skill field is a sentence or a short paragraph, not a document.
const MAX_SKILL_FIELD = 2000;
const MAX_SKILL_BODY = MAX_BODY;

export function registerImproveTools(server: McpServer, ctx: ToolCtx): void {
  const { env } = ctx;

  // The improve loop's two tools, a ruled exception to the tool surface rule
  // (CLAUDE.md; capsid/decisions.md). The subsystem is driven by cron, and these let
  // a human inspect it and start it by hand.
  server.registerTool(
    "improve_run",
    {
      annotations: hintsFor("improve_run"),
      description:
        `Open improve runs, or control the loop. action "run" (the default) opens runs for the roster, or one roster namespace, and advances them one step; it respects improve_mode, skips paused namespaces, refuses a namespace not on the roster, and with dry_run reports the plan and writes nothing. action "mode" sets improve_mode to value ("off" | "subscription" | "api"). action "pause" or "unpause" sets or clears the pause for one namespace or "all"; pause takes an optional reason. action "budget" sets the monthly caps actions_minutes_month and model_usd_month. mode, pause, unpause and budget are audit-logged and return the value read back from KV. action "mint_operator_key" returns a new read-only (ro:) operator key once, stores it nowhere, and returns the wrangler command that adds its hash to OPERATOR_KEY_HASH; it does not set the secret. action "claim" takes the subscription-mode driver lease for one namespace (six-hour TTL) and is refused while the lease is held; release: true gives it back. The lease is best-effort. action "register_skill" registers one candidate skill from the skill object; refused unless the source job is done with one merged pull request and green CI and has produced no skill yet. The body is stored at capsid/improve/skills/<id>.md. action "skill_transitions" sets whether the skills evaluation cycle applies the status changes its evaluations decide ("apply") or records them and holds every status ("hold", also what an unset value means); audit-logged and read back. action "sign_policy" signs the policy document already stored at path (namespace "capsid", path under "policy/"), never a body the caller supplies; the prior body is snapshotted and the signing is audit-logged. run and claim need the write grant; every other action is admin only.`,
      inputSchema: {
        action: z
          .enum(["run", "mode", "pause", "unpause", "budget", "mint_operator_key", "claim", "sign_policy", "register_skill", "skill_transitions"])
          .optional()
          .describe('Defaults to "run".'),
        namespace: nsName.optional().describe('For "run", limit to one namespace (omit for the whole roster). For pause/unpause, the target namespace, or "all".'),
        value: z
          .enum(["off", "subscription", "api", "hold", "apply"])
          .optional()
          .describe('For action "mode": the mode to set ("off" | "subscription" | "api"). For action "skill_transitions": "hold" or "apply".'),
        reason: bounded(MAX_DOC_STATUS).optional().describe('For action "pause": the reason recorded on the pause key.'),
        actions_minutes_month: z.number().positive().optional().describe('For action "budget": the monthly Actions-minutes cap.'),
        model_usd_month: z.number().positive().optional().describe('For action "budget": the monthly model-spend cap in USD.'),
        dry_run: z.boolean().optional().describe('For action "run": report the plan and change nothing. Defaults to false.'),
        path: bounded(512)
          .optional()
          .describe(
            'For action "sign_policy": the path of the stored policy document to sign, under "policy/" in the capsid namespace.'
          ),
        release: z
          .boolean()
          .optional()
          .describe('For action "claim": release the lease instead of taking it. Defaults to false.'),
        skill: z
          .object({
            id: bounded(64).describe("The skill id: lowercase letters, digits and hyphens."),
            title: bounded(MAX_TITLE),
            trigger_condition: bounded(MAX_SKILL_FIELD).describe("When the skill applies, in prose. The recommend step matches work against it."),
            termination_test: bounded(MAX_SKILL_FIELD).describe("How a reader knows the skill's work is done."),
            composition_interface: bounded(MAX_SKILL_FIELD).describe("What the skill takes in and hands on, so it composes with another."),
            namespaces: z.array(nsName).max(32).nullable().describe("The namespaces the skill applies to, or null for any."),
            body: bounded(MAX_SKILL_BODY).describe("The instruction body, stored as the skill's document."),
            source_job: bounded(64).describe("The finished job the skill was abstracted from."),
          })
          .optional()
          .describe('For action "register_skill": the candidate to register.'),
        condition: bounded(MAX_DOC_STATUS)
          .optional()
          .describe(
            `For action "run", the experimental condition: ${RUN_CONDITIONS.join(" | ")}. Defaults to full. "no-memory" withholds lineage history from base selection; "no-transfer" offers no cross-project skill. Recorded on the run row and its audit rows. An unrecognised value is refused.`
          ),
      },
    },
    async ({ action, namespace, value, reason, actions_minutes_month, model_usd_month, dry_run, condition, release, path, skill }) => {
      try {
        // Every action but run and claim is admin only, stated in TOOL_ACTION_GRANTS
        // (src/scope.ts) and enforced by the registrar before this handler runs.
        if (action === "sign_policy") {
          if (!namespace || !path) return fail("sign_policy needs the namespace and the path of the policy document.");
          const signed = await signPolicyDocument(env, ctx.actor, namespace, path);
          return signed.ok ? ok(signed) : fail(signed.error);
        }
        if (action === "register_skill") {
          if (!skill) return fail("register_skill needs the skill object.");
          const registered = await registerSkill(env, ctx.actor, skill);
          return registered.ok ? ok(registered) : fail(registered.error);
        }
        if (action && action !== "run") {
          return ok(await improveControl(env, action, { value, namespace, reason, actions_minutes_month, model_usd_month, release }));
        }
        if (namespace && !onRoster(namespace)) {
          return fail(
            `namespace '${namespace}' is not on the improve roster (${IMPROVE_ROSTER.join(", ")}). A namespace joins by being added to ROSTER in src/improve-schema.ts and by having its anchor block pinned.`
          );
        }
        return ok(await improveRunManual(env, new Date(), { namespace, dryRun: dry_run === true, condition }));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "improve_status",
    {
      annotations: hintsFor("improve_status"),
      description:
        "The improve loop's current state: the mode, and per namespace the pause reason, whether its anchor block is pinned, the best known commit and score, the last run, and lifetime totals for attempts, keeps, reverts, estimated model cost and CI minutes. Each namespace carries a jobs block: queued, claimed and blocked counts, jobs finished today, and each blocked job with the command it is waiting on. Also returns protected_paths, the path guard's pattern list (source and flags per entry) for the driver to apply before a push, and agents: every minted agent with its kind, namespaces, grants, the flags it holds, when it was last seen and whether it is revoked. Never returns a key or a stored verifier. Read-only. cost_usd is an estimate from token counts and published rates.",
      inputSchema: {
        namespace: nsName.optional().describe("Limit to one namespace. Omit for the whole roster."),
        task_path: docPath
          .optional()
          .describe(
            "A task document to verify, with its namespace. Adds task_verification { ok, actor, reason }: ok only when the HMAC signature matches this Worker's key and the last audit actor is the loop."
          ),
      },
    },
    async ({ namespace, task_path }) => {
      try {
        return ok(await improveStatus(env, namespace, task_path, { namespaces: ctx.agent.scopes.namespaces, admin: ctx.agent.admin }));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
