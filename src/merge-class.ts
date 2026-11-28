import { JUDGE_PATHS, TEST_FILE, worthReviewer } from "./model-routing";
import { isMoneyPath } from "./scope";

// The class of one changed path, which the reviewer (src/review.ts) and the CI gate on complete
// (src/complete-ci.ts) read. Money is decided first, so no other rule can move a money path out.

const PATH_CLASSES = [
  "docs",
  "dashboard-css",
  "tests",
  "dashboard-code",
  "deps-own",
  "src-routine",
  "deps-other",
  "src-worth",
  "workflow",
  "migration",
  "money",
] as const;
export type PathClass = (typeof PATH_CLASSES)[number];

const DEPS_FILE =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i;
const DOC_FILE = /\.(md|mdx|txt|png|jpe?g|gif|svg|webp)$/i;

export function pathClassOf(path: string): PathClass {
  if (isMoneyPath(path)) return "money";
  if (/(^|\/)migrations\/[^/]+\.sql$/i.test(path)) return "migration";
  if (/^\.github\/workflows\//i.test(path)) return "workflow";
  // Which dependency changed is in the diff, not the path, so a manifest or lockfile is judged as
  // another's package until the diff is read (deps-own). Before JUDGE_PATHS, which names
  // lockfiles for a different reason.
  if (DEPS_FILE.test(path)) return "deps-other";
  if (JUDGE_PATHS.some(({ pattern }) => pattern.test(path))) return "src-worth";
  if (TEST_FILE.test(path)) return "tests";
  if (/^dashboard\/.*\.css$/i.test(path)) return "dashboard-css";
  if (/^dashboard\//i.test(path)) return "dashboard-code";
  if (/^docs\//i.test(path) || DOC_FILE.test(path)) return "docs";
  return worthReviewer([{ filename: path }]).level === "worth" ? "src-worth" : "src-routine";
}
