import type { Env } from "./env";
import { ciVerdict } from "./auto-merge-policy";
import { parsePrUrl, resolveRepo } from "./github/client";
import { readCheckRuns, readPrFiles } from "./github/pr-files";
import { prFacts } from "./job-outcomes";
import { pathClassOf } from "./merge-class";
import { weakenedTests } from "./test-protection";
import { checklistItems, unchangedItems } from "./job-checklist";
import { proseOnly } from "./job-body-check";

// The CI gate on complete (docs/work-queue.md, "CI on complete"). A job handed on as done
// names its pull requests, and each must show CI that ran and passed on its head. Green
// is the only pass. Still running is a wait, failed is red, and no check run that passed
// on a change to code is not green either: a change nothing ran on is not shown to work.
// GitHub unreadable is a wait as well, since not answered is not green. A pull request
// that takes a test away is refused too (src/test-protection.ts).
//
// A pull request Capsid has no way to read is not gated: with no GitHub App, or in a repo
// the job's namespace does not map, its outcome stays unverified as before.

const CHECKS_MAX_PAGES = 10;
// A job opts into the test on the base with this line in its body.
const TEST_ON_BASE = /^[ \t]*TEST ON BASE\b/m;
const AGAIN = "Nothing was written; call complete again once it has.";
const OR_FAIL = `Fix it and push, then complete again, or call fail with the reason; "not done, here's why" is a good outcome.`;

/** What the gate reads of the named pull requests: the first refusal, or the paths they
 *  change, with unread set when one of them could not be read. Null with no GitHub App. */
export async function readNamedPrs(
  env: Env,
  namespace: string,
  urls: readonly string[],
  jobBody: string
): Promise<{ refusal: { pr: string; why: string } } | { changed: string[]; unread: boolean } | null> {
  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_PRIVATE_KEY) return null;
  const changed: string[] = [];
  let unread = false;
  for (const url of urls) {
    const read = await notGreen(env, namespace, url, jobBody);
    if (read === null) unread = true;
    else if (typeof read === "string") return { refusal: { pr: url, why: read } };
    else changed.push(...read);
  }
  return { changed, unread };
}

/** Why complete is refused on CI, on a test taken away, or on a DONE WHEN item no pull
 *  request changed, with the pull request to bind the job to (null when none is named), or null. */
export async function ciRefusal(env: Env, namespace: string, urls: readonly string[], jobBody: string): Promise<{ pr: string | null; why: string } | null> {
  const read = await readNamedPrs(env, namespace, urls, jobBody);
  if (read === null) return null;
  if ("refusal" in read) return read.refusal;
  // A pull request Capsid could not read may change the path, so the checklist is not judged.
  if (read.unread) return null;
  const missing = unchangedItems(checklistItems(jobBody), read.changed);
  if (missing.length === 0) return null;
  return {
    pr: urls[0] ?? null,
    why:
      `${missing.slice(0, 3).join("; ")}${missing.length > 3 ? `; and ${missing.length - 3} more` : ""}, and ${urls.length > 0 ? "no pull request this complete names changes it" : "this complete names no pull request"}. ` +
      `Name the pull request that changes it, or call fail with the reason.`,
  };
}

// A refusal, the paths the pull request changes when it passes, or null when it could not be read.
async function notGreen(env: Env, namespace: string, url: string, jobBody: string): Promise<string | string[] | null> {
  const parsed = parsePrUrl(url);
  if (!parsed) return [];
  try {
    await resolveRepo(env, namespace, `${parsed.owner}/${parsed.repo}`);
  } catch {
    return null;
  }
  const facts = await prFacts(env, namespace, url);
  if (typeof facts === "string") return `${facts}, so its CI is not shown green. ${AGAIN}`;
  const sha = facts.head_sha.slice(0, 7);
  const [owner, repo] = facts.repo.split("/");
  const checks = await readCheckRuns(env, owner, repo, facts.head_sha, CHECKS_MAX_PAGES);
  if (checks.problem) return `${url}: the check runs on ${sha} could not be read whole (${checks.problem}), so its CI is not shown green. ${AGAIN}`;
  if (checks.items.length > 0) {
    const verdict = ciVerdict(checks.items);
    if (verdict.conclusion === "pending") return `${url}: CI on ${sha} has not finished (${verdict.note}). The job stays claimed. ${AGAIN}`;
    if (verdict.conclusion === "failure") return `${url}: CI on ${sha} failed (${verdict.note}). ${OR_FAIL}`;
  }
  // A job that opts into the test on the base (scripts/test-on-base.mjs) needs its run to
  // have passed; running or failed, the verdict above already answered.
  if (TEST_ON_BASE.test(proseOnly(jobBody)) && !checks.items.some((c) => c.name === "test-on-base" && c.conclusion === "success")) {
    return (
      `${url}: the job asks for its tests to be run on the base, and no test-on-base check passed on ${sha}. ` +
      `Label the pull request test-on-base (the workflow runs in this repository only), then complete again; or call fail with the reason.`
    );
  }
  const files = await readPrFiles(env, owner, repo, parsed.number);
  if (files.problem) return `${url}: its file list could not be read whole (${files.problem}), so its tests are not shown kept. ${AGAIN}`;
  const weakened = weakenedTests(files.rows, jobBody);
  if (weakened.length > 0) {
    return (
      `${url} ${weakened.slice(0, 3).join("; ")}${weakened.length > 3 ? `; and ${weakened.length - 3} more` : ""}. ` +
      `Green CI shows nothing once the test that would fail is gone, so this is not done unless the job names it. Put the test back, or call fail with the reason.`
    );
  }
  // Skipped and neutral fail nothing, and pass nothing: a run a paths filter excluded
  // did not judge the change.
  if (checks.items.some((c) => c.conclusion === "success")) return files.paths;
  const code = files.paths.filter((p) => pathClassOf(p) !== "docs");
  if (code.length === 0) return files.paths;
  return (
    `${url}: no CI check passed on ${sha}, and it changes code (${code.slice(0, 3).join(", ")}${code.length > 3 ? `, and ${code.length - 3} more` : ""}). ` +
    `A change no check ran on is not shown to work. Get CI to run on it, or call fail with the reason.`
  );
}
