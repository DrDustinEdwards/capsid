import { setOvernight } from "../overnight";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { bounded, MAX_DOC_STATUS, nsName } from "../limits";
import { capsidStatus } from "../status";
import { mintOperatorKey } from "../operator-key";
import { signPolicyDocument } from "../policy-sign";
import { resetBreaker } from "../job-breaker";
import { fail, ok, type ToolCtx } from "./docs";

// The two operations behind capsid_run_improve (status) and capsid_admin_control_improve
// (the admin's switches). Both tools keep the improve loop's names, under which agents'
// tools lists grant them, though the loop itself was removed (Dustin, 2026-10-19).
export function defineStatusOperations(server: McpServer, ctx: ToolCtx): void {
  const { env } = ctx;

  ctx.ops.define(
    "admin_control",
    {
      description:
        `The administrator's switches. action "mint_operator_key" returns a new read-only (ro:) operator key once, stores it nowhere, and returns the wrangler command that adds its hash to OPERATOR_KEY_HASH; it does not set the secret. action "breaker_reset" closes the queue's circuit breaker for namespace, so jobs its drivers failed before now stop counting toward the threshold (default 3 holder fails in 24 hours), and with threshold sets that threshold for every namespace; audit-logged and read back. action "overnight" sets the overnight run's switch (value "off" | "api" | "subscription", and a reason, both required): off unless set, with a "Runs on" choice of API key or subscription; choosing subscription records Dustin's decision, its date and its reasoning with the switch; audit-logged and read back. action "sign_policy" signs the policy document already stored at path (namespace "capsid", path under "policy/"), never a body the caller supplies; the prior body is snapshotted and the signing is audit-logged. Admin only.`,
      inputSchema: {
        action: z.enum(["mint_operator_key", "sign_policy", "breaker_reset", "overnight"]),
        namespace: nsName.optional().describe('For "breaker_reset", the namespace. For "sign_policy", "capsid".'),
        value: z.enum(["off", "subscription", "api"]).optional().describe('For action "overnight": "off", "api" or "subscription".'),
        threshold: z.number().int().min(1).max(50).optional().describe('For action "breaker_reset": the number of holder fails in 24 hours that opens the breaker of any namespace.'),
        reason: bounded(MAX_DOC_STATUS).optional().describe('For action "overnight": the required reason for the change.'),
        path: bounded(512)
          .optional()
          .describe('For action "sign_policy": the path of the stored policy document to sign, under "policy/" in the capsid namespace.'),
      },
    },
    async ({ action, namespace, value, reason, path, threshold }) => {
      try {
        // Admin only, stated in TOOL_GRANTS (src/scope.ts) and enforced by the registrar
        // before this handler runs.
        if (action === "sign_policy") {
          if (!namespace || !path) return fail("sign_policy needs the namespace and the path of the policy document.");
          const signed = await signPolicyDocument(env, ctx.actor, namespace, path);
          return signed.ok ? ok(signed) : fail(signed.error);
        }
        if (action === "overnight") return ok(await setOvernight(env, ctx.actor, new Date(), { value, reason }));
        if (action === "breaker_reset") {
          if (!namespace || namespace === "all") return fail("breaker_reset needs one namespace.");
          const reset = await resetBreaker(env, ctx.actor, new Date(), { namespace, threshold });
          return reset.ok ? ok(reset) : fail(reset.error);
        }
        return ok(await mintOperatorKey(env, ctx.actor));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  ctx.ops.define(
    "status",
    {
      description:
        "Capsid's state per namespace: a jobs block (queued, claimed and blocked counts, jobs finished today, and each blocked job with the command it is waiting on), the queue's breaker, the latest lint report, the pull requests auto-merge declined, the daily maintenance list and what needs Dustin. Also the signed policies' versions, the overnight switch, the auto-merge safety meter, canon_paths (the canon documents a key scoped to some namespaces may not change) and, for the admin, agents: every minted agent with its kind, namespaces, grants, the flags it holds, when it was last seen and whether it is revoked. Never returns a key or a stored verifier. Read-only.",
      inputSchema: {
        namespace: nsName.optional().describe("Limit to one namespace. Omit for every app namespace."),
      },
    },
    async ({ namespace }) => {
      try {
        return ok(await capsidStatus(env, namespace, { namespaces: ctx.agent.scopes.namespaces, admin: ctx.agent.admin }));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
