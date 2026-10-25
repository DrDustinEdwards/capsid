import assert from "node:assert/strict";
import { test } from "node:test";
import { siteTraffic } from "../src/site-traffic.ts";
import { fakeEnv } from "./fakes.ts";

// The traffic report for a namespace's site (src/site-traffic.ts), served as
// capsid_inspect_repo action traffic: the 404s Cloudflare's edge recorded for the
// namespace's own host, a broken link on the site first and scanners' probes last.

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

test("not_found asks for the namespace's own host only and ranks a broken link on the site above stale links, direct hits and probes", async () => {
  const calls: Array<{ url: string; body: { query: string; params: Record<string, unknown>; scope: unknown } }> = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return Response.json({
      data: [
        { path: "/wp-login.php", referrer: "", hits: 90 },
        { path: "/old-post", referrer: "", hits: 40 },
        { path: "/old-post", referrer: "news.example.org", hits: 12 },
        { path: "/papers/typo", referrer: "sample.example.com", hits: 3 },
        { path: "/gone", referrer: "", hits: 5 },
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

  assert.deepEqual(r.paths.map((p) => p.path), ["/papers/typo", "/old-post", "/gone", "/wp-login.php"]);
  assert.deepEqual(r.paths[1], { path: "/old-post", hits: 52, from_site: 0, from_elsewhere: 12, direct: 40, top_referrers: [{ referrer: "news.example.org", hits: 12 }], probe: false });
  assert.equal(r.broken_links_on_site, 1);
  assert.equal(r.probes, 1);
  await assert.rejects(() => siteTraffic(env, "sample", { days: 31 }, impl, NOW), /days must be a whole number from 1 to 30/);
});
