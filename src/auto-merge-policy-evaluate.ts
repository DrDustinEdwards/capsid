import { PR_URL_SOURCE } from "@dustinedwards/site-runtime/github";
import {
  allowedPathsFor,
  overSizeCap,
  refusedPathHits,
  requiredCiFor,
  requiredCiLabel,
  sizeCapReason,
  type PolicyCheck,
} from "./auto-merge-policy";
import { isMoneyPath } from "./scope";

// The pull request facts and the checks that judge them against the policy.

export interface PrFacts {
  number: number;
  repo: string;
  namespace: string;
  baseRef: string;
  defaultBranch: string;
  headSha: string;
  body: string;
  changedPaths: string[];
  // Why the changed-file list is incomplete, or null. An incomplete list refuses.
  filesProblem: string | null;
  // Additions plus deletions across the changed files, as GitHub counts them, or null
  // when a file came back without its counts, which size_within_cap refuses.
  changedLines: number | null;
  // The existing tests the pull request changes (src/github/pr-files.ts). No policy check
  // reads it: the class and the tick do, and hold such a pull request for Dustin.
  existingTestEdits: string[];
  // null when no check run has reported, which is NOT green.
  ciConclusion: string | null;
  ciNote: string;
  // The steps of the newest run of each workflow on the head sha, and why they could
  // not be read, or null.
  ciSteps: Array<{ workflow: string; job: string; step: string; conclusion: string | null }>;
  ciStepsProblem: string | null;
  // The owner/name of the repo the PR's head branch lives on, as GitHub reports it, or
  // null when GitHub reports none (a fork that was deleted).
  headRepo: string | null;
  // GitHub reports none.
  prAuthor: string | null;
  // Resolved from the job id in the PR body; jobClaimedBy is for the audit row only.
  jobId: string | null;
  jobClaimedBy: string | null;
  jobStatus: string | null;
  // Every pull request URL the job's holder recorded: result_ref and the
  // job_outcome_prs rows, all written by the transitions that complete or block a job
  // (src/jobs-holder.ts) or seeded from what they wrote.
  jobPrUrls: string[];
}

export type PolicyVerdict =
  | { merge: true; passed: PolicyCheck[] }
  | { merge: false; failed: PolicyCheck; why: string; passed: PolicyCheck[] };

const JOB_ID_IN_BODY = /\bjob_[0-9a-f]{12}\b/;

export function jobIdFromBody(body: string): string | null {
  return JOB_ID_IN_BODY.exec(body ?? "")?.[0] ?? null;
}

// The statuses in which a job has handed its PR on (done, or blocked at a gate). Any other
// status proves nothing from its id in a PR body.
const HANDED_ON_STATUSES = ["blocked", "done"];

// A PR URL as the job records hold it, compared case-insensitively. The match ends at
// the PR number, so pull/23 never matches pull/234.
const PR_URL = new RegExp(PR_URL_SOURCE, "g");

function normalizedPrUrls(text: string | null): string[] {
  return [...(text ?? "").matchAll(PR_URL)].map((m) => m[0].toLowerCase());
}

// Named separately from the refused list because their consequence is not local (a
// migration runs against the live database, a workflow measures the code, a lockfile decides
// what is installed). Removing a pattern from one list does not quietly open the other.
const MIGRATION_WORKFLOW_LOCKFILE: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /(^|\/)migrations\//i, why: "a migration, which runs against the live database" },
  { pattern: /(^|\/)\.github\/workflows\//i, why: "a workflow, which is what measures the code" },
  {
    pattern:
      /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.lock)$/i,
    why: "a lockfile, which decides what gets installed and executed",
  },
];

export function evaluatePolicy(
  facts: PrFacts,
  allowedAuthors: string[],
  // The promoted unit this PR falls in, when the signed policy lists its namespace and
  // path class under ## Auto units (the tick computes the path class). It widens only
  // paths_allowed_for_namespace: never a refused path, money, a migration or a workflow.
  promoted: { unit: string } | null = null,
): PolicyVerdict {
  const passed: PolicyCheck[] = [];
  const no = (failed: PolicyCheck, why: string): PolicyVerdict => ({
    merge: false,
    failed,
    why,
    passed: [...passed],
  });

  // A path list that was not read whole is not judged on the part that loaded: a
  // refused path on page two would merge that way.
  if (facts.filesProblem) {
    return no(
      "paths_not_refused",
      `the changed-file list is incomplete (${facts.filesProblem}), so this PR is not evaluated.`,
    );
  }
  const refused = refusedPathHits(facts.changedPaths);
  if (refused.length > 0) {
    return no(
      "paths_not_refused",
      `the change touches ${refused.length} path(s) auto-merge refuses: ${refused.map((h) => `${h.path} (${h.why})`).join("; ")}.`,
    );
  }
  passed.push("paths_not_refused");

  const money = facts.changedPaths.filter((p) => isMoneyPath(p));
  if (money.length > 0) {
    return no(
      "paths_not_money",
      `the change touches a billing or payment surface: ${money.join(", ")}.`,
    );
  }
  passed.push("paths_not_money");

  for (const path of facts.changedPaths) {
    for (const { pattern, why } of MIGRATION_WORKFLOW_LOCKFILE) {
      if (pattern.test(path)) return no("no_migration_workflow_lockfile", `${path} is ${why}.`);
    }
  }
  passed.push("no_migration_workflow_lockfile");

  // A namespace with a limit merges only a change whose every path is inside it. A PR
  // that changes no file shows nothing inside the limit, so it waits for the seat too.
  const allowedRules = allowedPathsFor(facts.namespace);
  if (allowedRules) {
    if (facts.changedPaths.length === 0) {
      return no(
        "paths_allowed_for_namespace",
        `the PR changes no file, and ${facts.namespace} merges unattended only a change inside its allowed paths.`,
      );
    }
    const outside = facts.changedPaths.filter(
      (p) => !allowedRules.some(({ pattern }) => pattern.test(p)),
    );
    if (outside.length > 0 && !promoted) {
      return no(
        "paths_allowed_for_namespace",
        `${facts.namespace} merges unattended only ${allowedRules.map((r) => r.why).join(" or ")}, and the change also touches ${outside.join(", ")}.`,
      );
    }
  }
  passed.push("paths_allowed_for_namespace");

  // A fork's head is code nobody holding a credential here pushed. GitHub reports no
  // head repo when the fork was deleted, which is refused the same way.
  if (!facts.headRepo || facts.headRepo.toLowerCase() !== facts.repo.toLowerCase()) {
    return no(
      "head_in_base_repo",
      `the PR's head is on ${facts.headRepo ?? "no repo GitHub reports"}, not on ${facts.repo}. A fork's PR waits for the seat.`,
    );
  }
  passed.push("head_in_base_repo");

  // Version 10: work comes from project threads, not the job queue,
  // so most pull requests name no job. One whose unit has earned unattended merging (a
  // promoted unit, from his recorded approvals) stands in for the job trace: the three
  // job checks pass on the unit, and every other check still applies.
  const earned = !facts.jobId && promoted !== null;
  if (!facts.jobId && !earned) {
    return no(
      "body_names_job",
      "the PR body names no job id, and its unit has not earned unattended merging, so a person approves it.",
    );
  }
  passed.push("body_names_job");

  // Case-insensitive, as GitHub treats logins. An empty allowlist matches nobody.
  const author = facts.prAuthor?.toLowerCase() ?? null;
  if (!author || !allowedAuthors.some((a) => a.toLowerCase() === author)) {
    return no(
      "pr_author_allowed",
      `the PR was opened by ${facts.prAuthor ?? "no account GitHub reports"}, which is not on the policy's author allowlist (${allowedAuthors.join(", ") || "empty"}).`,
    );
  }
  passed.push("pr_author_allowed");

  if (earned) {
    passed.push("job_handed_on", "pr_recorded_for_job");
  } else {
    if (!facts.jobStatus || !HANDED_ON_STATUSES.includes(facts.jobStatus)) {
      return no(
        "job_handed_on",
        `${facts.jobId} is ${facts.jobStatus ?? "in no status"}, not blocked or done, so it has not handed a PR on.`,
      );
    }
    passed.push("job_handed_on");

    // The PR itself must be recorded against the job, or anyone could name a finished
    // job in a PR body.
    const url = `https://github.com/${facts.repo}/pull/${facts.number}`.toLowerCase();
    if (!facts.jobPrUrls.some((recorded) => normalizedPrUrls(recorded).includes(url))) {
      return no(
        "pr_recorded_for_job",
        `${facts.jobId}'s holder never recorded this PR against it (neither its result_ref nor its outcome PRs name ${url}), so it is not shown to be that job's work.`,
      );
    }
    passed.push("pr_recorded_for_job");
  }

  if (facts.baseRef !== facts.defaultBranch) {
    return no(
      "base_is_default_branch",
      `the PR targets '${facts.baseRef}', not the default branch '${facts.defaultBranch}'.`,
    );
  }
  passed.push("base_is_default_branch");

  if (facts.changedLines === null) {
    return no(
      "size_within_cap",
      "GitHub reported no line counts for at least one changed file, so the size cap cannot be judged. A person approves it.",
    );
  }
  if (overSizeCap(facts))
    return no("size_within_cap", `${sizeCapReason(facts)}. A person approves it.`);
  passed.push("size_within_cap");

  const ci = ciGreenOn(facts);
  if (ci.state !== "green") return no("ci_green", ci.why);
  passed.push("ci_green");

  return { merge: true, passed };
}

/** The ci_green check on the head sha with the policy's required steps, shared by the policy
 *  and the approval executor (docs/design/design-merge-pipeline.md section 4). green: all
 *  succeeded. wait: CI unfinished or steps unreadable. red: failed, or a required step did not
 *  succeed. never: no required steps are written down for the namespace. */
export function ciGreenOn(
  facts: Pick<
    PrFacts,
    "headSha" | "ciConclusion" | "ciNote" | "ciStepsProblem" | "ciSteps" | "namespace"
  >,
): { state: "green" | "wait" | "red" | "never"; why: string } {
  const sha = facts.headSha.slice(0, 7);
  if (facts.ciConclusion === null || facts.ciConclusion === "pending")
    return {
      state: "wait",
      why: `CI on ${sha} is ${facts.ciConclusion ?? "not reported"}: ${facts.ciNote}`,
    };
  if (facts.ciConclusion !== "success")
    return { state: "red", why: `CI on ${sha} is ${facts.ciConclusion}: ${facts.ciNote}` };
  if (facts.ciStepsProblem) {
    return {
      state: "wait",
      why: `the CI steps on ${sha} could not be read (${facts.ciStepsProblem}), so the required suites are not shown to have run.`,
    };
  }
  const required = requiredCiFor(facts.namespace);
  if (!required) {
    return {
      state: "never",
      why: `no required CI steps are written down for namespace '${facts.namespace}', so a green run there shows nothing. It waits for the seat.`,
    };
  }
  const notRun = required.filter(
    (r) =>
      !facts.ciSteps.some(
        (s) =>
          s.workflow === r.workflow &&
          s.job === r.job &&
          s.step === r.step &&
          s.conclusion === "success",
      ),
  );
  if (notRun.length > 0)
    return {
      state: "red",
      why: `CI on ${sha} did not run ${notRun.map(requiredCiLabel).join(", ")} to success.`,
    };
  return { state: "green", why: `CI on ${sha} is green, with every required step` };
}

// Every completed check run must have concluded success, skipped or neutral, and at
// least one must have reported. A PR with no checks is not green: its workflow never
// started, which cannot be told apart from a workflow that was removed.
export function ciVerdict(
  runs: Array<{ name: string; status: string; conclusion: string | null }>,
): { conclusion: string | null; note: string } {
  if (runs.length === 0)
    return { conclusion: null, note: "no check run has reported on this commit" };
  const pending = runs.filter((r) => r.status !== "completed");
  if (pending.length > 0) {
    return {
      conclusion: "pending",
      note: `${pending.length} check(s) still running: ${pending.map((r) => r.name).join(", ")}`,
    };
  }
  const bad = runs.filter((r) => !["success", "skipped", "neutral"].includes(r.conclusion ?? ""));
  if (bad.length > 0) {
    return {
      conclusion: "failure",
      note: `${bad.map((r) => `${r.name}=${r.conclusion ?? "null"}`).join(", ")}`,
    };
  }
  return { conclusion: "success", note: `${runs.length} check(s) green` };
}
