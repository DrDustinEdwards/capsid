import { unitKey } from "./merge-units";
import type { Env } from "./env";
import { existingTestReason, mergeClass, pathClassOfAll, type Classification } from "./merge-class";
import { HeadMovedError, managePr } from "./github/refs";
import { systemAudit } from "./doc-statements";
import type { PolicyCheck } from "./auto-merge-policy";
import { type PrFacts, evaluatePolicy } from "./auto-merge-policy-evaluate";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import type { VisualPr } from "./visual-pr";
import { closeAsAutoMerged, executeApproval, type OpenApproval } from "./approval-executor";
import { factsForPr, type OpenPr } from "./auto-merge-tick-facts";

// Judge one pull request, merge it when the policy passes, and audit the decision.

function declineParams(
  policyVersion: string,
  facts: Pick<PrFacts, "repo" | "number" | "headSha">,
  verdict: {
    failed:
      | PolicyCheck
      | "head_moved"
      | "unit_suspended"
      | "namespace_paused"
      | "changes_existing_test"
      | "visual_awaits_look"
      | "pr_is_draft";
    why: string;
    passed: PolicyCheck[];
  },
  now: Date,
): Record<string, unknown> {
  return {
    policy_version: policyVersion,
    repo: facts.repo,
    pr: facts.number,
    head_sha: facts.headSha,
    failed: verdict.failed,
    why: verdict.why,
    passed: verdict.passed,
    at: now.toISOString(),
  };
}

function mergeParams(
  policyVersion: string,
  facts: PrFacts,
  passed: PolicyCheck[],
  mergeSha: string | null,
  now: Date,
  // The merge unit's path class (src/merge-units.ts), so a later rollback of this merge can be
  // traced to its unit.
  pathClass: string | null = null,
): Record<string, unknown> {
  return {
    policy_version: policyVersion,
    path_class: pathClass,
    repo: facts.repo,
    pr: facts.number,
    head_sha: facts.headSha,
    merge_sha: mergeSha,
    passed,
    at: now.toISOString(),
  };
}

// A decline is logged when the decision for that PR changes, not on every look (a PR kept refused
// was logged about 1,400 times a day). `why` is not in the key: it carries counts and times that
// move without the decision moving.
const LAST_DECLINE_PREFIX = "improve:auto-merge-last-decline:";
const LAST_DECLINE_TTL_SECONDS = 14 * 24 * 60 * 60;

/**
 * Audit a decline unless the same PR was already logged with this head sha and check. A KV failure
 * logs the row anyway: a repeated row is better than a lost one.
 */
async function auditDeclineOnChange(
  env: Env,
  facts: { repo: string; number: number; headSha: string },
  failed: string,
  statement: D1PreparedStatement,
): Promise<void> {
  const key = `${LAST_DECLINE_PREFIX}${facts.repo}#${facts.number}`;
  const decision = `${facts.headSha} ${failed}`;
  try {
    if ((await env.APP_KV.get(key)) === decision) return;
  } catch (err) {
    logEvent(
      "AUTO_MERGE",
      {
        message: `AUTO_MERGE could not read the last decline of ${key}: ${errorMessage(err)}`,
      },
      { level: "error" },
    );
  }
  // The row first, so a failed KV write repeats a row on the next tick rather than losing one.
  await env.DB.batch([statement]);
  try {
    await env.APP_KV.put(key, decision, { expirationTtl: LAST_DECLINE_TTL_SECONDS });
  } catch (err) {
    logEvent(
      "AUTO_MERGE",
      {
        message: `AUTO_MERGE could not record the last decline of ${key}: ${errorMessage(err)}`,
      },
      { level: "error" },
    );
  }
}

export type Suspended = ReadonlySet<string> | "all";
export type PausedNamespaces = ReadonlyMap<string, string> | "all";

export interface AutoMergeOutcome {
  namespace: string;
  repo: string;
  number: number;
  merged: boolean;
  failed: string | null;
  head_sha?: string;
  why: string | null;
  passed: string[];
  // The merge pipeline's class (src/merge-class.ts), report-only; null when the PR's files were
  // never read (the tick threw first).
  merge_class?: Classification | null;
  visual?: VisualPr;
}

/**
 * Judge one PR, merge it when the policy passes, and audit either way. Pushes exactly one outcome, before its audit row, so a caller can tell a
 * PR that was judged from one that threw first.
 */
export async function judgeOnePr(
  env: Env,
  policyVersion: string,
  allowedAuthors: string[],
  namespace: string,
  owner: string,
  repo: string,
  defaultBranch: string,
  pr: OpenPr,
  outcomes: AutoMergeOutcome[],
  now: Date,
  approval: OpenApproval | null = null,
  suspended: Suspended = new Set(),
  units: readonly string[] = [],
  paused: PausedNamespaces = new Map(),
  visual = false,
): Promise<void> {
  const facts = await factsForPr(env, namespace, owner, repo, defaultBranch, pr);
  const pathClass = facts.filesProblem ? null : pathClassOfAll(facts.changedPaths);
  const promotedUnit =
    pathClass && units.includes(`${namespace} / ${pathClass}`)
      ? { unit: `${namespace} / ${pathClass}` }
      : null;
  const verdict = evaluatePolicy(facts, allowedAuthors, promotedUnit);
  let merge_class = mergeClass(facts, verdict, pr.draft === true);
  // Five holds that only narrow. A draft waits as class wait. The other four leave the PR for Dustin
  // as class approve (his approval still executes below): a visual change, an existing test it
  // changes, a paused namespace, and a unit a rollback suspended.
  const unit = merge_class.path_class ? unitKey(namespace, merge_class.path_class) : null;
  let hold: {
    failed:
      | "pr_is_draft"
      | "changes_existing_test"
      | "namespace_paused"
      | "unit_suspended"
      | "visual_awaits_look";
    reason: string;
  } | null = null;
  // A draft first, and it keeps its class wait: GitHub refuses to merge a draft with a 405, so
  // sending it would only fail.
  if (verdict.merge && pr.draft === true) {
    hold = {
      failed: "pr_is_draft",
      reason: "the PR is a draft: it is judged again once it is marked ready for review",
    };
  } else if (verdict.merge && visual) {
    hold = {
      failed: "visual_awaits_look",
      reason: "a visual change: Dustin looks at its preview or screenshots before it merges",
    };
  } else if (verdict.merge && facts.existingTestEdits.length > 0) {
    hold = { failed: "changes_existing_test", reason: existingTestReason(facts.existingTestEdits) };
  } else if (verdict.merge && (paused === "all" || paused.has(namespace))) {
    hold = {
      failed: "namespace_paused",
      reason:
        paused === "all"
          ? "the paused namespaces could not be read, so nothing merges unattended this tick"
          : `auto-merge for ${namespace} is paused: ${paused.get(namespace)}`,
    };
  } else if (verdict.merge && (suspended === "all" || (unit !== null && suspended.has(unit)))) {
    hold = {
      failed: "unit_suspended",
      reason:
        suspended === "all"
          ? "the suspended merge units could not be read, so nothing merges unattended this tick"
          : `the merge unit ${unit} is suspended after a rollback`,
    };
  }
  if (hold && hold.failed !== "pr_is_draft")
    merge_class = { class: "approve", path_class: merge_class.path_class, reasons: [hold.reason] };
  const held = hold !== null;
  const merges = verdict.merge && !held;
  // The executor (docs/design/design-merge-pipeline.md section 4): a PR the policy leaves open but
  // Dustin approved merges here once CI is green on the approved sha, or its approval is voided,
  // expired or refused. Not for a draft.
  if (!merges && approval && pr.draft !== true) {
    const done = await executeApproval(env, namespace, facts, merge_class, approval, now);
    if (done.done === "merged") {
      outcomes.push({
        namespace,
        repo: facts.repo,
        number: pr.number,
        merged: true,
        failed: null,
        why: done.why,
        passed: verdict.passed,
        merge_class,
      });
      return;
    }
  }
  if (!verdict.merge) {
    outcomes.push({
      namespace,
      repo: facts.repo,
      number: pr.number,
      merged: false,
      failed: verdict.failed,
      why: verdict.why,
      passed: verdict.passed,
      merge_class,
    });
    await auditDeclineOnChange(
      env,
      facts,
      verdict.failed,
      systemAudit(
        env.DB,
        "auto-merge-declined",
        namespace,
        declineParams(policyVersion, facts, verdict, now),
      ),
    );
    return;
  }
  if (hold) {
    const held = { failed: hold.failed, why: hold.reason, passed: verdict.passed };
    outcomes.push({
      namespace,
      repo: facts.repo,
      number: pr.number,
      merged: false,
      ...held,
      merge_class,
    });
    await auditDeclineOnChange(
      env,
      facts,
      held.failed,
      systemAudit(
        env.DB,
        "auto-merge-declined",
        namespace,
        declineParams(policyVersion, facts, held, now),
      ),
    );
    return;
  }
  // merge_method "merge", because a squash would not keep the audited head sha. Pinned to the sha
  // the checks read: a push since then gets a 409 and the next tick judges the new head.
  let result: unknown;
  try {
    result = await managePr(env, namespace, pr.number, "merge", "merge", undefined, facts.headSha);
  } catch (err) {
    if (!(err instanceof HeadMovedError)) throw err;
    const moved = {
      failed: "head_moved" as const,
      why: `the PR head moved after the policy judged ${facts.headSha}, so GitHub refused the pinned merge. ${err.message}`,
      passed: verdict.passed,
    };
    outcomes.push({
      namespace,
      repo: facts.repo,
      number: pr.number,
      merged: false,
      ...moved,
      merge_class,
    });
    await auditDeclineOnChange(
      env,
      facts,
      moved.failed,
      systemAudit(
        env.DB,
        "auto-merge-declined",
        namespace,
        declineParams(policyVersion, facts, moved, now),
      ),
    );
    return;
  }
  outcomes.push({
    namespace,
    repo: facts.repo,
    number: pr.number,
    merged: true,
    failed: null,
    why: null,
    passed: verdict.passed,
    merge_class,
  });
  if (approval)
    await closeAsAutoMerged(
      env,
      namespace,
      facts,
      approval,
      (result as { sha?: string }).sha ?? null,
      now,
    );
  // The merge has landed and the catch does not retry a PR whose outcome is pushed, so the row the
  // safety meter and merge units read is tried a second time.
  const writeMerged = () =>
    env.DB.batch([
      systemAudit(
        env.DB,
        "auto-merged",
        namespace,
        mergeParams(
          policyVersion,
          facts,
          verdict.passed,
          (result as { sha?: string }).sha ?? null,
          now,
          merge_class.path_class,
        ),
      ),
    ]);
  try {
    await writeMerged();
  } catch {
    await writeMerged();
  }
}
