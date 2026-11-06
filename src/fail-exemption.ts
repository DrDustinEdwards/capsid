import type { Env } from "./env";
import type { JobRow } from "./jobs-schema";
import { parsePrUrl } from "./github/client";
import { readNamedPrs } from "./complete-ci";
import { checklistItems, unchangedItems } from "./job-checklist";

// Which holder fails the breaker does not count (src/job-breaker.ts; Grok design review
// 2026-10-23, build step 7). "Not done, here's why" is a good outcome, but a breaker
// that ignored every fail with a reason would stop nothing. So only two kinds are left
// out, both shown by something other than the driver's word:
//
//   machinery  Capsid would refuse this job's complete right now, on the pull request it
//              is bound to: red or unfinished CI, or a test taken away (src/complete-ci.ts).
//              The fail is the outcome Capsid's own refusal asked for.
//   remainder  the reason carries a line "REMAINING: 2, 4" naming DONE WHEN items
//              (src/job-checklist.ts) that are left, some but not all of them; at least
//              one item not named says it changes a path, and every such path is changed
//              by the pull request the job is bound to. Part of the job is shown done in
//              the diff, and the rest is stated item by item.

export type BreakerExemption = "machinery" | "remainder";

const REMAINING = /^[ \t]*REMAINING:[ \t]*(\d+(?:[ \t]*,[ \t]*\d+)*)[ \t]*(?:$|[.;:])/m;

/** The item numbers a fail reason's REMAINING line names, or null without one. Pure. */
function remainingItems(reason: string): number[] | null {
  const m = REMAINING.exec(reason);
  return m ? [...new Set(m[1].split(",").map((n) => Number(n.trim())))] : null;
}

export async function breakerExemption(env: Env, job: JobRow, reason: string): Promise<BreakerExemption | null> {
  const urls = parsePrUrl(job.result_ref) ? [job.result_ref!.trim()] : [];
  const read = urls.length > 0 ? await readNamedPrs(env, job.namespace, urls, job.body) : { changed: [], unread: false };
  if (read && "refusal" in read) return "machinery";
  const items = checklistItems(job.body);
  const remaining = remainingItems(reason);
  if (!remaining || remaining.length === 0 || remaining.length >= items.length) return null;
  if (!remaining.every((n) => items.some((item) => item.n === n))) return null;
  const done = items.filter((item) => !remaining.includes(item.n));
  if (done.every((item) => item.paths.length === 0) || !read || read.unread) return null;
  return unchangedItems(done, read.changed).length === 0 ? "remainder" : null;
}
