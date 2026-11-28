import { isMoneyPath } from "./scope";

// Which changed files are worth a second reader (the D5 reviewer, src/review.ts) and how a path is
// classed for merging (src/merge-class.ts).

// The sources that judge a change or ship beside it: a diff here is worth a second reader.
export const JUDGE_PATHS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^src\/protected-paths\.ts$/i, why: "the protected path list" },
  // The sources the checks read their answers from, not only the ones that run them: otherwise a
  // green driver PR weakens the source and the next PR passes the check it weakened.
  {
    pattern: /^src\/scope(-[a-z]+)*\.ts$/i,
    why: "isMoneyPath, which is the whole of the paths_not_money check",
  },
  {
    pattern: /^src\/auth\.ts$/i,
    why: "the HMAC and the constant-time comparisons",
  },
  {
    pattern: /^src\/encoding\.ts$/i,
    why: "the hex encoding signatures are compared in",
  },
  {
    pattern: /^src\/github\/client\.ts$/i,
    why: "the reader that supplies the changed paths and the CI facts every check judges",
  },
  { pattern: /^\.github\/workflows\//i, why: "any workflow, which is what CI runs" },
  {
    pattern: /^scripts\/check-[^/]*\.mjs$/i,
    why: "a check script, which is what the Gates step runs",
  },
  { pattern: /^scripts\/lib\//i, why: "the library those check scripts read their rules from" },
  { pattern: /(^|\/)\.aislop\//i, why: "the slop checker's word lists and allowances" },
  { pattern: /(^|\/)workers\//i, why: "a worker that ships beside the site" },
  { pattern: /(^|\/)package-lock\.json$/i, why: "the lockfile CI installs from" },
  { pattern: /(^|\/)migrations\//i, why: "a migration, which runs against the live database" },
  { pattern: /(^|\/)wrangler\.(jsonc?|toml)(\.example)?$/i, why: "deployment configuration" },
  { pattern: /(^|\/)\.dev\.vars/i, why: "a secrets file" },
  { pattern: /(^|\/)\.env($|\.)/i, why: "a secrets file" },
  { pattern: /^package\.json$/i, why: "the npm scripts CI runs as the checks" },
  { pattern: /(^|\/)tsconfig[^/]*\.json$/i, why: "what the typechecks check" },
  { pattern: /(^|\/)vitest\.config\.[cm]?[jt]s$/i, why: "the integration suite's configuration" },
  { pattern: /^scripts\/test-budget\.mjs$/i, why: "the runner behind npm test" },
  {
    pattern: /^scripts\/verify-live\.mjs$/i,
    why: "the live gate, whose rollback is the backstop for a merge",
  },
  { pattern: /(^|\/)scripts\//i, why: "a script CI, a build or a deploy runs" },
  { pattern: /(^|\/)\.github\//i, why: "CI configuration beyond the workflows" },
  {
    pattern: /(^|\/)package\.json$/i,
    why: "a nested package manifest, whose scripts and dependencies an install runs",
  },
  {
    pattern: /(^|\/)(pnpm-workspace\.yaml|\.pnpmfile\.cjs|\.yarnrc[^/]*)$/i,
    why: "install configuration or a hook that runs during install",
  },
  { pattern: /(^|\/)\.npmrc$/i, why: "npm registry and install-script policy" },
  { pattern: /(^|\/)Dockerfile[^/]*$/i, why: "the image a build runs in" },
  { pattern: /(^|\/)Makefile$/i, why: "build glue CI executes" },
  { pattern: /(^|\/)\.husky\//i, why: "a git hook CI may run" },
  { pattern: /(^|\/)\.gitmodules$/i, why: "submodules the checkout would fetch and run" },
];

export interface ChangedFile {
  filename: string;
  previous_filename?: string;
  status?: string;
  deletions?: number;
}

const BACKUP_PATH = /(^|\/)(backups?|restore[-_a-z]*|dump[-_a-z]*)(\/|[-_.]|$)/i;

// Only code is judged: a document, image, test, lockfile or JSON manifest is never the reason on
// its own.
const CODE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|sql|sh)$/i;
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
export const TEST_FILE =
  /(^|\/)(test|tests|test-integration|e2e|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;

// The sources that hold this repo's invariants and credentials, beside JUDGE_PATHS (the snapshot, one enforcement point and path mutation
// invariants, test/write-invariants.test.ts, test/scope.test.ts and
// test/path-mutation.test.ts, and the login and key paths).
const GUARD_SOURCES: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  {
    pattern: /^src\/store-guards\.ts$/i,
    why: "the snapshot and audit guard every overwrite and delete runs through",
  },
  { pattern: /^src\/tools\/repo\.ts$/i, why: "guardedWrite, the one gate on repo mutations" },
  { pattern: /^src\/tools\/docs\.ts$/i, why: "pathMutation, the only way a path changes" },
  {
    pattern: /^src\/(access-login|portal-auth)\.ts$/i,
    why: "a login or session check",
  },
  { pattern: /^src\/agents(-admin)?\.ts$/i, why: "the minting and grants of agent credentials" },
];

export interface ReviewWorthiness {
  level: "worth" | "skip" | "unread";
  reasons: string[];
  files_read: number;
}

/**
 * Whether a pull request's diff is worth a second reader: code that is money, a judge on
 * JUDGE_PATHS, a guard or credential source, a migration, a workflow, or backup and
 * restore code. No files is "unread", never "skip".
 */
export function worthReviewer(files: readonly ChangedFile[]): ReviewWorthiness {
  if (files.length === 0)
    return { level: "unread", reasons: ["no changed files were read"], files_read: 0 };
  const reasons = new Set<string>();
  for (const file of files) {
    for (const path of file.previous_filename
      ? [file.previous_filename, file.filename]
      : [file.filename]) {
      const workflow = WORKFLOW_FILE.test(path);
      if (!workflow && (!CODE_FILE.test(path) || TEST_FILE.test(path))) continue;
      if (workflow) {
        reasons.add(`${path} is a workflow, which holds CI's permissions and secrets`);
        continue;
      }
      if (isMoneyPath(path)) reasons.add(`${path} is billing or payment code`);
      const judge = JUDGE_PATHS.find(({ pattern }) => pattern.test(path));
      if (judge) reasons.add(`${path} is ${judge.why}`);
      const guard = GUARD_SOURCES.find(({ pattern }) => pattern.test(path));
      if (guard) reasons.add(`${path} is ${guard.why}`);
      if (BACKUP_PATH.test(path) && /^(src|scripts)\//i.test(path))
        reasons.add(`${path} is backup or restore code`);
    }
  }
  return {
    level: reasons.size ? "worth" : "skip",
    reasons: [...reasons].slice(0, 12),
    files_read: files.length,
  };
}
