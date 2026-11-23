import { readSuspended } from "./merge-units";
import { readPaused } from "./merge-safety";
import type { Env } from "./env";
import type { MergeClass, PathClass } from "./merge-class";
import { getDefaultBranch, resolveRepo } from "./github/client";
import { systemAudit } from "./doc-statements";
import { listOpenPrs, type OpenPr } from "./auto-merge-tick-facts";
import {
  auditDeclineOnChange,
  declineParams,
  judgeOnePr,
  type AutoMergeOutcome,
  type PausedNamespaces,
  type Suspended,
} from "./auto-merge-tick-judge";
import { type PolicyCheck, loadMergePolicy } from "./auto-merge-policy";
import { jobIdFromBody } from "./auto-merge-policy-evaluate";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { isVisual, visualDetails, type VisualPr } from "./visual-pr";
import { expireStaleApprovals, readOpenApprovals, type OpenApproval } from "./approval-executor";

// The auto-merge tick: read each open pull request's facts from GitHub and D1, judge
// them with evaluatePolicy (src/auto-merge-policy-evaluate.ts), and merge or record the refusal.

// Where the awaiting-seat set lives. Rewritten whole each tick, so a PR a human merged or
// closed stops appearing with no expiry mechanism. capsid_read_status reads this key rather
// than calling GitHub.
export const AWAITING_SEAT_KEY = "improve:awaiting-seat";

export interface AwaitingSeat {
  namespace: string;
  repo: string;
  number: number;
  failed: string;
  why: string;
  at: string;
  // Report-only (docs/design/design-merge-pipeline.md, PR 2): the class, its path class
  // and why. Absent on sets written before this field, and null when unclassified.
  class?: MergeClass | null;
  path_class?: PathClass | null;
  class_reasons?: string[];
  // The head the tick judged (absent on sets written before this field). The Portal's
  // Approve sends it as the sha Dustin approved, so a later push voids the approval.
  head_sha?: string;
  visual?: VisualPr;
}

export interface AutoMergeReport {
  ran: boolean;
  note: string;
  policy_version: string | null;
  outcomes: AutoMergeOutcome[];
}

/** One pass over every open PR on every namespace the policy covers. */
export async function autoMergeTick(env: Env, now: Date): Promise<AutoMergeReport> {
  const loaded = await loadMergePolicy(env);
  if ("error" in loaded)
    return { ran: false, note: loaded.error, policy_version: null, outcomes: [] };
  const policy = loaded.policy;
  if (!policy.enabled) {
    return {
      ran: false,
      note: `merge policy ${policy.version} is present and disabled, so nothing is auto-merged.`,
      policy_version: policy.version,
      outcomes: [],
    };
  }

  const outcomes: AutoMergeOutcome[] = [];

  // The merge units a rollback suspended (src/merge-units.ts). A suspension only narrows,
  // so a list that cannot be read holds every unit back this tick rather than none.
  let suspended: Suspended;
  try {
    suspended = new Set((await readSuspended(env.APP_KV)).map((s) => s.unit));
  } catch (err) {
    logEvent(
      "AUTO_MERGE",
      {
        message: `AUTO_MERGE could not read the suspended merge units, so nothing merges unattended this tick: ${errorMessage(err)}`,
      },
      { level: "error" },
    );
    suspended = "all";
  }

  // The namespaces the safety shutoff paused: the same rule, an unreadable value pauses
  // every namespace this tick.
  let paused: PausedNamespaces;
  try {
    paused = new Map(Object.entries(await readPaused(env.APP_KV)).map(([ns, p]) => [ns, p.reason]));
  } catch (err) {
    logEvent(
      "AUTO_MERGE",
      {
        message: `AUTO_MERGE could not read the paused namespaces, so nothing merges unattended this tick: ${errorMessage(err)}`,
      },
      { level: "error" },
    );
    paused = "all";
  }

  for (const namespace of policy.namespaces) {
    let owner: string;
    let repo: string;
    let defaultBranch: string;
    let prs: OpenPr[];
    // The open approvals on this repo (src/pr-approvals.ts). A failed read (table not migrated)
    // leaves none, so nothing merges on an approval that could not be read.
    let approvals = new Map<number, OpenApproval>();
    // A namespace that cannot be read is skipped, not the whole tick: a throw would stop every
    // later namespace and the awaiting-seat write.
    try {
      ({ owner, repo } = await resolveRepo(env, namespace));
      defaultBranch = await getDefaultBranch(env, owner, repo);
      // Every page, so a PR past the first hundred is judged and stays in the seat's
      // queue. A list that cannot be read whole skips the namespace.
      const listedPrs = await listOpenPrs(env, owner, repo);
      if (typeof listedPrs === "string") {
        logEvent(
          "AUTO_MERGE",
          { message: `AUTO_MERGE could not list PRs on ${owner}/${repo} (${listedPrs})` },
          { level: "error" },
        );
        continue;
      }
      prs = listedPrs;
      try {
        approvals = await readOpenApprovals(env.DB, `${owner}/${repo}`);
      } catch (err) {
        logEvent(
          "AUTO_MERGE",
          {
            message: `AUTO_MERGE could not read the approvals on ${owner}/${repo}: ${errorMessage(err)}`,
          },
          { level: "error" },
        );
      }
    } catch (err) {
      logEvent(
        "AUTO_MERGE",
        {
          message: `AUTO_MERGE could not read ${namespace}: ${errorMessage(err)}`,
        },
        { level: "error" },
      );
      continue;
    }

    for (const pr of prs) {
      // A PR whose body names no job is declined before any GitHub read when its namespace has no
      // promoted unit (the reads share the rate limit). With one, its files are read so the PR can
      // merge on the unit (policy version 10). A visual or approved PR is judged all the same:
      // body_names_job leaves it class approve, so his approval merges it on green CI.
      const visual = isVisual(pr);
      const hasUnit = policy.units.some((u) => u.startsWith(`${namespace} / `));
      if (!jobIdFromBody(pr.body ?? "") && !visual && !approvals.has(pr.number) && !hasUnit) {
        const skipped = {
          failed: "body_names_job" as const,
          why: "the PR body names no job id, and no unit in its namespace has earned unattended merging, so a person approves it. Its files and checks were not read.",
          passed: [] as PolicyCheck[],
        };
        outcomes.push({
          namespace,
          repo: `${owner}/${repo}`,
          number: pr.number,
          merged: false,
          head_sha: pr.head.sha,
          ...skipped,
        });
        try {
          const skippedFacts = {
            repo: `${owner}/${repo}`,
            number: pr.number,
            headSha: pr.head.sha,
          };
          await auditDeclineOnChange(
            env,
            skippedFacts,
            skipped.failed,
            systemAudit(
              env.DB,
              "auto-merge-declined",
              namespace,
              declineParams(policy.version, skippedFacts, skipped, now),
            ),
          );
        } catch (err) {
          logEvent(
            "AUTO_MERGE",
            {
              message: `AUTO_MERGE could not audit the decline of ${owner}/${repo}#${pr.number}: ${errorMessage(err)}`,
            },
            { level: "error" },
          );
        }
        continue;
      }
      // One PR that throws does not end the tick (a 405, a failed read, a D1 error would abort
      // every later PR, leave no audit row and skip the awaiting-seat write). It is reported as not
      // merged with the error.
      const before = outcomes.length;
      try {
        try {
          await judgeOnePr(
            env,
            policy.version,
            policy.authors,
            namespace,
            owner,
            repo,
            defaultBranch,
            pr,
            outcomes,
            now,
            approvals.get(pr.number) ?? null,
            suspended,
            policy.units,
            paused,
            visual,
          );
        } catch (err) {
          const why = errorMessage(err);
          logEvent(
            "AUTO_MERGE",
            { message: `AUTO_MERGE failed on ${owner}/${repo}#${pr.number}: ${why}` },
            { level: "error" },
          );
          // An outcome already pushed is the true one; only its audit row failed.
          if (outcomes.length > before) continue;
          outcomes.push({
            namespace,
            repo: `${owner}/${repo}`,
            number: pr.number,
            merged: false,
            failed: "error",
            why: `the tick could not judge or merge this PR: ${why}`,
            passed: [],
          });
          try {
            await env.DB.batch([
              systemAudit(env.DB, "auto-merge-failed", namespace, {
                policy_version: policy.version,
                repo: `${owner}/${repo}`,
                pr: pr.number,
                head_sha: pr.head.sha,
                error: why,
                at: now.toISOString(),
              }),
            ]);
          } catch (auditErr) {
            logEvent(
              "AUTO_MERGE",
              {
                message: `AUTO_MERGE could not audit the failure on ${owner}/${repo}#${pr.number}: ${errorMessage(auditErr)}`,
              },
              { level: "error" },
            );
          }
        }
      } finally {
        for (let k = before; k < outcomes.length; k++) {
          outcomes[k]!.head_sha ??= pr.head.sha;
          if (visual && !outcomes[k]!.merged) outcomes[k]!.visual = visualDetails(pr);
        }
      }
    }
  }

  // An approval on a pull request the tick no longer sees (closed or merged by hand) is
  // expired at 7 days here, since the executor sees only open pull requests.
  try {
    await expireStaleApprovals(env, now);
  } catch (err) {
    logEvent(
      "AUTO_MERGE",
      {
        message: `AUTO_MERGE could not expire old approvals: ${errorMessage(err)}`,
      },
      { level: "error" },
    );
  }

  // The full awaiting-seat set, written whole, and written even when it is empty, so a
  // tick that cleared the last one leaves no stale entry behind.
  const awaiting: AwaitingSeat[] = outcomes
    .filter((o) => !o.merged)
    .map((o) => ({
      namespace: o.namespace,
      repo: o.repo,
      number: o.number,
      failed: o.failed ?? "unknown",
      why: o.why ?? "",
      at: now.toISOString(),
      class: o.merge_class?.class ?? null,
      path_class: o.merge_class?.path_class ?? null,
      class_reasons: o.merge_class?.reasons ?? [],
      ...(o.head_sha ? { head_sha: o.head_sha } : {}),
      ...(o.visual ? { visual: o.visual } : {}),
    }));
  try {
    await env.APP_KV.put(AWAITING_SEAT_KEY, JSON.stringify(awaiting));
  } catch (err) {
    logEvent(
      "AUTO_MERGE",
      {
        message: `AUTO_MERGE could not record the awaiting-seat set: ${errorMessage(err)}`,
      },
      { level: "error" },
    );
  }

  const merged = outcomes.filter((o) => o.merged).length;
  return {
    ran: true,
    note: `policy ${policy.version}: ${merged} merged, ${outcomes.length - merged} left for the seat`,
    policy_version: policy.version,
    outcomes,
  };
}
