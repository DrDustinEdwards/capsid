import type { Env } from "./env";
import rawModel from "../system/model.json" with { type: "json" };
import { listInstalledRepos, type InstalledRepo } from "./github/client";
import { callerIp, checkRate, rateLimitedResponse, type RateLimitPolicy } from "./rate-limit";
import { parseSystemModel, toPublic, type SystemModel } from "./system-model";
import { readStatsRows, summarize, type StatsRows } from "./public-stats";
import { buildPublicCode, readCodeMap } from "./public-code";

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
export const PUBLIC_CODE_PATH = "/public/code/v1.json";
export const PUBLIC_CODE_KEY = "public:code:v1";
export const PUBLIC_BUILD_LAST_KEY = "public:model:last";
const PUBLIC_CODE_LAST_KEY = "public:code:last";
// A repo publishes a new code map after each push, so the code document is rebuilt hourly, not daily.
const CODE_REFRESH_MS = 3_600_000;
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

export type PublicBuildReport = { ran: false; note: string } | { ran: true; note: string; codeFailed?: true };

export interface PublicBuildReaders {
  listRepos: (env: Env) => Promise<{ repos: InstalledRepo[] }>;
  statsRows: (env: Env, now: Date, systems: StatsRows["systems"]) => Promise<StatsRows>;
  codeMap: (env: Env, repo: string) => Promise<unknown>;
}

const LIVE: PublicBuildReaders = { listRepos: listInstalledRepos, statsRows: readStatsRows, codeMap: readCodeMap };

/**
 * Builds and stores the public documents once per UTC day. The model and the numbers
 * are read and computed before anything is written, so a failed read leaves the last
 * good documents served and the day unstamped; a partial visibility read cannot happen
 * (listInstalledRepos throws on one). The code maps come after, on their own: a repo's
 * broken map keeps the last good code document and is reported, and does not hold back
 * the model or retry every tick. Later in the day the code document alone is rebuilt
 * each hour, so a repo's new map shows the same day.
 */
export async function publicBuildTick(env: Env, now: Date, readers: PublicBuildReaders = LIVE, model: SystemModel = bundledModel()): Promise<PublicBuildReport> {
  const today = now.toISOString().slice(0, 10);
  const last = await env.APP_KV.get(PUBLIC_BUILD_LAST_KEY);
  if (last && last.slice(0, 10) === today) {
    const codeLast = await env.APP_KV.get(PUBLIC_CODE_LAST_KEY);
    if (codeLast && now.getTime() - Date.parse(codeLast) < CODE_REFRESH_MS) return { ran: false, note: `already built ${last}` };
    const { repos } = await readers.listRepos(env);
    const code = await storeCode(env, model, privacyOf(repos), today, now, readers.codeMap);
    const note = `code maps only, the model was built ${last}: ${code.note}`;
    return code.failed ? { ran: true, note, codeFailed: true } : { ran: true, note };
  }

  const { repos } = await readers.listRepos(env);
  const privacy = privacyOf(repos);
  const doc = toPublic(model, privacy, today);
  const stats = summarize(await readers.statsRows(env, now, { public: doc.counts.public, private: doc.counts.private }), now);

  await env.APP_KV.put(PUBLIC_MODEL_KEY, JSON.stringify(doc));
  await env.APP_KV.put(PUBLIC_STATS_KEY, JSON.stringify(stats));
  await env.APP_KV.put(PUBLIC_BUILD_LAST_KEY, now.toISOString());

  const code = await storeCode(env, model, privacy, today, now, readers.codeMap);

  const c = doc.counts;
  const note = `${c.public} public and ${c.private} private system(s), ${c.containers} container(s), ${c.relationships} relationship(s), ${doc.flows?.length ?? 0} of ${model.flows?.length ?? 0} flow(s) whole; visibility read for ${repos.length} repo(s); stats as of ${stats.as_of}, ${stats.jobs.completed_30d} job(s) finished in 30 days; ${code.note}`;
  return code.failed ? { ran: true, note, codeFailed: true } : { ran: true, note };
}

function privacyOf(repos: InstalledRepo[]): Map<string, boolean> {
  return new Map(repos.map((r) => [r.full_name.toLowerCase(), r.private] as const));
}

/** Builds and stores the code document. A map that fails its parse keeps the last good
 *  document. Either way the attempt is stamped, so a broken map is retried the next hour, not every tick. */
async function storeCode(env: Env, model: SystemModel, privacy: Map<string, boolean>, today: string, now: Date, read: PublicBuildReaders["codeMap"]): Promise<{ note: string; failed: boolean }> {
  let result: { note: string; failed: boolean };
  try {
    const built = await buildPublicCode(env, model, privacy, today, read);
    await env.APP_KV.put(PUBLIC_CODE_KEY, JSON.stringify(built));
    result = { note: `${built.maps.length} code map(s)${built.maps.length ? ` (${built.maps.map((m) => m.repo.split("/")[1]).join(", ")})` : ""}`, failed: false };
  } catch (e) {
    result = { note: `code maps kept from the last build: ${e instanceof Error ? e.message : String(e)}`, failed: true };
  }
  await env.APP_KV.put(PUBLIC_CODE_LAST_KEY, now.toISOString());
  return result;
}

function json(body: string, status: number, cache: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json;charset=utf-8", "Cache-Control": cache } });
}

/** Which stored document a route serves. */
export const PUBLIC_DOCS = {
  model: { path: PUBLIC_MODEL_PATH, key: PUBLIC_MODEL_KEY },
  stats: { path: PUBLIC_STATS_PATH, key: PUBLIC_STATS_KEY },
  code: { path: PUBLIC_CODE_PATH, key: PUBLIC_CODE_KEY },
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
