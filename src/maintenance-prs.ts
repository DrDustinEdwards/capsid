import type { Env } from "./env";
import { ghFetch, resolveRepo } from "./github/client";
import { readAllPages } from "./github/pr-files";
import { ciVerdict, jobIdFromBody } from "./auto-merge-policy";
import type { MaintenanceItem } from "./maintenance";

// The daily maintenance pass's pull request rules (job_549550d73d4e, piece 2). Two lists:
// a green driver pull request that is still open is waiting for the seat, shown with its
// age; a pull request whose checks have been red for more than 48 hours is shown with the
// step that failed. Both read what the auto-merge tick reads (the open list and each head's
// check runs, judged by the same ciVerdict), never the file lists. A read that fails is
// listed as "not checked", so a missing read never passes as a clean result.

const RED_HOURS = 48;
// Open pull requests read per repo. More are reported as not checked, not silently cut.
const PRS_READ_PER_REPO = 50;
const OPEN_LIST_MAX_PAGES = 2;
const CHECKS_MAX_PAGES = 10;
const MAX_ITEMS_PER_RULE = 50;

export interface PrCheck {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  completed_at: string | null;
  /** A GitHub Actions job, whose check run id is the job id and so has steps to read. */
  actions: boolean;
}

export interface OpenPr {
  number: number;
  url: string;
  draft: boolean;
  created_at: string;
  /** The job the body names, which is what makes it a driver's pull request. */
  job: string | null;
  checks: PrCheck[];
}

export interface PrReaders {
  /** The open pull requests of the namespace's repo with their head's check runs. May
   *  throw; `problem` says what part was not read. */
  openPrs(namespace: string): Promise<{ repo: string; prs: OpenPr[]; problem: string | null }>;
  /** The failed step of a failed check run, or why it was not read. */
  failingStep(repo: string, check: PrCheck): Promise<{ step: string | null; problem: string | null }>;
}

const days = (ms: number): string => `${(ms / 86_400_000).toFixed(1)} days`;

/** A driver's pull request, not a draft, whose checks are all green: it waits for the seat. */
export function greenAwaitingSeat(namespace: string, prs: OpenPr[], now: Date): MaintenanceItem[] {
  return prs
    .filter((pr) => pr.job !== null && !pr.draft && ciVerdict(pr.checks).conclusion === "success")
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((pr) => ({
      rule: "pr-awaiting-seat" as const,
      namespace,
      job: pr.job,
      pr: pr.url,
      line: `${pr.url} (${pr.job}) is green and has been open ${days(now.getTime() - Date.parse(pr.created_at))}: merge it or say why it waits.`,
    }));
}

/** A pull request whose checks have all finished, at least one failed, and the first
 *  failure finished more than RED_HOURS ago on the current head. A re-run or a new push
 *  starts the clock again, because GitHub then reports new check runs. */
export function redTooLong(prs: OpenPr[], now: Date): Array<{ pr: OpenPr; since: string; check: PrCheck }> {
  const out: Array<{ pr: OpenPr; since: string; check: PrCheck }> = [];
  for (const pr of prs) {
    if (ciVerdict(pr.checks).conclusion !== "failure") continue;
    const failed = pr.checks
      .filter((c) => !["success", "skipped", "neutral"].includes(c.conclusion ?? "") && c.completed_at)
      .sort((a, b) => (a.completed_at ?? "").localeCompare(b.completed_at ?? ""));
    const first = failed[0];
    if (!first?.completed_at) continue;
    if (now.getTime() - Date.parse(first.completed_at) > RED_HOURS * 3_600_000) out.push({ pr, since: first.completed_at, check: first });
  }
  return out;
}

/** The pull request rules over every namespace in `namespaces`, and how many open pull
 *  requests each read, so "nothing listed" can be told from "nothing read". */
export async function gatherPrItems(
  namespaces: readonly string[],
  readers: PrReaders,
  now: Date
): Promise<{ items: MaintenanceItem[]; read: Record<string, number> }> {
  const items: MaintenanceItem[] = [];
  const read: Record<string, number> = {};
  for (const namespace of namespaces) {
    let got: Awaited<ReturnType<PrReaders["openPrs"]>>;
    try {
      got = await readers.openPrs(namespace);
    } catch (err) {
      items.push(notChecked(namespace, err instanceof Error ? err.message : String(err)));
      continue;
    }
    read[namespace] = got.prs.length;
    if (got.problem) items.push(notChecked(namespace, got.problem));
    items.push(...greenAwaitingSeat(namespace, got.prs, now).slice(0, MAX_ITEMS_PER_RULE));
    for (const { pr, since, check } of redTooLong(got.prs, now).slice(0, MAX_ITEMS_PER_RULE)) {
      let where: string;
      try {
        const step = await readers.failingStep(got.repo, check);
        where = step.step ? `"${check.name}" failed at step "${step.step}"` : `"${check.name}" failed; its step was not read (${step.problem ?? "unknown"})`;
      } catch (err) {
        where = `"${check.name}" failed; its step was not read (${err instanceof Error ? err.message : String(err)})`;
      }
      items.push({
        rule: "pr-red",
        namespace,
        job: pr.job,
        pr: pr.url,
        line: `${pr.url} has been red for ${days(now.getTime() - Date.parse(since))}: ${where}. Fix it or close it.`,
      });
    }
  }
  return { items, read };
}

function notChecked(namespace: string, problem: string): MaintenanceItem {
  return {
    rule: "prs-not-checked",
    namespace,
    job: null,
    line: `Open pull requests in ${namespace} were not fully checked (${problem}): what is missing is not a clean result.`,
  };
}

interface RawPr {
  number: number;
  html_url: string;
  draft?: boolean;
  created_at: string;
  body: string | null;
  head: { sha: string };
}

interface RawCheck {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  completed_at: string | null;
  app?: { slug?: string } | null;
}

/** The readers on GitHub, through the App: the same open list and check-run reads the
 *  auto-merge tick makes (src/auto-merge-tick.ts), and one Actions job read per pull
 *  request that has been red long enough to be listed. */
export function githubPrReaders(env: Env): PrReaders {
  return {
    async openPrs(namespace) {
      const { owner, repo, full } = await resolveRepo(env, namespace);
      const listed = await readAllPages<RawPr>(env, owner, repo, `/repos/${owner}/${repo}/pulls?state=open`, (page) => page as RawPr[], OPEN_LIST_MAX_PAGES);
      const problems: string[] = [];
      if (listed.problem) problems.push(`the open pull request list: ${listed.problem}`);
      const reading = listed.items.slice(0, PRS_READ_PER_REPO);
      if (listed.items.length > reading.length) problems.push(`${listed.items.length - reading.length} open pull requests were not read`);
      const prs: OpenPr[] = [];
      for (const pr of reading) {
        const checks = await readAllPages<RawCheck>(
          env, owner, repo, `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`,
          (page) => (page as { check_runs: RawCheck[] }).check_runs, CHECKS_MAX_PAGES
        );
        if (checks.problem) {
          problems.push(`#${pr.number} check runs: ${checks.problem}`);
          continue;
        }
        prs.push({
          number: pr.number,
          url: pr.html_url,
          draft: pr.draft === true,
          created_at: pr.created_at,
          job: jobIdFromBody(pr.body ?? ""),
          checks: checks.items.map((c) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            conclusion: c.conclusion,
            completed_at: c.completed_at,
            actions: c.app?.slug === "github-actions",
          })),
        });
      }
      return { repo: full, prs, problem: problems.length > 0 ? problems.join("; ") : null };
    },
    async failingStep(repo, check) {
      if (!check.actions) return { step: null, problem: "it is not a GitHub Actions job, so it has no steps" };
      const [owner, name] = repo.split("/");
      const resp = await ghFetch(env, owner, name, `/repos/${owner}/${name}/actions/jobs/${check.id}`);
      if (!resp.ok) {
        await resp.body?.cancel();
        return { step: null, problem: `the job read returned ${resp.status}` };
      }
      const job = (await resp.json()) as { steps?: Array<{ name: string; conclusion: string | null }> };
      const step = job.steps?.find((s) => s.conclusion === "failure")?.name ?? null;
      return { step, problem: step ? null : "no step of the job is marked failed" };
    },
  };
}
