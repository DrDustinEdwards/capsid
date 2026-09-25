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
        `Open improve runs, or control the loop. action defaults to "run": open runs for the roster (or one namespace) and advance them one step, respecting APP_KV improve_mode and skipping paused namespaces; dry_run reports the plan and writes NOTHING. mode, pause, unpause and budget each write one KV value, audit it, and read it back so the response is the value that actually landed: action "mode" sets improve_mode to value ("off" | "subscription" | "api"); action "pause"/"unpause" sets or clears improve:paused for one namespace or "all" (pause takes an optional reason); action "budget" sets the monthly caps actions_minutes_month and model_usd_month. action "mint_operator_key" generates a READ-ONLY (ro:) operator key, returns it ONCE and stores it nowhere, and prints the exact wrangler command that adds its hash to OPERATOR_KEY_HASH; it deliberately does NOT set the secret itself, because a Worker that can widen its own authorization list does not have one. action "claim" takes the SUBSCRIPTION-MODE DRIVER LEASE for one namespace (improve:driver:<ns>, six-hour TTL): it refuses if the lease is already held and never overwrites the holder, and release: true gives it back at the end of a run. It is best-effort mutual exclusion, not a lock, because KV has no compare-and-set; it stops a second /improve session, not two claims in the same millisecond. action "register_skill" registers one CANDIDATE skill abstracted from a finished job, from the skill object: the package's declared fields and its instruction body. The source job must be done with one merged pull request and green CI as the Worker verified it, and must not have produced a skill before; the namespace is read from the job. The row starts at status candidate, version 1, and the body is stored at capsid/improve/skills/<id>.md. action "sign_policy" signs the policy document already stored at path (namespace "capsid", path under "policy/"), never a body the caller supplies; the prior body is snapshotted and the signing is audit-logged. improve_status reflects the control actions on its next call. run and claim need the write grant; every other action is admin only.`,
      inputSchema: {
        action: z
          .enum(["run", "mode", "pause", "unpause", "budget", "mint_operator_key", "claim", "sign_policy", "register_skill"])
          .optional()
          .describe('What to do. Defaults to "run". The others control the loop: mode, pause, unpause, budget, mint_operator_key, claim, sign_policy, register_skill.'),
        namespace: nsName.optional().describe('For "run", limit to one namespace (omit for the whole roster). For pause/unpause, the target namespace, or "all".'),
        value: z.enum(["off", "subscription", "api"]).optional().describe('For action "mode": the mode to set.'),
        reason: bounded(MAX_DOC_STATUS).optional().describe('For action "pause": the reason recorded on the pause key. Defaults to a generic note.'),
        actions_minutes_month: z.number().positive().optional().describe('For action "budget": the monthly Actions-minutes cap.'),
        model_usd_month: z.number().positive().optional().describe('For action "budget": the monthly model-spend cap in USD.'),
        dry_run: z.boolean().optional().describe('For action "run": report the plan and change nothing. Defaults to false.'),
        path: bounded(512)
          .optional()
          .describe(
            'For action "sign_policy": the path of the policy document to sign, under "policy/" in the capsid namespace. The signer signs the body ALREADY STORED rather than any body the caller supplies, so it cannot be used to sign arbitrary bytes.'
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
            `For action "run", the experimental condition: ${RUN_CONDITIONS.join(" | ")}. Defaults to full. "no-memory" withholds lineage history from base selection; "no-transfer" offers no cross-project skill. Recorded on the run row and in its audit rows, so an ablation is a query. An unrecognised value is refused rather than defaulted.`
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
        "The improve loop's current state: the mode, and per namespace the pause reason if any, whether its anchor block is pinned, the best known commit and score, the last run, and lifetime totals for attempts, keeps, reverts, estimated model cost and CI minutes. Each namespace also carries a jobs block: how many queued, claimed and blocked, how many finished today, and the BLOCKED JOBS THEMSELVES with the command each is waiting on, because a count of blocked jobs tells nobody what to run. It also serves protected_paths, the deterministic path guard's pattern list (source and flags per entry), which the subscription-mode driver rebuilds and applies to each attempt's changed paths before any push, so that guard cannot drift from the Worker's, and agents, the credential inventory: every minted agent with its kind, the namespaces and grants it holds, the blast-radius flags it holds (only the ones it has, because a row of falses hides the one agent that can merge), when it was last seen, and whether it has been revoked. Never a key and never the stored verifier. Read-only. cost_usd is an estimate computed from token counts and published rates, not a bill.",
      inputSchema: {
        namespace: nsName.optional().describe("Limit to one namespace. Omit for the whole roster."),
        task_path: docPath
          .optional()
          .describe(
            "Verify one task document before executing it: pass its path (for example improve/run-2026-09-07.md) together with its namespace. The response gains task_verification { ok, actor, reason }, which checks the HMAC signature against the key this Worker derives AND that the last audit actor is the loop itself. The /improve driver must refuse a doc that does not verify."
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
