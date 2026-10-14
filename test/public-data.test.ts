import assert from "node:assert/strict";
import { test } from "node:test";
import type { InstalledRepo } from "../src/github/client.ts";
import {
  PUBLIC_BUILD_LAST_KEY,
  PUBLIC_DATA_LIMIT,
  PUBLIC_MODEL_KEY,
  PUBLIC_DOCS,
  PUBLIC_MODEL_PATH,
  PUBLIC_STATS_KEY,
  handlePublicDocument,
  publicBuildTick,
  type PublicBuildReaders,
} from "../src/public-data.ts";
import { PublicStatsSchema, type StatsRows } from "../src/public-stats.ts";
import { PublicModelSchema } from "../src/system-model.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// The daily build and the route that serves it (docs/public-data.md). The filter itself
// is tested in test/system-model.test.ts; this file covers when the build runs, what it
// writes, and what the route answers.

const NOW = new Date("2026-10-11T00:05:00Z");
const ctx = { waitUntil: (_p: Promise<unknown>) => {} };

// GitHub's answer for every repo the bundled model names, as measured 2026-10-10.
const PRIVATE_REPOS = new Set(["germomics", "foxing", "foxhound", "txasm", "julieedwards-info"]);
const NO_ROWS = (systems: StatsRows["systems"]): StatsRows => ({ finished: [], open: [], outcomes: [], evaluations: [], waits: [], rings: [], documents: 0, namespaces: 0, systems, sha: undefined });
function githubSays(names: string[]): PublicBuildReaders {
  return {
    listRepos: async () => ({
      repos: names.map((n): InstalledRepo => ({ full_name: `DrDustinEdwards/${n}`, private: PRIVATE_REPOS.has(n), archived: false, pushed_at: null })),
    }),
    statsRows: async (_env, _now, systems) => NO_ROWS(systems),
  };
}
const ALL = ["capsid", "capsomer", "site-runtime", "d1-dump", "devkit", "site-api", "prelum", "carrel", "enarratio", "dustinedwards-info", "claude-skills", ...PRIVATE_REPOS];

test("the build runs once a UTC day and stores the filtered bundled model", async () => {
  const kv = fakeKv();
  const env = fakeEnv({ APP_KV: kv.kv });
  const first = await publicBuildTick(env, NOW, githubSays(ALL));
  assert.equal(first.ran, true, first.note);
  assert.match(first.note, /12 public and 5 private system\(s\)/);

  const doc = PublicModelSchema.parse(JSON.parse(kv.store.get(PUBLIC_MODEL_KEY) ?? "null"));
  assert.equal(doc.as_of, "2026-10-11");
  const foxhound = doc.systems.find((s) => s.id === "foxhound");
  assert.deepEqual(foxhound, { id: "foxhound", name: "Foxhound", short: "Foxhound", domain: "foxhoundapp.com", family: "product", ring: "used", private: true });
  // Answer 15: Skills shows no repo link.
  const skills = doc.systems.find((s) => s.id === "skills");
  assert.ok(skills && !skills.private && skills.repos === undefined);
  // Answer 6: a public-to-private line keeps its system ends and loses nothing else.
  assert.ok(doc.relationships.some((r) => r.id === "capsid--coordinates--foxhound"));
  // The numbers are built in the same run, and carry the model's system counts.
  const stats = PublicStatsSchema.parse(JSON.parse(kv.store.get(PUBLIC_STATS_KEY) ?? "null"));
  assert.deepEqual(stats.systems, { public: 12, private: 5 });
  assert.equal(stats.as_of, "2026-10-11");

  const again = await publicBuildTick(env, new Date("2026-10-11T23:55:00Z"), githubSays(ALL));
  assert.equal(again.ran, false, "it ran twice in one UTC day");
  assert.equal(kv.puts.filter((p) => p.key === PUBLIC_MODEL_KEY).length, 1);
});

test("a public repo GitHub does not list is published as private, and a failed read writes nothing", async () => {
  const kv = fakeKv({ seed: { [PUBLIC_MODEL_KEY]: "last good" } });
  const env = fakeEnv({ APP_KV: kv.kv });
  const partial = await publicBuildTick(env, NOW, githubSays(ALL.filter((n) => n !== "carrel")));
  assert.equal(partial.ran, true);
  const doc = PublicModelSchema.parse(JSON.parse(kv.store.get(PUBLIC_MODEL_KEY) ?? "null"));
  assert.equal(doc.systems.find((s) => s.id === "carrel")?.private, true);

  const failing = fakeKv({ seed: { [PUBLIC_MODEL_KEY]: "last good", [PUBLIC_STATS_KEY]: "last stats" } });
  const failingReaders: PublicBuildReaders = {
    listRepos: githubSays(ALL).listRepos,
    statsRows: async () => {
      throw new Error("D1_ERROR: no such table");
    },
  };
  await assert.rejects(publicBuildTick(fakeEnv({ APP_KV: failing.kv }), NOW, failingReaders), /D1_ERROR/);
  assert.equal(failing.store.get(PUBLIC_MODEL_KEY), "last good", "the model was written although the stats read failed");
  assert.equal(failing.store.get(PUBLIC_STATS_KEY), "last stats");
  assert.equal(failing.store.has(PUBLIC_BUILD_LAST_KEY), false, "a failed build was stamped as done, so it would not retry today");
});

function get(ip = "203.0.113.9", query = ""): Request {
  return new Request(`https://mcp.dustinedwards.info${PUBLIC_MODEL_PATH}${query}`, { headers: { "CF-Connecting-IP": ip } });
}

test("the route serves the stored document with cache headers and no CORS, and 503 before the first build", async () => {
  const empty = fakeKv();
  const before = await handlePublicDocument(get(), fakeEnv({ APP_KV: empty.kv }), ctx, PUBLIC_DOCS.model, NOW, undefined);
  assert.equal(before.status, 503);
  assert.deepEqual(await before.json(), { error: "not computed yet" });
  assert.equal(before.headers.get("Cache-Control"), "no-store");

  const kv = fakeKv({ seed: { [PUBLIC_MODEL_KEY]: '{"version":1}' } });
  const res = await handlePublicDocument(get(), fakeEnv({ APP_KV: kv.kv }), ctx, PUBLIC_DOCS.model, NOW, undefined);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"version":1}');
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=3600, s-maxage=3600");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test("past the per-IP limit the route answers 429, and an unreadable counter refuses", async () => {
  const hourKey = `${PUBLIC_DATA_LIMIT.prefix}h:203.0.113.9:${NOW.toISOString().slice(0, 13)}`;
  const kv = fakeKv({ seed: { [PUBLIC_MODEL_KEY]: "{}", [hourKey]: String(PUBLIC_DATA_LIMIT.perHour) } });
  const limited = await handlePublicDocument(get(), fakeEnv({ APP_KV: kv.kv }), ctx, PUBLIC_DOCS.model, NOW, undefined);
  assert.equal(limited.status, 429);
  assert.match(await limited.text(), /too many requests: 120 in the last hour, limit 120/);

  const broken = fakeKv({ failGet: true });
  const refused = await handlePublicDocument(get(), fakeEnv({ APP_KV: broken.kv }), ctx, PUBLIC_DOCS.model, NOW, undefined);
  assert.equal(refused.status, 503);
  assert.match(await refused.text(), /requests are refused/);
});

test("a cached answer is served before the counter, and the query string cannot miss the cache", async () => {
  const stored = new Map<string, Response>();
  const cache = {
    match: async (req: Request) => stored.get(req.url)?.clone(),
    put: async (req: Request, res: Response) => void stored.set(req.url, res),
  } as unknown as Cache;
  const pending: Promise<unknown>[] = [];
  const kv = fakeKv({ seed: { [PUBLIC_MODEL_KEY]: '{"version":1}' } });
  await handlePublicDocument(get(), fakeEnv({ APP_KV: kv.kv }), { waitUntil: (p: Promise<unknown>) => void pending.push(p) }, PUBLIC_DOCS.model, NOW, cache);
  await Promise.all(pending);
  const putsAfterFirst = kv.puts.length;

  const broken = fakeKv({ failGet: true });
  const hit = await handlePublicDocument(get("198.51.100.7", "?bust=1"), fakeEnv({ APP_KV: broken.kv }), ctx, PUBLIC_DOCS.model, NOW, cache);
  assert.equal(hit.status, 200, "a cache hit still read KV, or the query string missed the cache");
  assert.equal(await hit.text(), '{"version":1}');
  assert.equal(kv.puts.length, putsAfterFirst);
});

test("each route serves its own stored document, and the stats route's cache key is its own", async () => {
  const kv = fakeKv({ seed: { [PUBLIC_MODEL_KEY]: '{"doc":"model"}', [PUBLIC_STATS_KEY]: '{"doc":"stats"}' } });
  const stored = new Map<string, Response>();
  const cache = {
    match: async (req: Request) => stored.get(req.url)?.clone(),
    put: async (req: Request, res: Response) => void stored.set(req.url, res),
  } as unknown as Cache;
  const pending: Promise<unknown>[] = [];
  const keep = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const model = await handlePublicDocument(get(), fakeEnv({ APP_KV: kv.kv }), keep, PUBLIC_DOCS.model, NOW, cache);
  await Promise.all(pending);
  const statsReq = new Request(`https://mcp.dustinedwards.info${PUBLIC_DOCS.stats.path}`, { headers: { "CF-Connecting-IP": "203.0.113.9" } });
  const stats = await handlePublicDocument(statsReq, fakeEnv({ APP_KV: kv.kv }), keep, PUBLIC_DOCS.stats, NOW, cache);
  assert.equal(await model.text(), '{"doc":"model"}');
  assert.equal(await stats.text(), '{"doc":"stats"}', "the stats route answered with the model's cached document");
});
