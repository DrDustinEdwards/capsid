import type { Env } from "./env";
import { MERGE_RESUME_ACTOR } from "./jobs-seat";

// The stale view (capsid/research/design-stale-jobs.md, D5): `jobs` action list with
// stale: true. Three rules, each a fact the Worker already holds, so reading the view
// costs no GitHub reads:
//   unchanged: a blocked or claimed job whose row has not changed in 3 days;
//   resumed-not-completed: a job the merge-resume step resumed 24 hours or more ago that
//     is still blocked, claimed or queued;
//   prs-settled: a blocked job whose named pull requests are all merged or closed, read
//     from the cache the merge-resume step writes (src/merge-resume.ts).
// Nothing here closes or moves a job; the view only says why a job looks stuck.

export const STALE_UNCHANGED_MS = 3 * 24 * 60 * 60 * 1000;
export const STALE_RESUMED_MS = 24 * 60 * 60 * 1000;
const STALE_ROWS_MAX = 200;

// One KV value (APP_KV) holding, per blocked job, the states of the pull requests it
// names as the merge-resume step last read them.
export const STALE_PRS_KEY = "stale:prs";

export type PrState = "merged" | "closed" | "open" | "unread";

export interface StalePrEntry {
  merged: number;
  closed: number;
  open: number;
  unread: number;
  // ISO time of the read.
  at: string;
}

export type StalePrCache = Record<string, StalePrEntry>;

export type StaleRule = "unchanged" | "resumed-not-completed" | "prs-settled";

export interface StaleRow {
  id: string;
  namespace: string;
  title: string;
  status: string;
  updated_at: string;
  rule: StaleRule;
  reason: string;
}

/** The counts one job's pull request reads add up to. */
export function tallyPrStates(states: readonly PrState[], at: string): StalePrEntry {
  const entry: StalePrEntry = { merged: 0, closed: 0, open: 0, unread: 0, at };
  for (const state of states) entry[state] += 1;
  return entry;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isEntry(value: unknown): value is StalePrEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return isCount(v.merged) && isCount(v.closed) && isCount(v.open) && isCount(v.unread) && typeof v.at === "string";
}

/** The cache as stored, keeping only entries of the right shape. null (never written) is
 *  an empty cache; anything else that is not an object is reported as unreadable. */
export function parseStaleCache(raw: unknown): { cache: StalePrCache; problem: string | null } {
  if (raw === null || raw === undefined) return { cache: {}, problem: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { cache: {}, problem: `${STALE_PRS_KEY} is not a JSON object` };
  const cache: StalePrCache = {};
  let dropped = 0;
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (isEntry(entry)) cache[id] = entry;
    else dropped++;
  }
  return { cache, problem: dropped > 0 ? `${STALE_PRS_KEY} held ${dropped} entr${dropped === 1 ? "y" : "ies"} of the wrong shape, left out` : null };
}

/** The stored cache. A value that is not JSON is reported, not thrown, so the view
 *  still serves the two rules that do not need it. */
export async function readStaleCache(kv: KVNamespace): Promise<{ cache: StalePrCache; problem: string | null }> {
  const text = await kv.get(STALE_PRS_KEY);
  if (text === null) return { cache: {}, problem: null };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { cache: {}, problem: `${STALE_PRS_KEY} is not JSON` };
  }
  return parseStaleCache(raw);
}

/** The next cache: this tick's reads replace each job's entry, and only jobs still
 *  blocked keep one. */
export function nextStaleCache(prior: StalePrCache, reads: StalePrCache, stillBlocked: ReadonlySet<string>): StalePrCache {
  const next: StalePrCache = {};
  for (const [id, entry] of Object.entries({ ...prior, ...reads })) {
    if (stillBlocked.has(id)) next[id] = entry;
  }
  return next;
}

/** Rule C's test on one cache entry: nothing open, nothing unread, and at least one
 *  pull request merged or closed. */
export function prsSettled(entry: StalePrEntry | undefined): boolean {
  return entry !== undefined && entry.open === 0 && entry.unread === 0 && entry.merged + entry.closed > 0;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Why one job is stale, or null. Pure, so the rules are tested without a database.
 * The first rule that holds wins, the most actionable first: settled pull requests,
 * then an auto-resume nobody finished, then a row nobody touched. A cache entry read
 * before the job last changed says nothing about the job as it is now, so it is ignored.
 */
export function classifyStale(
  job: { status: string; updated_at: string; auto_resumed_at: string | null },
  entry: StalePrEntry | undefined,
  now: Date
): { rule: StaleRule; reason: string } | null {
  const nowMs = now.getTime();
  if (job.status === "blocked" && entry && entry.at >= job.updated_at && prsSettled(entry)) {
    return {
      rule: "prs-settled",
      reason: `blocked, and every pull request it names is settled (${entry.merged} merged, ${entry.closed} closed without merging, read ${entry.at})`,
    };
  }
  if (job.auto_resumed_at && ["blocked", "claimed", "queued"].includes(job.status)) {
    const since = Date.parse(job.auto_resumed_at);
    if (Number.isFinite(since) && nowMs - since >= STALE_RESUMED_MS) {
      const hours = Math.floor((nowMs - since) / (60 * 60 * 1000));
      return {
        rule: "resumed-not-completed",
        reason: `auto-resumed by ${MERGE_RESUME_ACTOR} at ${job.auto_resumed_at} and still ${job.status} ${plural(hours, "hour")} later`,
      };
    }
  }
  if (job.status === "blocked" || job.status === "claimed") {
    const since = Date.parse(job.updated_at);
    if (Number.isFinite(since) && nowMs - since >= STALE_UNCHANGED_MS) {
      const days = Math.floor((nowMs - since) / (24 * 60 * 60 * 1000));
      return { rule: "unchanged", reason: `${job.status} and unchanged since ${job.updated_at} (${plural(days, "day")})` };
    }
  }
  return null;
}

export interface StaleJobsResult {
  rows: StaleRow[];
  truncated: boolean;
  note?: string;
}

/**
 * The stale view. The caller's namespace scope is checked before this runs, as for
 * every jobs list (src/tools/jobs.ts); a caller scoped to one namespace must name it
 * (the registrar's namespaceRefusal), and an omitted namespace means every namespace.
 */
export async function staleJobs(env: Env, now: Date, opts: { namespace?: string } = {}): Promise<StaleJobsResult> {
  const read = await readStaleCache(env.APP_KV);
  const settled = Object.keys(read.cache).filter((id) => prsSettled(read.cache[id]));
  const unchangedBefore = new Date(now.getTime() - STALE_UNCHANGED_MS).toISOString();
  const resumedBefore = new Date(now.getTime() - STALE_RESUMED_MS).toISOString();
  // The SQL narrows to the candidates; classifyStale decides, so the rules live in one
  // place. ISO strings with milliseconds compare in time order. The namespace is bound as
  // NULL for "every namespace" rather than spliced in, so the statement has no hole and
  // test-integration/query-plans.test.ts plans it as written.
  const { results } = await env.DB.prepare(
    `SELECT j.id, j.namespace, j.title, j.status, j.updated_at,
            (SELECT MAX(t.at) FROM job_touches t WHERE t.job_id = j.id AND t.actor = ?1 AND t.kind = 'resume') AS auto_resumed_at
       FROM jobs j
      WHERE j.status IN ('blocked', 'claimed', 'queued')
        AND (?5 IS NULL OR j.namespace = ?5)
        AND ((j.status IN ('blocked', 'claimed') AND j.updated_at <= ?2)
          OR EXISTS (SELECT 1 FROM job_touches r WHERE r.job_id = j.id AND r.actor = ?1 AND r.kind = 'resume' AND r.at <= ?3)
          OR (j.status = 'blocked' AND j.id IN (SELECT value FROM json_each(?4))))
      ORDER BY j.updated_at ASC
      LIMIT ?6`
  )
    .bind(MERGE_RESUME_ACTOR, unchangedBefore, resumedBefore, JSON.stringify(settled), opts.namespace ?? null, STALE_ROWS_MAX + 1)
    .all<{ id: string; namespace: string; title: string; status: string; updated_at: string; auto_resumed_at: string | null }>();
  const candidates = results ?? [];
  const truncated = candidates.length > STALE_ROWS_MAX;
  const rows: StaleRow[] = [];
  for (const job of truncated ? candidates.slice(0, STALE_ROWS_MAX) : candidates) {
    const why = classifyStale(job, read.cache[job.id], now);
    if (why) rows.push({ id: job.id, namespace: job.namespace, title: job.title, status: job.status, updated_at: job.updated_at, ...why });
  }
  const notes = [
    ...(truncated ? [`more than ${STALE_ROWS_MAX} stale jobs; narrow by namespace.`] : []),
    ...(read.problem ? [`the pull request cache could not be fully read (${read.problem}), so prs-settled may be missing rows.`] : []),
  ];
  return { rows, truncated, ...(notes.length ? { note: notes.join(" ") } : {}) };
}
