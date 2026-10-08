import type { Env } from "./env";
import { PR_URL_SOURCE, parsePrUrl, resolveRepo } from "./github/client";
import { readAllPages, readPrFiles } from "./github/pr-files";

// Overlap warnings (Track A D1, capsid/research/design-track-a.md section 1). When block or
// complete names a pull request, say which other open pull requests in the same repo change
// the same files, from the file lists GitHub reports. Stacked and parallel pull requests that
// rewrote the same function cost the seat a rebase on 2026-09-25; the warning is the moment
// to merge in order instead. It informs and never refuses: a read that fails is reported as
// "not checked", so a missing check is visible and never reads as a clean one.

// Other open pull requests read per transition. A repo with more is reported, not silently
// cut: the warning says how many it did not read.
export const OTHER_PRS_READ = 20;
const OPEN_LIST_MAX_PAGES = 5;
const FILES_SHOWN = 3;

export interface PrOverlap {
  pr: number;
  other: number;
  files: string[];
}

export interface OverlapReport {
  overlaps: PrOverlap[];
  // Why the comparison is not the whole of it, or null when every list was read.
  problem: string | null;
}

interface PrPaths {
  number: number;
  paths: string[];
}

/** The files each named pull request shares with each other pull request, the older
 *  (lower-numbered) first. A pull request named by the job is never compared with itself or
 *  with another named one: a job's own stack is not a collision. */
export function overlapsOf(named: PrPaths[], others: PrPaths[]): PrOverlap[] {
  const namedNumbers = new Set(named.map((n) => n.number));
  const found: PrOverlap[] = [];
  for (const mine of named) {
    const mineSet = new Set(mine.paths);
    for (const other of others) {
      if (namedNumbers.has(other.number)) continue;
      const files = [...new Set(other.paths.filter((p) => mineSet.has(p)))].sort();
      if (files.length > 0) found.push({ pr: mine.number, other: other.number, files });
    }
  }
  return found.sort((a, b) => Math.min(a.pr, a.other) - Math.min(b.pr, b.other) || a.pr - b.pr || a.other - b.other);
}

/** The line appended to a summary, or null when there is nothing to say. */
export function overlapLine(report: OverlapReport): string | null {
  if (report.overlaps.length === 0) return report.problem ? `Overlaps: not checked (${report.problem}).` : null;
  const parts = report.overlaps.map((o) => {
    const shown = o.files.slice(0, FILES_SHOWN).join(", ");
    const more = o.files.length > FILES_SHOWN ? `, +${o.files.length - FILES_SHOWN} more` : "";
    return `#${o.pr} with #${o.other} (${shown}${more})`;
  });
  const partial = report.problem ? ` Not fully checked (${report.problem}).` : "";
  return `Overlaps: ${parts.join(", ")}. Merge in PR order, oldest first, and rebase the later.${partial}`;
}

/** The pull request URLs in free text, such as a block command: `gh pr merge` takes a
 *  number, but a command that carries the URL names the pull request all the same. */
export function prUrlsIn(text: string | null | undefined): string[] {
  return [...new Set(text?.match(new RegExp(PR_URL_SOURCE, "g")) ?? [])];
}

/** Compare the named pull requests with every other open pull request in the namespace's
 *  repo. Null when none of `urls` is a pull request of that repo, which is the normal case
 *  for a job that opened nothing. Never throws: a failure is the report's `problem`. */
export async function checkOverlaps(env: Env, namespace: string, urls: string[]): Promise<OverlapReport | null> {
  const parsed = urls.map((u) => parsePrUrl(u)).filter((p): p is NonNullable<typeof p> => p !== null);
  if (parsed.length === 0) return null;
  try {
    const repo = await resolveRepo(env, namespace);
    const mine = parsed.filter((p) => `${p.owner}/${p.repo}`.toLowerCase() === repo.full.toLowerCase());
    if (mine.length === 0) return null;
    const numbers = [...new Set(mine.map((p) => p.number))];

    return await compare(env, repo.owner, repo.repo, numbers);
  } catch (err) {
    return { overlaps: [], problem: err instanceof Error ? err.message : String(err) };
  }
}

async function compare(env: Env, owner: string, repo: string, numbers: number[]): Promise<OverlapReport> {
  const problems: string[] = [];
  const listed = await readAllPages<{ number: number }>(
    env, owner, repo, `/repos/${owner}/${repo}/pulls?state=open`,
    (page) => page as Array<{ number: number }>, OPEN_LIST_MAX_PAGES
  );
  if (listed.problem) problems.push(`the open pull request list: ${listed.problem}`);
  const otherNumbers = listed.items.map((p) => p.number).filter((n) => !numbers.includes(n)).sort((a, b) => a - b);
  const read = otherNumbers.slice(0, OTHER_PRS_READ);
  if (otherNumbers.length > read.length) problems.push(`${otherNumbers.length - read.length} open pull requests were not read`);

  const readOne = async (number: number): Promise<PrPaths> => {
    const files = await readPrFiles(env, owner, repo, number);
    if (files.problem) problems.push(`#${number} files: ${files.problem}`);
    return { number, paths: files.paths };
  };
  const [named, others] = await Promise.all([Promise.all(numbers.map(readOne)), Promise.all(read.map(readOne))]);
  return { overlaps: overlapsOf(named, others), problem: problems.length > 0 ? problems.join("; ") : null };
}
