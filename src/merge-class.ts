import { AUTO_MERGE_REFUSED_PATHS, type PrFacts, type PolicyVerdict } from "./auto-merge-policy";
import { worthReviewer } from "./model-routing";
import { isMoneyPath } from "./scope";

// THE MERGE CLASSES (docs/design/design-merge-pipeline.md section 2; Dustin ruled DECIDE 2
// on 2026-10-09). Every open pull request on a covered repo gets exactly one class, with
// its reasons, computed each tick by this pure function. REPORT-ONLY for now (the design's
// PR 2): the class rides on the awaiting-seat set and the inbox, and nothing acts on it.
// The approval record (PR 3) and the executor (PR 4) are what will.
//
//   auto     passes every check of the signed policy: the tick merges it
//   approve  fails only on rules a person may waive: one tap, batchable
//   typed    any money path: a typed confirmation, never batched, never automatic
//   seat     needs a step outside a merge: a migration, a workflow, a fork head, a base
//            that is not the default branch, a file list that could not be read
//   wait     CI has not finished, or the PR is a draft: nobody acts yet
//
// Money is decided before anything else, so no other rule can move a money PR out of
// typed (design section 8, "the permanent exception").

const MERGE_CLASSES = ["auto", "approve", "typed", "seat", "wait"] as const;
export type MergeClass = (typeof MERGE_CLASSES)[number];

// The path classes, least risky first: a PR's path class is the riskiest of its files'.
const PATH_CLASSES = ["docs", "dashboard-css", "tests", "dashboard-code", "deps-own", "src-routine", "deps-other", "src-worth", "workflow", "migration", "money"] as const;
export type PathClass = (typeof PATH_CLASSES)[number];

export interface Classification {
  class: MergeClass;
  path_class: PathClass | null;
  reasons: string[];
}

const TEST_FILE = /(^|\/)(test|tests|test-integration|e2e|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
const DEPS_FILE = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i;
const DOC_FILE = /\.(md|mdx|txt|png|jpe?g|gif|svg|webp)$/i;

/** One file's path class. */
export function pathClassOf(path: string): PathClass {
  if (isMoneyPath(path)) return "money";
  if (/(^|\/)migrations\/[^/]+\.sql$/i.test(path)) return "migration";
  if (/^\.github\/workflows\//i.test(path)) return "workflow";
  // Which dependency changed is in the diff, not the path, so a manifest or lockfile is
  // judged as another's package until the diff is read (deps-own, job_3b09752450c1).
  // Before the refused list, which names lockfiles for a different reason.
  if (DEPS_FILE.test(path)) return "deps-other";
  if (AUTO_MERGE_REFUSED_PATHS.some(({ pattern }) => pattern.test(path))) return "src-worth";
  if (TEST_FILE.test(path)) return "tests";
  if (/^dashboard\/.*\.css$/i.test(path)) return "dashboard-css";
  if (/^dashboard\//i.test(path)) return "dashboard-code";
  if (/^docs\//i.test(path) || DOC_FILE.test(path)) return "docs";
  return worthReviewer([{ filename: path }]).level === "worth" ? "src-worth" : "src-routine";
}

/** The riskiest path class among `paths`, or null for none. */
export function pathClassOfAll(paths: readonly string[]): PathClass | null {
  let worst = -1;
  for (const p of paths) worst = Math.max(worst, PATH_CLASSES.indexOf(pathClassOf(p)));
  return worst < 0 ? null : PATH_CLASSES[worst];
}

/** The class of one pull request, from the facts the tick read and the policy's verdict. */
export function mergeClass(facts: PrFacts, verdict: PolicyVerdict, draft = false): Classification {
  const paths = facts.changedPaths;
  const path_class = facts.filesProblem ? null : pathClassOfAll(paths);
  const money = paths.filter(isMoneyPath);
  if (money.length) return { class: "typed", path_class, reasons: [`${money.slice(0, 3).join(", ")} ${money.length === 1 ? "is a money path" : "are money paths"}: typed confirmation only`] };
  if (draft) return { class: "wait", path_class, reasons: ["the PR is a draft"] };
  if (facts.ciConclusion === null || facts.ciConclusion === "pending") return { class: "wait", path_class, reasons: [`CI has not finished: ${facts.ciNote}`] };
  if (verdict.merge) return { class: "auto", path_class, reasons: ["passes every check of the signed policy"] };
  const seat: string[] = [];
  if (facts.filesProblem) seat.push(`the changed files could not be read whole: ${facts.filesProblem}`);
  const byClass = (c: PathClass) => paths.filter((p) => pathClassOf(p) === c);
  if (byClass("migration").length) seat.push(`a migration (${byClass("migration")[0]}) is applied by the seat`);
  if (byClass("workflow").length) seat.push(`a workflow (${byClass("workflow")[0]}) needs the App's workflows permission to merge`);
  if (facts.headRepo === null || facts.headRepo.toLowerCase() !== facts.repo.toLowerCase()) seat.push("the head is not on the base repo");
  if (facts.baseRef !== facts.defaultBranch) seat.push(`the base is ${facts.baseRef}, not the default branch ${facts.defaultBranch}`);
  if (seat.length) return { class: "seat", path_class, reasons: seat };
  const reasons = [`the policy stops at ${verdict.failed}: ${verdict.why}`];
  if (facts.ciConclusion !== "success") reasons.push(`CI is ${facts.ciConclusion}: an approval waits for green`);
  return { class: "approve", path_class, reasons };
}
