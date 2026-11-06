import type { Env } from "../env";
import { TEST_FILE } from "../merge-class";
import { ghFetch } from "./client";

// The one reader of a pull request's changed files. The auto-merge tick judges them
// (src/auto-merge-tick.ts) and block and complete compare them across open pull requests
// (src/job-overlaps.ts); a second reader would disagree about a cap or a rename.

// Paged GitHub lists are read to the end, and a list not read whole is reported rather
// than judged. Bounded: GitHub serves at most FILES_LIMIT files for a pull request, and
// callers pass their own page cap for other lists. The next page is requested by number;
// the Link header only says one exists, so its URL never reaches ghFetch.
export const PER_PAGE = 100;
export const FILES_LIMIT = 3000;
const FILES_MAX_PAGES = FILES_LIMIT / PER_PAGE;

export async function readAllPages<T>(
  env: Env,
  owner: string,
  repo: string,
  path: string,
  rowsOf: (body: unknown) => T[],
  maxPages: number
): Promise<{ items: T[]; problem: string | null }> {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const resp = await ghFetch(env, owner, repo, `${path}${path.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${page}`);
    if (!resp.ok) return { items, problem: `page ${page} returned ${resp.status}` };
    items.push(...(rowsOf(await resp.json()) ?? []));
    if (!/rel="next"/.test(resp.headers.get("Link") ?? "")) return { items, problem: null };
  }
  return { items, problem: `more than ${maxPages} pages` };
}

// A commit's check runs, read whole (readAllPages), shared by the auto-merge tick, what's
// next, the maintenance sweep and complete's CI gate (src/complete-ci.ts).
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
  maxPages: number
): Promise<{ items: T[]; problem: string | null }> {
  return readAllPages<T>(env, owner, repo, `/repos/${owner}/${repo}/commits/${sha}/check-runs`, (page) => (page as { check_runs: T[] }).check_runs, maxPages);
}

export interface PrFiles {
  // A rename is listed under both names, so moving a file counts as touching the old path.
  paths: string[];
  // Why the list is not the whole of the pull request's files, or null when it is.
  problem: string | null;
  // Additions plus deletions across the files read, as GitHub counts them, or null when a
  // file came back without its counts. Auto-merge's size cap reads it
  // (src/auto-merge-policy.ts), and refuses a null rather than reading it as zero.
  changedLines: number | null;
  // The existing tests the pull request changes (existingTestEdits below). Auto-merge
  // never merges one unattended (src/merge-class.ts).
  testEdits: string[];
  // The rows as GitHub listed them, with each file's status and a rename's old name. The
  // stale canon check reads what was removed or renamed (src/stale-canon.ts).
  rows: PrFileRow[];
}

export interface PrFileRow {
  filename: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  // The unified diff of the file, which GitHub leaves out for a binary or very large one.
  patch?: string;
}

// Where the tests live: capsid's three directories, and anything merge-class names a test
// (tests/, __tests__/, e2e/, *.test.* and *.spec.*), which is what the other covered repos use.
const TEST_DIRS = ["test/", "test-integration/", "dashboard/e2e/"];
export const inTestDir = (path: string | undefined) => path !== undefined && (TEST_DIRS.some((d) => path.startsWith(d)) || TEST_FILE.test(path));

/** The tests a pull request changes that already exist: a test removed or renamed away
 *  (the old path is deleted), or any file there with a deleted line. A file added whole,
 *  or modified with only added lines, is new test code and not an edit. Fails closed: a
 *  file under a test directory with no status, or with no integer deletions, counts as
 *  an edit, since a test cannot be shown untouched. Pure. */
export function existingTestEdits(files: readonly PrFileRow[]): string[] {
  const edited: string[] = [];
  for (const f of files) {
    // A rename is a deletion of the old path whichever directory the new one is in.
    const path = inTestDir(f.previous_filename) ? f.previous_filename! : inTestDir(f.filename) ? f.filename : null;
    if (path === null) continue;
    if (f.status === "added") continue;
    const pureAdditions = f.status === "modified" && Number.isInteger(f.deletions) && f.deletions === 0;
    if (!pureAdditions) edited.push(path);
  }
  return edited;
}

export async function readPrFiles(env: Env, owner: string, repo: string, number: number): Promise<PrFiles> {
  const files = await readAllPages<PrFileRow>(
    env, owner, repo, `/repos/${owner}/${repo}/pulls/${number}/files`,
    (page) => page as PrFileRow[], FILES_MAX_PAGES
  );
  // A list that reached FILES_LIMIT may have been cut by GitHub with no next page.
  const problem = files.problem ?? (files.items.length >= FILES_LIMIT ? `GitHub lists at most ${FILES_LIMIT} files for a pull request and this one reached that` : null);
  const paths = files.items.flatMap((f) => (f.previous_filename ? [f.previous_filename, f.filename] : [f.filename]));
  const counted = files.items.every((f) => Number.isInteger(f.additions) && Number.isInteger(f.deletions));
  const changedLines = counted ? files.items.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0) : null;
  return { paths, problem, changedLines, testEdits: existingTestEdits(files.items), rows: files.items };
}
