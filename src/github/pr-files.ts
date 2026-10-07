import type { Env } from "../env";
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

export interface PrFiles {
  // A rename is listed under both names, so moving a file counts as touching the old path.
  paths: string[];
  // Why the list is not the whole of the pull request's files, or null when it is.
  problem: string | null;
}

export async function readPrFiles(env: Env, owner: string, repo: string, number: number): Promise<PrFiles> {
  const files = await readAllPages<{ filename: string; previous_filename?: string }>(
    env, owner, repo, `/repos/${owner}/${repo}/pulls/${number}/files`,
    (page) => page as Array<{ filename: string; previous_filename?: string }>, FILES_MAX_PAGES
  );
  // A list that reached FILES_LIMIT may have been cut by GitHub with no next page.
  const problem = files.problem ?? (files.items.length >= FILES_LIMIT ? `GitHub lists at most ${FILES_LIMIT} files for a pull request and this one reached that` : null);
  const paths = files.items.flatMap((f) => (f.previous_filename ? [f.previous_filename, f.filename] : [f.filename]));
  return { paths, problem };
}
