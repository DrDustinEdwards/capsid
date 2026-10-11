import type { Env } from "./env";
import rawModel from "../system/model.json" with { type: "json" };
import { listInstalledRepos, type InstalledRepo } from "./github/client";
import { callerIp, checkRate, rateLimitedResponse, type RateLimitPolicy } from "./rate-limit";
import { parseSystemModel, toPublic, type SystemModel } from "./system-model";
import { readStatsRows, summarize, type StatsRows } from "./public-stats";

// The public data build (design capsid/research/design-system-explorer.md, section 2;
// docs/public-data.md). Once a UTC day the tick reads every repo's visibility from
// GitHub, runs the model through toPublic, computes the aggregate numbers, and stores
// both documents in KV. The routes below serve those stored documents and nothing else:
// they never read D1 or GitHub, so a request cannot make the Worker compute anything.
//
// Their readers are the explorer's and dustinedwards.info's builds, not browsers
// (answer 4), so the responses carry no CORS header.

export const PUBLIC_MODEL_PATH = "/public/model/v1.json";
export const PUBLIC_MODEL_KEY = "public:model:v1";
export const PUBLIC_STATS_PATH = "/public/stats/v1.json";
export const PUBLIC_STATS_KEY = "public:stats:v1";
export const PUBLIC_BUILD_LAST_KEY = "public:model:last";
const CACHE_SECONDS = 3600;

// Fail closed: an unreadable counter refuses rather than serve without a limit. The
// edge cache answers most requests before the counter is read at all. One budget for
// both routes.
export const PUBLIC_DATA_LIMIT: RateLimitPolicy = {
  prefix: "public:rate:",
  perHour: 120,
  perDay: 1000,
  label: "PUBLIC_DATA",
  onUnavailable: "refuse",
};

/** The model the Worker was built with. A model that fails its schema fails the
 *  build step loudly, every day, rather than publish a partial map. */
export function bundledModel(): SystemModel {
  const parsed = parseSystemModel(rawModel);
  if (!parsed.ok) throw new Error(`system/model.json is invalid: ${parsed.problems.join("; ")}`);
  return parsed.model;
}

export type PublicBuildReport = { ran: false; note: string } | { ran: true; note: string };

export interface PublicBuildReaders {
  listRepos: (env: Env) => Promise<{ repos: InstalledRepo[] }>;
  statsRows: (env: Env, now: Date, systems: StatsRows["systems"]) => Promise<StatsRows>;
}

const LIVE: PublicBuildReaders = { listRepos: listInstalledRepos, statsRows: readStatsRows };

/**
 * Builds and stores both public documents once per UTC day. Everything is read and
 * computed before anything is written, so a failed read leaves the last good documents
 * served and the day unstamped; a partial visibility read cannot happen
 * (listInstalledRepos throws on one).
 */
export async function publicBuildTick(env: Env, now: Date, readers: PublicBuildReaders = LIVE, model: SystemModel = bundledModel()): Promise<PublicBuildReport> {
  const today = now.toISOString().slice(0, 10);
  const last = await env.APP_KV.get(PUBLIC_BUILD_LAST_KEY);
  if (last && last.slice(0, 10) === today) return { ran: false, note: `already built ${last}` };

  const { repos } = await readers.listRepos(env);
  const privacy = new Map(repos.map((r) => [r.full_name.toLowerCase(), r.private] as const));
  const doc = toPublic(model, privacy, today);
  const stats = summarize(await readers.statsRows(env, now, { public: doc.counts.public, private: doc.counts.private }), now);

  await env.APP_KV.put(PUBLIC_MODEL_KEY, JSON.stringify(doc));
  await env.APP_KV.put(PUBLIC_STATS_KEY, JSON.stringify(stats));
  await env.APP_KV.put(PUBLIC_BUILD_LAST_KEY, now.toISOString());
  const c = doc.counts;
  return {
    ran: true,
    note: `${c.public} public and ${c.private} private system(s), ${c.containers} container(s), ${c.relationships} relationship(s), ${doc.flows?.length ?? 0} of ${model.flows?.length ?? 0} flow(s) whole; visibility read for ${repos.length} repo(s); stats as of ${stats.as_of}, ${stats.jobs.completed_30d} job(s) finished in 30 days`,
  };
}

function json(body: string, status: number, cache: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json;charset=utf-8", "Cache-Control": cache } });
}

/** Which stored document a route serves. */
export const PUBLIC_DOCS = {
  model: { path: PUBLIC_MODEL_PATH, key: PUBLIC_MODEL_KEY },
  stats: { path: PUBLIC_STATS_PATH, key: PUBLIC_STATS_KEY },
} as const;

/**
 * GET of one public document. The colo's cache first, so a cached answer costs no KV
 * read and no counter; then the per-IP limit; then the stored document. 503 until the
 * first build, and never a computed fallback.
 */
export async function handlePublicDocument(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  doc: (typeof PUBLIC_DOCS)[keyof typeof PUBLIC_DOCS],
  now: Date = new Date(),
  cache: Cache | undefined = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches?.default
): Promise<Response> {
  // The query string is not part of the key, so it cannot be used to miss the cache.
  const key = new Request(new URL(doc.path, request.url).toString());
  const hit = await cache?.match(key);
  if (hit) return hit;

  const verdict = await checkRate(env.APP_KV, callerIp(request), now, PUBLIC_DATA_LIMIT);
  if (!verdict.allowed) return rateLimitedResponse(verdict, "requests");

  const stored = await env.APP_KV.get(doc.key);
  if (!stored) return json(JSON.stringify({ error: "not computed yet" }), 503, "no-store");
  const response = json(stored, 200, `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`);
  if (cache) ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}
