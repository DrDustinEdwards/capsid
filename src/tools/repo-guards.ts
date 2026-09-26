import { fail, ok, type ToolCtx } from "./docs";
import { repoWriteFlags } from "../scope";
import { resolveRepo } from "../github/client";
import { auditStatement } from "../store-guards";

// The wrappers every repo tool runs through. guardedRead resolves the repo and asks
// the repos axis before a read; guardedWrite does the same for a mutation, computes
// the flags it needs (repoWriteFlags), runs it, and writes its audit row. Every repo
// mutation goes through guardedWrite (test/blast-radius.test.ts).
export function repoGuards(ctx: ToolCtx) {
  const { env, db, actor } = ctx;

  // The repos axis, asked about the repo this call actually reaches. The registrar
  // can only compare a fully qualified owner/name; a label is a selector, and
  // omitting it is the default. So every repo tool resolves the selector against the
  // namespace mapping here and asks checkScope about the result. Without this the
  // axis would bind nothing on the default call path: an admin remap of a namespace's
  // primary would silently redirect every driver scoped to the old repo. It costs one
  // D1 read per repo call.
  const scopedRepo = async (tool: string, namespace: string, selector: string | undefined) => {
    const resolved = await resolveRepo(env, namespace, selector);
    return { resolved, refusal: ctx.scope({ tool, namespace, repo: resolved.full }) };
  };

  // The read tools' wrapper: resolve, check the axis, then run. Reads are open to any
  // admitted client by grant, and the axis is what says WHICH repo they may read.
  const guardedRead = async (tool: string, namespace: string, selector: string | undefined, fn: () => Promise<unknown>) => {
    try {
      const { refusal } = await scopedRepo(tool, namespace, selector);
      if (refusal) return fail(refusal);
      return ok(await fn());
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

  // Repo writes are operator-gated and audit-logged. The whole result (which
  // includes the resolved repo) goes into params so a misdirected write is
  // diagnosable from the log; path is the file path where one applies.
  const guardedWrite = async (
    action: string,
    namespace: string,
    path: string | null,
    fn: () => Promise<Record<string, unknown>>,
    // What the call is actually asking to do, which is what decides the flags. The
    // registrar has already checked the tool, the grant, the namespace and the repo
    // selector by now; a wrapper could not have checked these, because `mode:
    // "direct"` needs can_direct_write and `mode: "pr"` does not.
    intent: { path?: string; mode?: string; action?: string; allow_workflow_write?: boolean; force?: boolean; repo?: string } = {}
  ) => {
    // Every repo mutation passes through here, so the flag check is here and not in
    // each tool. test/scope-coverage.test.ts derives that no repo write tool reaches
    // GitHub any other way.
    // Resolved first, so the repos axis is asked about the repo this write reaches.
    // A namespace that cannot be resolved fails here, before anything is written.
    let resolvedRepo: string;
    try {
      resolvedRepo = (await resolveRepo(env, namespace, intent.repo)).full;
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const refusal = ctx.scope({
      tool: action,
      namespace,
      repo: resolvedRepo,
      // What this call is asking to do, which is what the tools axis narrows on.
      // Without it a reviewer minted ["manage_pr", "manage_pr.comment"] could close a
      // pull request. The registrar populates it too; this is the one place every repo
      // mutation passes through.
      action: intent.action,
      grant: "write",
      flags: repoWriteFlags(action, { ...intent, path: intent.path ?? path ?? undefined }),
    });
    if (refusal) return fail(refusal);
    let result: Record<string, unknown>;
    try {
      result = await fn();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    // The mutation already landed: fn() has committed to GitHub, and GitHub cannot
    // join a D1 transaction. A failed audit INSERT is reported as a warning on a
    // success, because a caller told "failed" would retry into a second commit. The
    // D1-only tools do not need this: delete, move and finalize put the audit
    // INSERT inside the same batch as the mutation.
    try {
      await auditStatement(db, actor, action, namespace, path, result).run();
    } catch (err) {
      console.error(`AUDIT_INSERT_FAILED ${action} ${namespace}/${path ?? ""}: ${err instanceof Error ? err.message : String(err)}`);
      return ok({
        ...result,
        audit_warning:
          `THE ${action} SUCCEEDED and is described by this result, but the audit_log row could not be written: ` +
          `${err instanceof Error ? err.message : String(err)}. Do not retry this call; the change is already made.`,
      });
    }
    return ok(result);
  };

  return { guardedRead, guardedWrite };
}
