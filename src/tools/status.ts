import { setOvernight } from "../overnight";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { bounded, MAX_DOC_STATUS, nsName } from "../limits";
import { capsidStatus } from "../status";
import { signPolicyDocument } from "../policy-sign";
import { resetBreaker } from "../job-breaker";
import { fail, ok, type ToolCtx } from "./docs";

import { errorMessage } from "@dustinedwards/site-runtime/log";
export function defineStatusOperations(server: McpServer, ctx: ToolCtx): void {
  const { env } = ctx;

  ctx.ops.define(
    "admin_control",
    {
      description: `The administrator's switches. action "breaker_reset" closes the queue's circuit breaker for namespace, so jobs its drivers failed before now stop counting toward the threshold (default 3 holder fails in 24 hours), and with threshold sets that threshold for every namespace; audit-logged and read back. action "overnight" sets the overnight run's switch (value "off" | "api" | "subscription", and a reason, both required): off unless set, with a "Runs on" choice of API key or subscription; choosing subscription records Dustin's decision, its date and its reasoning with the switch; audit-logged and read back. action "sign_policy" signs the policy document already stored at path (namespace "capsid", path under "policy/"), never a body the caller supplies, and only when sha256 is the sha256 of the body below its frontmatter as the caller read it; the prior body is snapshotted and the signing is audit-logged. Admin only.`,
      inputSchema: {
        action: z.enum(["sign_policy", "breaker_reset", "overnight"]),
        namespace: nsName
          .optional()
          .describe('For "breaker_reset", the namespace. For "sign_policy", "capsid".'),
        value: z
          .enum(["off", "subscription", "api"])
          .optional()
          .describe('For action "overnight": "off", "api" or "subscription".'),
        threshold: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            'For action "breaker_reset": the number of holder fails in 24 hours that opens the breaker of any namespace.',
          ),
        reason: bounded(MAX_DOC_STATUS)
          .optional()
          .describe('For action "overnight": the required reason for the change.'),
        path: bounded(512)
          .optional()
          .describe(
            'For action "sign_policy": the path of the stored policy document to sign, under "policy/" in the capsid namespace.',
          ),
        sha256: z
          .string()
          .regex(/^[0-9a-fA-F]{64}$/)
          .optional()
          .describe(
            'For action "sign_policy": the sha256 of the policy body below its frontmatter, as you read it. A body that differs is not signed.',
          ),
      },
    },
    async ({ action, namespace, value, reason, path, threshold, sha256 }) => {
      try {
        // Admin only: TOOL_GRANTS (src/scope.ts), enforced by the registrar.
        if (action === "sign_policy") {
          if (!namespace || !path || !sha256)
            return fail(
              "sign_policy needs the namespace, the path of the policy document and the sha256 of the body you read.",
            );
          const signed = await signPolicyDocument(env, ctx.actor, namespace, path, sha256);
          return signed.ok ? ok(signed) : fail(signed.error);
        }
        if (action === "overnight")
          return ok(await setOvernight(env, ctx.actor, new Date(), { value, reason }));
        if (!namespace || namespace === "all") return fail("breaker_reset needs one namespace.");
        const reset = await resetBreaker(env, ctx.actor, new Date(), { namespace, threshold });
        return reset.ok ? ok(reset) : fail(reset.error);
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  );

  ctx.ops.define(
    "status",
    {
      description:
        "Capsid's state per namespace: a jobs block (queued, claimed and blocked counts, jobs finished today, and each blocked job with the command it is waiting on), the queue's breaker, the latest lint report, the daily maintenance list and what needs Dustin. Also the gate policy's version, the overnight switch, canon_paths (the canon documents and rulings an agent key may not change) and, for the admin, agents: every minted agent with its kind, namespaces, grants, the flags it holds, when it was last seen and whether it is revoked. Never returns a key or a stored verifier. Read-only.",
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
