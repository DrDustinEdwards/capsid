import { fail, ok, type ToolCtx } from "./docs";
import { repoWriteFlags } from "../scope";
import { toolSurfaceOf } from "./surface";
import { resolveRepo } from "../github/client";
import { auditStatement } from "../store-guards";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";

// Every repo mutation goes through guardedWrite (test/blast-radius.test.ts).
export function repoGuards(ctx: ToolCtx) {
  const { env, db, actor } = ctx;

  // The registrar can only compare a fully qualified owner/name, so the selector is resolved
  // against the namespace mapping here: without it, an admin remap of a primary would silently
  // redirect every driver scoped to the old repo. One D1 read per repo call.
  const scopedRepo = async (op: string, namespace: string, selector: string | undefined) => {
    const resolved = await resolveRepo(env, namespace, selector);
    return { resolved, refusal: ctx.scope({ ...toolSurfaceOf(op), namespace, repo: resolved.full }) };
  };

  const guardedRead = async (
    op: string,
    namespace: string,
    selector: string | undefined,
    fn: () => Promise<unknown>,
  ) => {
    try {
      const { refusal } = await scopedRepo(op, namespace, selector);
      if (refusal) return fail(refusal);
      return ok(await fn());
    } catch (err) {
      return fail(errorMessage(err));
    }
  };

  // The whole result (including the resolved repo) goes into params, so a misdirected write is
  // diagnosable from the log.
  const guardedWrite = async (
    action: string,
    namespace: string,
    path: string | null,
    fn: () => Promise<Record<string, unknown>>,
    // The registrar cannot have checked these: a forced branch delete needs can_merge and a plain
    // one does not.
    intent: {
      action?: string;
      force?: boolean;
      repo?: string;
      surface?: { tool: string; action?: string };
    } = {},
  ) => {
    // Resolved first, so the repos axis is asked about the repo this write reaches; an unresolvable
    // namespace fails before anything is written.
    let resolvedRepo: string;
    try {
      resolvedRepo = (await resolveRepo(env, namespace, intent.repo)).full;
    } catch (err) {
      return fail(errorMessage(err));
    }
    // The check names the served tool and action: without the action an agent minted
    // ["capsid_close_pr", "capsid_close_pr.delete_branch"] could merge.
    const served = intent.surface ?? toolSurfaceOf(action, intent.action);
    const refusal = ctx.scope({
      tool: served.tool,
      namespace,
      repo: resolvedRepo,
      action: served.action,
      grant: "write",
      flags: repoWriteFlags(served.tool, served.action, intent),
    });
    if (refusal) return fail(refusal);
    let result: Record<string, unknown>;
    try {
      result = await fn();
    } catch (err) {
      return fail(errorMessage(err));
    }
    // The mutation already landed and GitHub cannot join a D1 transaction, so a failed audit INSERT
    // is a warning on a success: reporting failure would invite a retry into a second commit.
    try {
      await auditStatement(db, actor, action, namespace, path, result, ctx.client).run();
    } catch (err) {
      logEvent(
        "AUDIT_INSERT_FAILED",
        {
          message: `AUDIT_INSERT_FAILED ${action} ${namespace}/${path ?? ""}: ${errorMessage(err)}`,
        },
        { level: "error" },
      );
      return ok({
        ...result,
        audit_warning:
          `THE ${action} SUCCEEDED and is described by this result, but the audit_log row could not be written: ` +
          `${errorMessage(err)}. Do not retry this call; the change is already made.`,
      });
    }
    return ok(result);
  };

  return { guardedRead, guardedWrite };
}
