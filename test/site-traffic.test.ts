import assert from "node:assert/strict";
import { test } from "node:test";
import { siteTraffic } from "../src/site-traffic.ts";
import { fakeEnv } from "./fakes.ts";

// The traffic report for a namespace's site (src/site-traffic.ts), served as
// capsid_inspect_repo action traffic: the 404s Cloudflare's edge recorded for the
// namespace's own host, scanners' probes last.

const NOW = new Date("2026-10-25T12:00:00.000Z");
const ROW = {
  namespace: "sample",
  name: "Sample",
  origin: "https://sample.example.com",
  health_path: "/health",
  platform: "cloudflare",
  script: "sample-site",
  self_probe: 0,
  revision: 1,
  updated_at: "2026-10-01 00:00:00",
  operator: null,
};

const siteDb = () => ({
  prepare: (sql: string) => ({
    bind: (...params: unknown[]) => ({
      first: async () => {
        if (!/FROM ops_sites WHERE namespace = \?1/.test(sql)) throw new Error(`unexpected statement: ${sql}`);
        return params[0] === ROW.namespace ? ROW : null;
      },
    }),
  }),
});

test("not_found asks for the namespace's own host only and lists scanners' probes after real pages", async () => {
  const calls: Array<{ url: string; body: { query: string; params: Record<string, unknown>; scope: unknown } }> = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return Response.json({
      data: [
        { path: "/wp-login.php", hits: 90 },
        { path: "/old-post", hits: 40 },
        { path: "/gone", hits: 5 },
      ],
    });
  };
  const env = fakeEnv({ DB: siteDb(), CF_OPS_TOKEN: "fake-token", CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" });
  const r = await siteTraffic(env, "sample", { days: 3 }, impl, NOW);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/analytics/sql");
  assert.deepEqual(calls[0].body.params, { start: "2026-10-22T12:00:00.000Z", host: "sample.example.com" });
  assert.deepEqual(calls[0].body.scope, { accountTag: "0123456789abcdef0123456789abcdef" });
  assert.match(calls[0].body.query, /edgeResponseStatus = 404/);

  assert.ok("paths" in r);
  assert.deepEqual(r.paths.map((p) => p.path), ["/old-post", "/gone", "/wp-login.php"]);
  assert.equal(r.probes, 1);
  await assert.rejects(() => siteTraffic(env, "sample", { days: 31 }, impl, NOW), /days must be a whole number from 1 to 30/);
});

test("ai_crawlers names each crawler by Prelum's lists, the longest name first, with hits by status", async () => {
  const impl = async () =>
    Response.json({
      data: [
        { ua: "Mozilla/5.0 (compatible; Claude-SearchBot/1.0)", status: 200, hits: 30 },
        { ua: "Mozilla/5.0 (compatible; ClaudeBot/1.0)", status: 402, hits: 12 },
        { ua: "Mozilla/5.0 (compatible; ClaudeBot/1.0)", status: 200, hits: 3 },
        { ua: "Mozilla/5.0 (Linux; Android 10; K) Bytespider", status: 403, hits: 7 },
        { ua: "Mozilla/5.0 (Windows NT 10.0) Chrome/140", status: 200, hits: 900 },
      ],
    });
  const env = fakeEnv({ DB: siteDb(), CF_OPS_TOKEN: "fake-token", CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" });
  const r = await siteTraffic(env, "sample", { report: "ai_crawlers" }, impl, NOW);
  assert.ok("crawlers" in r);
  assert.deepEqual(r.crawlers, [
    { name: "Bytespider", kind: "denied", hits: 7, statuses: { "403": 7 } },
    { name: "ClaudeBot", kind: "training", hits: 15, statuses: { "402": 12, "200": 3 } },
    { name: "Claude-SearchBot", kind: "ai_search", hits: 30, statuses: { "200": 30 } },
  ]);
});

test("server_errors lists 5xx by path and status, and fits capsid_inspect_repo's served output schema", async () => {
  const impl = async () => Response.json({ data: [{ path: "/feed", status: 503, hits: 9 }, { path: "/", status: 500, hits: 2 }] });
  const env = fakeEnv({ DB: siteDb(), CF_OPS_TOKEN: "fake-token", CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" });
  const r = await siteTraffic(env, "sample", { report: "server_errors", days: 1 }, impl, NOW);
  assert.ok("failures" in r);
  assert.deepEqual(r.failures, [{ path: "/feed", status: 503, hits: 9 }, { path: "/", status: 500, hits: 2 }]);
  // REPLAY (2026-10-31): the rows were first named `errors`, which site_audit serves as a number,
  // so the SDK refused every server_errors answer as invalid structured content.
  const { COMPOSITES } = await import("../src/tools/surface.ts");
  const { toolOutput } = await import("../src/tools/outputs.ts");
  const inspect = COMPOSITES.find((c) => c.name === "capsid_inspect_repo");
  assert.ok(inspect);
  const parsed = toolOutput(Object.values(inspect.actions).map((a) => a.op)).safeParse(r);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
});
