import { loadMergePolicy } from "./auto-merge-policy";
import type { Env } from "./env";
import { parsePrUrl } from "@dustinedwards/site-runtime/github";
import { ghFetch, resolveRepo } from "./github/client";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { auditStatement } from "./store-guards";
import { DAY_MS } from "./time";
import { passDue } from "./watcher";
import { mapLimit } from "./map-limit";
import { toSqlTime } from "@dustinedwards/site-runtime/time";

export const REVERTS_STAMP_KEY = "merge-safety:reverts-last";
const REVERTS_EVERY_MINUTES = 30;
const CLOSED_PRS_READ = 50;
export const AUDIT_ROWS_LIMIT = 5000;
// The audit window has to reach the merge a rollback is joined to, so it is the merge units' 90.
export const WINDOW_MS = 90 * DAY_MS;
export const ACTOR = "capsid:merge-safety";

/** The pull requests and commits a merged pull request says it reverts. Pure.
 *  Recognized: GitHub's revert button ("Reverts owner/repo#N" in the body, with a title
 *  `Revert "..."`), "reverts #N" or "revert #N" at the start of the title or of a body line
 *  (same repo only, any letter case), and git's "This reverts commit <sha>" (7 to 40 hex). A mention of
 *  another repo's pull request names none of this repo's. */
export function revertTargets(
  title: string,
  body: string,
  repo: string,
): { prs: number[]; shas: string[] } {
  const prs = new Set<number>();
  const shas = new Set<string>();
  const text = `${title ?? ""}\n${body ?? ""}`;
  for (const m of text.matchAll(/\breverts?\s+([\w.-]+\/[\w.-]+)#(\d+)\b/gi)) {
    if (m[1]!.toLowerCase() === repo.toLowerCase()) prs.add(Number(m[2]));
  }
  // A bare "revert #N" is a statement only at the start of the title or of a body line
  // (after a list marker at most): "Don't revert #12 here" is prose and names nothing.
  const lead = /^[ \t]*(?:[-*][ \t]+)?reverts?\s+#(\d+)\b/gim;
  for (const m of `${title ?? ""}\n${body ?? ""}`.matchAll(lead)) prs.add(Number(m[1]));
  for (const m of text.matchAll(/\bThis reverts commit\s+([0-9a-f]{7,40})\b/gi))
    shas.add(m[1]!.toLowerCase());
  return { prs: [...prs].sort((a, b) => a - b), shas: [...shas] };
}

interface ClosedPr {
  number: number;
  title?: string | null;
  body?: string | null;
  merged_at?: string | null;
}

interface AutoMergedRow {
  repo: string;
  pr: number;
  head_sha: string | null;
  path_class: string | null;
}

/** The auto-merged audit row for a pull request, or for a commit by its sha prefix
 *  (merge_sha or head_sha). The same query shape the merge units use. */
async function autoMergedBy(
  env: Env,
  namespace: string,
  repo: string,
  target: { pr: number } | { sha: string },
): Promise<AutoMergedRow | null> {
  const row =
    "pr" in target
      ? await env.DB.prepare(
          `SELECT params FROM audit_log WHERE action = 'auto-merged' AND namespace = ?1 AND json_extract(params, '$.repo') = ?2 AND json_extract(params, '$.pr') = ?3 ORDER BY id DESC LIMIT 1`,
        )
          .bind(namespace, repo, target.pr)
          .first<{ params: string }>()
      : // The sha is hex by the pattern that found it, so the prefix carries no wildcard.
        await env.DB.prepare(
          `SELECT params FROM audit_log WHERE action = 'auto-merged' AND namespace = ?1 AND json_extract(params, '$.repo') = ?2
             AND (json_extract(params, '$.merge_sha') LIKE ?3 OR json_extract(params, '$.head_sha') LIKE ?3) ORDER BY id DESC LIMIT 1`,
        )
          .bind(namespace, repo, `${target.sha}%`)
          .first<{ params: string }>();
  if (!row) return null;
  const p = JSON.parse(row.params) as {
    repo: string;
    pr: number;
    head_sha?: string | null;
    path_class?: string | null;
  };
  return { repo: p.repo, pr: p.pr, head_sha: p.head_sha ?? null, path_class: p.path_class ?? null };
}

export interface RevertsReport {
  ran: boolean;
  note: string;
  recorded: string[];
}

/** A repository's most recently updated closed pull requests. Throws when GitHub refuses. */
async function readClosedPrs(env: Env, owner: string, repo: string): Promise<ClosedPr[]> {
  const resp = await ghFetch(
    env,
    owner,
    repo,
    `/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${CLOSED_PRS_READ}`,
  );
  if (!resp.ok)
    throw new Error(`the closed pull requests of ${owner}/${repo} returned ${resp.status}`);
  return (await resp.json()) as ClosedPr[];
}

/** One namespace's revert pass: the recently merged pull requests that revert an
 *  auto-merged one, each recorded once. Returns what it recorded. */
export async function recordReverts(env: Env, namespace: string, now: Date): Promise<string[]> {
  const { owner, repo } = await resolveRepo(env, namespace);
  const full = `${owner}/${repo}`;
  const recorded: string[] = [];
  for (const closed of await readClosedPrs(env, owner, repo)) {
    if (!closed.merged_at) continue;
    // A revert older than the evidence window answers nothing the meter still reads.
    if (now.getTime() - Date.parse(closed.merged_at) > WINDOW_MS) continue;
    const targets = revertTargets(closed.title ?? "", closed.body ?? "", full);
    const reverted = new Map<number, AutoMergedRow>();
    for (const pr of targets.prs) {
      const row = await autoMergedBy(env, namespace, full, { pr });
      if (row) reverted.set(row.pr, row);
    }
    for (const sha of targets.shas) {
      const row = await autoMergedBy(env, namespace, full, { sha });
      if (row) reverted.set(row.pr, row);
    }
    for (const row of reverted.values()) {
      // A pull request does not revert itself, and one revert is recorded once per
      // reverted pull request however many ticks see it.
      if (row.pr === closed.number) continue;
      const seen = await env.DB.prepare(
        `SELECT 1 AS found FROM audit_log WHERE action = 'auto-merge-reverted' AND namespace = ?1 AND json_extract(params, '$.repo') = ?2
           AND json_extract(params, '$.pr') = ?3 AND json_extract(params, '$.reverted_by') = ?4 LIMIT 1`,
      )
        .bind(namespace, full, row.pr, closed.number)
        .first<{ found: number }>();
      if (seen) continue;
      await env.DB.batch([
        auditStatement(env.DB, ACTOR, "auto-merge-reverted", namespace, null, {
          repo: full,
          pr: row.pr,
          reverted_by: closed.number,
          head_sha: row.head_sha,
          path_class: row.path_class,
          merged_at: closed.merged_at,
          at: now.toISOString(),
        }),
      ]);
      recorded.push(`${full}#${row.pr} by #${closed.number}`);
    }
  }
  return recorded;
}

// A job's merged pull request that a later merge reverted, in any repo a recent outcome
// names, auto-merged or not. The model routing learns from it (src/model-learning.ts): a
// merge that had to be undone is not work that held. Recorded once per (job, pull
// request, revert) as a `job-pr-reverted` audit row.
const OUTCOME_REPOS_MAX = 30;
const SHA_LOOKUPS_MAX = 20;

/** The revert pass over the repos of the last 90 days' merged outcome pull requests.
 *  Returns what it recorded; a GitHub failure for one repo is logged and the rest go on. */
export async function recordOutcomeReverts(env: Env, now: Date): Promise<string[]> {
  const since = toSqlTime(now.getTime() - WINDOW_MS);
  const { results } = await env.DB.prepare(
    `SELECT p.job_id AS job_id, p.pr_url AS pr_url, o.namespace AS namespace FROM job_outcome_prs p JOIN job_outcomes o ON o.job_id = p.job_id
     WHERE p.merged = 1 AND p.recorded_at >= ?1 ORDER BY p.recorded_at DESC LIMIT ?2`,
  )
    .bind(since, AUDIT_ROWS_LIMIT)
    .all<{ job_id: string; pr_url: string; namespace: string }>();
  const repos = new Map<
    string,
    { owner: string; repo: string; prs: Map<number, Array<{ job_id: string; namespace: string }>> }
  >();
  for (const row of results ?? []) {
    const ref = parsePrUrl(row.pr_url);
    if (!ref) continue;
    const key = `${ref.owner}/${ref.repo}`.toLowerCase();
    const entry =
      repos.get(key) ??
      (repos.set(key, { owner: ref.owner, repo: ref.repo, prs: new Map() }), repos.get(key)!);
    entry.prs.set(ref.number, [
      ...(entry.prs.get(ref.number) ?? []),
      { job_id: row.job_id, namespace: row.namespace },
    ]);
  }
  // Only repos a namespace still maps: a job's pull request in a repo that was renamed or
  // retired (capsid-mcp, dustinedwards-mcp, renovate-config) has no installation to read it
  // with, so each pass paid a slow "GitHub refused an installation token" for it.
  const mapped = new Set<string>();
  const { results: mappings } = await env.DB.prepare("SELECT repos FROM namespaces").all<{
    repos: string | null;
  }>();
  for (const row of mappings ?? [])
    for (const entry of JSON.parse(row.repos || "[]") as Array<{ repo?: unknown }>)
      if (typeof entry?.repo === "string") mapped.add(entry.repo.toLowerCase());
  const recorded: string[] = [];
  for (const { owner, repo, prs } of [...repos.values()]
    .filter((r) => mapped.has(`${r.owner}/${r.repo}`.toLowerCase()))
    .slice(0, OUTCOME_REPOS_MAX)) {
    const full = `${owner}/${repo}`;
    try {
      let shaLookups = 0;
      for (const closed of await readClosedPrs(env, owner, repo)) {
        if (!closed.merged_at || now.getTime() - Date.parse(closed.merged_at) > WINDOW_MS) continue;
        const targets = revertTargets(closed.title ?? "", closed.body ?? "", full);
        const numbers = new Set(targets.prs);
        // git's "This reverts commit <sha>" names a commit: GitHub says which pull request
        // brought it in.
        for (const sha of targets.shas) {
          if (shaLookups++ >= SHA_LOOKUPS_MAX) break;
          const pulls = await ghFetch(
            env,
            owner,
            repo,
            `/repos/${owner}/${repo}/commits/${sha}/pulls`,
          );
          if (pulls.ok)
            for (const p of (await pulls.json()) as Array<{ number: number }>)
              numbers.add(p.number);
        }
        for (const pr of numbers) {
          if (pr === closed.number) continue;
          for (const job of prs.get(pr) ?? []) {
            const seen = await env.DB.prepare(
              `SELECT 1 AS found FROM audit_log WHERE action = 'job-pr-reverted' AND json_extract(params, '$.job_id') = ?1
                 AND json_extract(params, '$.pr') = ?2 AND json_extract(params, '$.reverted_by') = ?3 LIMIT 1`,
            )
              .bind(job.job_id, pr, closed.number)
              .first<{ found: number }>();
            if (seen) continue;
            await env.DB.batch([
              auditStatement(env.DB, ACTOR, "job-pr-reverted", job.namespace, null, {
                job_id: job.job_id,
                repo: full,
                pr,
                reverted_by: closed.number,
                merged_at: closed.merged_at,
                at: now.toISOString(),
              }),
            ]);
            recorded.push(`${job.job_id} (${full}#${pr} by #${closed.number})`);
          }
        }
      }
    } catch (err) {
      logEvent(
        "MERGE_SAFETY",
        {
          message: `MERGE_SAFETY could not read the reverts of ${full}: ${errorMessage(err)}`,
        },
        { level: "error" },
      );
    }
  }
  return recorded;
}

/** The revert pass over every namespace the signed merge policy covers, and over the
 *  repos of recent job outcomes, at most once in 30 minutes (a KV stamp, like the
 *  watcher's). A policy that does not load, or a GitHub failure for one namespace, is
 *  logged and the rest go on. */
export async function revertsTick(
  env: Env,
  now: Date,
  policy?: Awaited<ReturnType<typeof loadMergePolicy>>,
): Promise<RevertsReport> {
  const last = await env.APP_KV.get(REVERTS_STAMP_KEY).catch(() => null);
  const due = passDue(last, REVERTS_EVERY_MINUTES, now);
  if (!due.due) return { ran: false, note: due.reason, recorded: [] };
  const outcomes = await recordOutcomeReverts(env, now);
  const loaded = policy ?? (await loadMergePolicy(env));
  if ("error" in loaded) {
    await env.APP_KV.put(REVERTS_STAMP_KEY, now.toISOString());
    return {
      ran: true,
      note: `${outcomes.length} revert(s) of job pull requests recorded; ${loaded.error}`,
      recorded: outcomes,
    };
  }
  const recorded: string[] = [...outcomes];
  const perNamespace = await mapLimit(loaded.policy.namespaces, 4, async (namespace) => {
    try {
      return await recordReverts(env, namespace, now);
    } catch (err) {
      logEvent(
        "MERGE_SAFETY",
        {
          message: `MERGE_SAFETY could not read the reverts of ${namespace}: ${errorMessage(err)}`,
        },
        { level: "error" },
      );
      return [];
    }
  });
  for (const found of perNamespace) recorded.push(...found);
  await env.APP_KV.put(REVERTS_STAMP_KEY, now.toISOString());
  return {
    ran: true,
    note: `${recorded.length} revert(s) recorded (job and auto-merged pull requests)${recorded.length ? `: ${recorded.join(", ")}` : ""}`,
    recorded,
  };
}
