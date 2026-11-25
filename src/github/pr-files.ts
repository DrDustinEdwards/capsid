import type { RepoEnv as Env } from "../env";
import { TEST_FILE } from "../model-routing";
import { readAllPages as readPages } from "@dustinedwards/site-runtime/github";
import { ghFetch } from "./client";

// The one reader of a pull request's changed files: a second reader would disagree about a cap or a
// rename.

// A list not read whole is reported rather than judged.
export const PER_PAGE = 100;
export const FILES_LIMIT = 3000;
const FILES_MAX_PAGES = FILES_LIMIT / PER_PAGE;

export function readAllPages<T>(
  env: Env,
  owner: string,
  repo: string,
  path: string,
  rowsOf: (body: unknown) => T[],
  maxPages: number,
): Promise<{ items: T[]; problem: string | null }> {
  return readPages<T>((p) => ghFetch(env, owner, repo, p), path, {
    rowsOf,
    maxPages,
    perPage: PER_PAGE,
  });
}

export interface CheckRunRow {
  name: string;
  status: string;
  conclusion: string | null;
}

export async function readCheckRuns<T extends CheckRunRow = CheckRunRow>(
  env: Env,
  owner: string,
  repo: string,
  sha: string,
  maxPages: number,
): Promise<{ items: T[]; problem: string | null }> {
  return readAllPages<T>(
    env,
    owner,
    repo,
    `/repos/${owner}/${repo}/commits/${sha}/check-runs`,
    (page) => (page as { check_runs: T[] }).check_runs,
    maxPages,
  );
}

export interface PrFiles {
  paths: string[];
  problem: string | null;
  // Null when a file came back without counts; auto-merge's size cap refuses null rather than
  // reading zero.
  changedLines: number | null;
  testEdits: string[];
  rows: PrFileRow[];
}

export interface PrFileRow {
  filename: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

const TEST_DIRS = ["test/", "test-integration/", "dashboard/e2e/"];
export const inTestDir = (path: string | undefined) =>
  path !== undefined && (TEST_DIRS.some((d) => path.startsWith(d)) || TEST_FILE.test(path));

/**
 * Fails closed: a test-dir file with no status or no integer deletions counts as an edit, since it
 * cannot be shown untouched.
 */
export function existingTestEdits(files: readonly PrFileRow[]): string[] {
  const edited: string[] = [];
  for (const f of files) {
    const path = inTestDir(f.previous_filename)
      ? f.previous_filename!
      : inTestDir(f.filename)
        ? f.filename
        : null;
    if (path === null) continue;
    if (f.status === "added") continue;
    const pureAdditions =
      f.status === "modified" && Number.isInteger(f.deletions) && f.deletions === 0;
    if (!pureAdditions) edited.push(path);
  }
  return edited;
}

export async function readPrFiles(
  env: Env,
  owner: string,
  repo: string,
  number: number,
): Promise<PrFiles> {
  const files = await readAllPages<PrFileRow>(
    env,
    owner,
    repo,
    `/repos/${owner}/${repo}/pulls/${number}/files`,
    (page) => page as PrFileRow[],
    FILES_MAX_PAGES,
  );
  // A list that reached FILES_LIMIT may have been cut by GitHub with no next page.
  const problem =
    files.problem ??
    (files.items.length >= FILES_LIMIT
      ? `GitHub lists at most ${FILES_LIMIT} files for a pull request and this one reached that`
      : null);
  const paths = files.items.flatMap((f) =>
    f.previous_filename ? [f.previous_filename, f.filename] : [f.filename],
  );
  const counted = files.items.every(
    (f) => Number.isInteger(f.additions) && Number.isInteger(f.deletions),
  );
  const changedLines = counted
    ? files.items.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0)
    : null;
  return {
    paths,
    problem,
    changedLines,
    testEdits: existingTestEdits(files.items),
    rows: files.items,
  };
}
