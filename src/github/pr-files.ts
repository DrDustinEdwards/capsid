import type { RepoEnv as Env } from "../env";
import { TEST_FILE } from "../model-routing";
import { readAllPages as readPages } from "@dustinedwards/site-runtime/github";
import { ghFetch } from "./client";

// The one reader of a pull request's changed files: a second reader would disagree about a cap or a
// rename.

// A list not read whole is reported rather than judged.
const PER_PAGE = 100;
const FILES_LIMIT = 3000;
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

// Every completed check run must have concluded success, skipped or neutral, and at least one must
// have reported. A PR with no checks is not green: its workflow never started, which cannot be
// told apart from a workflow that was removed.
export function ciVerdict(runs: readonly CheckRunRow[]): {
  conclusion: string | null;
  note: string;
} {
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

const JOB_ID_IN_BODY = /\bjob_[0-9a-f]{12}\b/;

/** The Capsid job a pull request's description names, or null. */
export function jobIdFromBody(body: string): string | null {
  return JOB_ID_IN_BODY.exec(body ?? "")?.[0] ?? null;
}

export interface PrFiles {
  paths: string[];
  problem: string | null;
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
  return { paths, problem, rows: files.items };
}
