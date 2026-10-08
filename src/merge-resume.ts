import type { Env } from "./env";
import { ghFetch, parsePrUrl, resolveRepo } from "./github/client";
import { autoResumeJob, MERGE_RESUME_ACTOR } from "./jobs-seat";
import { readJob } from "./jobs-transition";
import { prUrlsFromJob } from "./outcome-prs";

// The stale-jobs step on the five-minute tick (capsid/decisions.md, 2026-10-03, D1 to D3).
// A merge is not completion, so this never closes anything: it returns a BLOCKED job to
// its holder (or the queue) once EVERY pull request the job names has merged, with a
// note per pull request. A pull request that is closed without merging, unreadable or
// still open leaves the job blocked. A job is resumed by this step once: a job that
// blocks again on the same merged pull requests is waiting on something else.

const MAX_JOBS = 25;
const MAX_PRS = 5;

export interface MergeResumeReport {
  looked: number;
  resumed: string[];
  note: string;
}

async function mergedAt(env: Env, namespace: string, url: string): Promise<{ number: number; sha: string } | null> {
  const parsed = parsePrUrl(url);
  if (!parsed) return null;
  try {
    const { owner, repo } = await resolveRepo(env, namespace, `${parsed.owner}/${parsed.repo}`);
    const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls/${parsed.number}`);
    if (!resp.ok) return null;
    const pr = (await resp.json()) as { merged?: boolean; merge_commit_sha?: string | null };
    return pr.merged === true ? { number: parsed.number, sha: (pr.merge_commit_sha ?? "").slice(0, 7) } : null;
  } catch {
    return null;
  }
}

export async function mergeResumeTick(env: Env, now: Date): Promise<MergeResumeReport> {
  const blocked = await env.DB.prepare(
    `SELECT id FROM jobs WHERE status = 'blocked'
       AND NOT EXISTS (SELECT 1 FROM job_touches t WHERE t.job_id = jobs.id AND t.actor = ?1)
     ORDER BY updated_at LIMIT ?2`
  )
    .bind(MERGE_RESUME_ACTOR, MAX_JOBS)
    .all<{ id: string }>();
  const resumed: string[] = [];
  let looked = 0;
  for (const { id } of blocked.results ?? []) {
    const job = await readJob(env.DB, id);
    if (!job) continue;
    const urls = prUrlsFromJob(job).slice(0, MAX_PRS + 1);
    if (urls.length === 0 || urls.length > MAX_PRS) continue;
    looked++;
    const facts = await Promise.all(urls.map((u) => mergedAt(env, job.namespace, u)));
    if (facts.some((f) => f === null)) continue;
    const note = (facts as Array<{ number: number; sha: string }>)
      .map((f) => `PR #${f.number} merged${f.sha ? ` at ${f.sha}` : ""}; confirm the deploy and complete with your claim`)
      .join("\n");
    const result = await autoResumeJob(env, now, job, note);
    if (result.resumed) resumed.push(`${id}(${result.to})`);
  }
  return { looked, resumed, note: `looked at ${looked} blocked job(s) naming pull requests, resumed ${resumed.length}${resumed.length ? `: ${resumed.join(", ")}` : ""}` };
}
