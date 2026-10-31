import assert from "node:assert/strict";
import { test } from "node:test";
import { bingDay, bingWebmaster, pickBingSite, sumStats } from "../src/bing-webmaster.ts";
import { fakeEnv } from "./fakes.ts";

// Bing Webmaster Tools for a namespace's site (src/bing-webmaster.ts), served as
// capsid_inspect_repo action bing. The namespace picks the Bing site, only Get methods
// are called, and the API key never reaches a result.

const NOW = new Date("2026-10-18T12:00:00.000Z");
const ORIGIN = "https://sample.example.com";
const KEY = "fake-bing-key-0123456789";

const ROW = {
  namespace: "sample",
  name: "Sample",
  origin: ORIGIN,
  health_path: "/health",
  platform: "cloudflare",
  script: "sample-site",
  self_probe: 0,
  revision: 1,
  updated_at: "2026-10-01 00:00:00",
  operator: null,
};

function siteDb() {
  return {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (!/FROM ops_sites WHERE namespace = \?1/.test(sql)) throw new Error(`unexpected statement: ${sql}`);
          return params[0] === ROW.namespace ? ROW : null;
        },
      }),
    }),
  };
}

const day = (iso: string) => `/Date(${Date.parse(`${iso}T00:00:00Z`)})/`;

function bingApi(d: Record<string, unknown>) {
  const calls: URL[] = [];
  const impl = async (url: string) => {
    const u = new URL(url);
    calls.push(u);
    const method = u.pathname.split("/").pop()!;
    if (!(method in d)) throw new Error(`unrouted ${method}`);
    return Response.json({ d: d[method] });
  };
  return { impl, calls };
}

test("bingDay reads .NET JSON dates, with and without an offset", () => {
  assert.equal(bingDay("/Date(1760745600000)/"), "2025-10-18");
  assert.equal(bingDay("/Date(1760745600000-0700)/"), "2025-10-18");
  assert.equal(bingDay("2025-10-18"), null);
});

test("pickBingSite takes the exact origin, else the same host, and skips unverified sites", () => {
  const sites = [
    { Url: "http://sample.example.com/", IsVerified: true },
    { Url: "https://sample.example.com/", IsVerified: false },
    { Url: "https://other.example.net/", IsVerified: true },
  ];
  assert.equal(pickBingSite(ORIGIN, sites), "http://sample.example.com/");
  assert.equal(pickBingSite(ORIGIN, [...sites, { Url: "https://sample.example.com", IsVerified: true }]), "https://sample.example.com");
  assert.equal(pickBingSite("https://none.example.org", sites), null);
});

test("sumStats sums each query's weekly buckets inside the window and weights position by impressions", () => {
  const rows = [
    { Query: "getting started", Date: day("2026-09-21"), Clicks: 2, Impressions: 10, AvgImpressionPosition: 4 },
    { Query: "getting started", Date: day("2026-09-28"), Clicks: 1, Impressions: 30, AvgImpressionPosition: 8 },
    { Query: "getting started", Date: day("2026-08-01"), Clicks: 50, Impressions: 500, AvgImpressionPosition: 1 },
    { Query: "lysis", Date: day("2026-09-28"), Clicks: 0, Impressions: 5, AvgImpressionPosition: -1 },
  ];
  assert.deepEqual(sumStats(rows, "2026-09-18", "2026-10-15", "query", 1), {
    rows: [{ query: "getting started", clicks: 3, impressions: 40, position: 7 }],
    total_rows: 2,
    truncated: true,
  });
});

test("queries call only Get methods for the namespace's site, and the key never reaches the result", async () => {
  const api = bingApi({
    GetUserSites: [{ Url: "https://sample.example.com/", IsVerified: true }],
    GetQueryStats: [{ Query: "getting started", Date: day("2026-10-05"), Clicks: 4, Impressions: 40, AvgImpressionPosition: 6 }],
  });
  const env = fakeEnv({ DB: siteDb(), BING_WEBMASTER_API_KEY: KEY });
  const r = await bingWebmaster(env, "sample", {}, api.impl, NOW);
  assert.deepEqual(api.calls.map((u) => u.pathname.split("/").pop()), ["GetUserSites", "GetQueryStats"]);
  assert.equal(api.calls[1].searchParams.get("siteUrl"), "https://sample.example.com/");
  assert.ok("rows" in r);
  assert.deepEqual(r.rows, [{ query: "getting started", clicks: 4, impressions: 40, position: 6 }]);
  assert.ok(!JSON.stringify(r).includes(KEY), "the API key reached the result");
});

test("inspect refuses a URL on another host before calling Bing, and no key fetches nothing", async () => {
  const api = bingApi({});
  await assert.rejects(
    () => bingWebmaster(fakeEnv({ DB: siteDb(), BING_WEBMASTER_API_KEY: KEY }), "sample", { report: "inspect", url: "https://other.example.net/" }, api.impl, NOW),
    /must be a page on sample's site/
  );
  await assert.rejects(() => bingWebmaster(fakeEnv({ DB: siteDb() }), "sample", {}, api.impl, NOW), /BING_WEBMASTER_API_KEY is not set/);
  assert.equal(api.calls.length, 0);
});
