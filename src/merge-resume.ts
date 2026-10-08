import type { Env } from "./env";
import { ghFetch, parsePrUrl, resolveRepo } from "./github/client";
import { autoResumeJob, MERGE_RESUME_ACTOR } from "./jobs-seat";
import { readJob } from "./jobs-transition";
import { prUrlsFromJob } from "./outcome-prs";
import { nextStaleCache, readStaleCache, STALE_PRS_KEY, tallyPrStates, type PrState, type StalePrCache } from "./stale-jobs";

// The stale-jobs step on the five-minute tick (capsid/decisions.md, 2026-10-03, D1 to D3).
// A merge is not completion, so this never closes anything: it returns a BLOCKED job to
// its holder (or the queue) once EVERY pull request the job names has merged, with a
// note per pull request. A pull request that is closed without merging, unreadable or
// still open leaves the job blocked. A job is resumed by this step once: a job that
// blocks again on the same merged pull requests is waiting on something else.
//
// Every state it reads is also written, as counts per job, to the stale:prs cache that
// the stale view reads (src/stale-jobs.ts, D5), so that view costs no GitHub reads.

const MAX_JOBS = 25;
const MAX_PRS = 5;

export interface MergeResumeReport {
  looked: number;
  resumed: string[];
  note: string;
  // Set when the stale:prs cache could not be read or written. The resumes stand.
  cache_error?: string;
}

interface PrRead {
  state: PrState;
  number: number;
  sha: string;
}

async function prState(env: Env, namespace: string, url: string): Promise<PrRead> {
  const parsed = parsePrUrl(url);
  if (!parsed) return { state: "unread", number: 0, sha: "" };
  const unread: PrRead = { state: "unread", number: parsed.number, sha: "" };
  try {
    const { owner, repo } = await resolveRepo(env, namespace, `${parsed.owner}/${parsed.repo}`);
    const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls/${parsed.number}`);
    if (!resp.ok) return unread;
    const pr = (await resp.json()) as { state?: string; merged?: boolean; merge_commit_sha?: string | null };
    if (pr.merged === true) return { state: "merged", number: parsed.number, sha: (pr.merge_commit_sha ?? "").slice(0, 7) };
    if (pr.state === "closed") return { state: "closed", number: parsed.number, sha: "" };
    if (pr.state === "open") return { state: "open", number: parsed.number, sha: "" };
    return unread;
  } catch {
    return unread;
  }
}

// Replaces each read job's entry and drops every job no longer blocked, including one
// this tick just resumed. Returns the problem, or null.
async function writeStaleCache(env: Env, reads: StalePrCache): Promise<string | null> {
  try {
    const prior = await readStaleCache(env.APP_KV);
    const ids = [...new Set([...Object.keys(prior.cache), ...Object.keys(reads)])];
    if (ids.length === 0 && prior.problem === null) return null;
    const { results } = await env.DB.prepare(
      `SELECT id FROM jobs WHERE status = 'blocked' AND id IN (SELECT value FROM json_each(?1))`
    )
      .bind(JSON.stringify(ids))
      .all<{ id: string }>();
    const stillBlocked = new Set((results ?? []).map((r) => r.id));
    await env.APP_KV.put(STALE_PRS_KEY, JSON.stringify(nextStaleCache(prior.cache, reads, stillBlocked)));
    return prior.problem;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
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
  const reads: StalePrCache = {};
  const at = now.toISOString();
  let looked = 0;
  for (const { id } of blocked.results ?? []) {
    const job = await readJob(env.DB, id);
    if (!job) continue;
    const urls = prUrlsFromJob(job).slice(0, MAX_PRS + 1);
    if (urls.length === 0 || urls.length > MAX_PRS) continue;
    looked++;
    const facts = await Promise.all(urls.map((u) => prState(env, job.namespace, u)));
    reads[id] = tallyPrStates(
      facts.map((f) => f.state),
      at
    );
    if (facts.some((f) => f.state !== "merged")) continue;
    const note = facts
      .map((f) => `PR #${f.number} merged${f.sha ? ` at ${f.sha}` : ""}; confirm the deploy and complete with your claim`)
      .join("\n");
    const result = await autoResumeJob(env, now, job, note);
    if (result.resumed) resumed.push(`${id}(${result.to})`);
  }
  const cacheError = await writeStaleCache(env, reads);
  const note =
    `looked at ${looked} blocked job(s) naming pull requests, resumed ${resumed.length}${resumed.length ? `: ${resumed.join(", ")}` : ""}` +
    (cacheError ? `; the ${STALE_PRS_KEY} cache: ${cacheError}` : "");
  return { looked, resumed, note, ...(cacheError ? { cache_error: cacheError } : {}) };
}
