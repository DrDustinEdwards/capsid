import { ciGreenOn, type PrFacts } from "./auto-merge-policy";
import type { Env } from "./env";
import { HeadMovedError, managePr } from "./github/refs";
import { systemAudit } from "./doc-statements";
import type { Classification } from "./merge-class";

// THE EXECUTOR (docs/design/design-merge-pipeline.md section 4, PR 4; Dustin's DECIDE of
// 2026-10-09: approvals void on a new push, red CI or 7 days). The auto-merge tick
// (src/auto-merge-tick.ts) calls it for a pull request the signed policy did not merge and
// that holds an open approval (src/pr-approvals.ts). In order:
//   1. the head is not the approved sha: void, "new push";
//   2. the approval is older than 7 days: expire;
//   3. CI on that sha, by the policy's own ci_green test (ciGreenOn): not finished waits,
//      red voids, "CI red", and a namespace with no required steps refuses;
//   4. a head off the base repo, a base that is not the default branch, or a money path
//      approved without its typed confirmation refuses;
//   5. otherwise managePr merge pinned to the approved sha: a 409 voids, "head moved", and
//      success moves the row to merged with the merge sha.
// It is the only thing that merges an approved pull request. Every state move is
// `UPDATE ... WHERE id = ? AND status = 'approved' RETURNING id` (CLAUDE.md, path mutation
// rule), in one batch with its audit row, written as SYSTEM_ACTOR (src/doc-statements.ts) like the tick's own rows.

const APPROVAL_DAYS = 7;
const DAY_MS = 86_400_000;

export interface OpenApproval {
  id: number;
  pr: number;
  head_sha: string;
  class: string;
  approved_by: string;
  surface: string;
  batch_id: string | null;
  approved_at: string;
}

/** The open approvals on one repo, by pull request number. */
export async function readOpenApprovals(db: D1Database, repo: string): Promise<Map<number, OpenApproval>> {
  const { results } = await db
    .prepare(
      `SELECT id, pr, head_sha, class, approved_by, surface, batch_id, approved_at FROM pr_approvals
       WHERE repo = ?1 AND status = 'approved'`
    )
    .bind(repo)
    .all<OpenApproval>();
  return new Map((results ?? []).map((r) => [r.pr, r]));
}

export type ExecutorResult =
  | { done: "merged"; merge_sha: string | null; why: string }
  | { done: "voided" | "expired" | "refused"; why: string }
  | { done: "waiting"; why: string };

const AUDIT: Record<"voided" | "expired" | "refused" | "merged", string> = {
  voided: "pr-approval-voided",
  expired: "pr-approval-expired",
  refused: "pr-approval-refused",
  merged: "approved-merged",
};

/** One state move and its audit row, in one batch. False when the row had already moved. */
async function close(
  env: Env,
  namespace: string,
  approval: OpenApproval,
  facts: Pick<PrFacts, "repo" | "number" | "headSha">,
  status: "voided" | "expired" | "refused" | "merged",
  reason: string,
  now: Date,
  mergeSha: string | null = null
): Promise<boolean> {
  const at = now.toISOString();
  const [moved] = await env.DB.batch([
    env.DB.prepare(`UPDATE pr_approvals SET status = ?2, closed_at = ?3, close_reason = ?4, merge_sha = ?5 WHERE id = ?1 AND status = 'approved' RETURNING id`).bind(
      approval.id,
      status,
      at,
      reason,
      mergeSha
    ),
    systemAudit(env.DB, AUDIT[status], namespace, {
      repo: facts.repo,
      pr: facts.number,
      approved_sha: approval.head_sha,
      head_sha: facts.headSha,
      class: approval.class,
      approved_by: approval.approved_by,
      surface: approval.surface,
      batch_id: approval.batch_id,
      reason,
      ...(mergeSha ? { merge_sha: mergeSha } : {}),
      at,
    }),
  ]);
  return (moved?.results?.length ?? 0) > 0;
}

/** Acts on one open approval of a pull request the policy left open. */
export async function executeApproval(
  env: Env,
  namespace: string,
  facts: PrFacts,
  classified: Classification | null,
  approval: OpenApproval,
  now: Date
): Promise<ExecutorResult> {
  const end = async (done: "voided" | "expired" | "refused", why: string): Promise<ExecutorResult> => {
    await close(env, namespace, approval, facts, done, why, now);
    return { done, why };
  };
  if (facts.headSha !== approval.head_sha) {
    return end("voided", `new push: approved at ${approval.head_sha.slice(0, 7)}, the head is ${facts.headSha.slice(0, 7)} now`);
  }
  if (now.getTime() - Date.parse(approval.approved_at) > APPROVAL_DAYS * DAY_MS) {
    return end("expired", `approved ${APPROVAL_DAYS} days ago or more without merging`);
  }
  const ci = ciGreenOn(facts);
  if (ci.state === "wait") return { done: "waiting", why: ci.why };
  if (ci.state === "red") return end("voided", `CI red: ${ci.why}`);
  if (ci.state === "never") return end("refused", ci.why);
  if (facts.headRepo === null || facts.headRepo.toLowerCase() !== facts.repo.toLowerCase()) {
    return end("refused", "head_in_base_repo: the head is not on the base repo");
  }
  if (facts.baseRef !== facts.defaultBranch) {
    return end("refused", `base_is_default_branch: the base is ${facts.baseRef}, not ${facts.defaultBranch}`);
  }
  // A money path is approved only by typing (design section 8). The class is read again
  // from this tick's files, so a pull request that became one since is not merged on an
  // approval that never typed it.
  if (classified?.class === "typed" && approval.surface !== "typed") {
    return end("refused", "a money path, approved without its typed confirmation");
  }
  let mergeSha: string | null;
  try {
    // merge_method "merge", as the tick's own merges, so the approved sha stays in history;
    // pinned to it, so a push since this read gets a 409 and nothing merges.
    const result = (await managePr(env, namespace, facts.number, "merge", "merge", undefined, undefined, approval.head_sha)) as { sha?: string };
    mergeSha = result.sha ?? null;
  } catch (err) {
    if (!(err instanceof HeadMovedError)) throw err;
    return end("voided", `head moved: GitHub refused the merge pinned to ${approval.head_sha.slice(0, 7)}`);
  }
  const why = `merged on the approval of ${approval.approved_by} (${approval.surface}) at ${approval.head_sha.slice(0, 7)}`;
  await close(env, namespace, approval, facts, "merged", why, now, mergeSha);
  return { done: "merged", merge_sha: mergeSha, why };
}

// The reason on the approved-merged audit row closeAsAutoMerged writes. The same merge
// also has its auto-merged row, so src/trends.ts reads this to count the merge once.
export const AUTO_MERGED_APPROVAL_REASON = "the signed policy merged it on its own";

/** A pull request the policy merged on its own: its open approval is closed as merged. */
export async function closeAsAutoMerged(env: Env, namespace: string, facts: PrFacts, approval: OpenApproval, mergeSha: string | null, now: Date): Promise<void> {
  await close(env, namespace, approval, facts, "merged", AUTO_MERGED_APPROVAL_REASON, now, mergeSha);
}

/** Every approval older than 7 days, on any pull request, open or not: expired. The tick
 *  sees only open pull requests, so one closed or merged by hand would otherwise stay open. */
export async function expireStaleApprovals(env: Env, now: Date): Promise<number> {
  const at = now.toISOString();
  const { results } = await env.DB.prepare(
    `UPDATE pr_approvals SET status = 'expired', closed_at = ?1, close_reason = ?2 WHERE status = 'approved' AND approved_at < ?3 RETURNING id, repo, pr, head_sha`
  )
    .bind(at, `approved ${APPROVAL_DAYS} days ago or more without merging`, new Date(now.getTime() - APPROVAL_DAYS * DAY_MS).toISOString())
    .all<{ id: number; repo: string; pr: number; head_sha: string }>();
  const rows = results ?? [];
  if (rows.length) {
    await env.DB.batch(rows.map((r) => systemAudit(env.DB, "pr-approval-expired", null, { repo: r.repo, pr: r.pr, approved_sha: r.head_sha, reason: "7 days", at })));
  }
  return rows.length;
}
