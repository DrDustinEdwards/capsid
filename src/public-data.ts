import type { Env } from "./env";
import rawModel from "../system/model.json" with { type: "json" };
import { listInstalledRepos, type InstalledRepo } from "./github/client";
import { callerIp, checkRate, rateLimitedResponse, type RateLimitPolicy } from "./rate-limit";
import { parseSystemModel, toPublic, type SystemModel } from "./system-model";

// The public data build (design capsid/research/design-system-explorer.md, section 2;
// docs/public-data.md). Once a UTC day the tick reads every repo's visibility from
// GitHub, runs the model through toPublic and stores the result in KV. The route
// below serves that stored document and nothing else: it never reads D1 or GitHub, so
// a request cannot make the Worker compute anything.
//
// Its readers are the explorer's and dustinedwards.info's builds, not browsers
// (answer 4), so the response carries no CORS header.

export const PUBLIC_MODEL_PATH = "/public/model/v1.json";
export const PUBLIC_MODEL_KEY = "public:model:v1";
export const PUBLIC_BUILD_LAST_KEY = "public:model:last";
const CACHE_SECONDS = 3600;

// Fail closed: an unreadable counter refuses rather than serve without a limit. The
// edge cache answers most requests before the counter is read at all.
export const PUBLIC_DATA_LIMIT: RateLimitPolicy = {
  prefix: "public:rate:",
  perHour: 120,
  perDay: 1000,
  label: "PUBLIC_DATA",
  onUnavailable: "refuse",
};

/** The model the Worker was built with. A model that fails its schema fails the
 *  build step loudly, every day, rather than publish a partial map. */
function bundledModel(): SystemModel {
  const parsed = parseSystemModel(rawModel);
  if (!parsed.ok) throw new Error(`system/model.json is invalid: ${parsed.problems.join("; ")}`);
  return parsed.model;
}

export type PublicBuildReport = { ran: false; note: string } | { ran: true; note: string };

/**
 * Builds and stores the public model once per UTC day. A failed visibility read throws
 * before anything is written, so the stored document stays the last good one; a
 * partial read cannot happen (listInstalledRepos throws on one).
 */
export async function publicBuildTick(
  env: Env,
  now: Date,
  listRepos: (env: Env) => Promise<{ repos: InstalledRepo[] }> = listInstalledRepos,
  model: SystemModel = bundledModel()
): Promise<PublicBuildReport> {
  const today = now.toISOString().slice(0, 10);
  const last = await env.APP_KV.get(PUBLIC_BUILD_LAST_KEY);
  if (last && last.slice(0, 10) === today) return { ran: false, note: `already built ${last}` };

  const { repos } = await listRepos(env);
  const privacy = new Map(repos.map((r) => [r.full_name.toLowerCase(), r.private] as const));
  const doc = toPublic(model, privacy, today);
  await env.APP_KV.put(PUBLIC_MODEL_KEY, JSON.stringify(doc));
  await env.APP_KV.put(PUBLIC_BUILD_LAST_KEY, now.toISOString());
  const c = doc.counts;
  return {
    ran: true,
    note: `${c.public} public and ${c.private} private system(s), ${c.containers} container(s), ${c.relationships} relationship(s); visibility read for ${repos.length} repo(s)`,
  };
}

function json(body: string, status: number, cache: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json;charset=utf-8", "Cache-Control": cache } });
}

/**
 * GET /public/model/v1.json. The colo's cache first, so a cached answer costs no KV
 * read and no counter; then the per-IP limit; then the stored document. 503 until the
 * first build, and never a computed fallback.
 */
export async function handlePublicModel(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  now: Date = new Date(),
  cache: Cache | undefined = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches?.default
): Promise<Response> {
  // The query string is not part of the key, so it cannot be used to miss the cache.
  const key = new Request(new URL(PUBLIC_MODEL_PATH, request.url).toString());
  const hit = await cache?.match(key);
  if (hit) return hit;

  const verdict = await checkRate(env.APP_KV, callerIp(request), now, PUBLIC_DATA_LIMIT);
  if (!verdict.allowed) return rateLimitedResponse(verdict, "requests");

  const stored = await env.APP_KV.get(PUBLIC_MODEL_KEY);
  if (!stored) return json(JSON.stringify({ error: "not computed yet" }), 503, "no-store");
  const response = json(stored, 200, `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`);
  if (cache) ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}
