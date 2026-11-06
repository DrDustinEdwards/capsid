import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { readBuildLog, readSiteSearch, readSiteTraffic, readWorkersBuilds } from "../src/portal-site";

// A site page's reads (src/portal-site.ts) against a real D1, the outside services stubbed:
// each source answers its data or no data with the reason, never a zero, and one source
// failing leaves the others.

const NOW = new Date("2026-11-06T12:00:00.000Z");
const BUILD = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function siteEnv(extra: Partial<Env>): Env {
  return { ...(env as unknown as Env), GSC_SERVICE_ACCOUNT_KEY: undefined, BING_WEBMASTER_API_KEY: undefined, CF_OPS_TOKEN: undefined, ...extra } as Env;
}

// Answers by URL; anything not listed fails the test's read loudly.
function stub(routes: Array<[RegExp, (url: URL, init?: RequestInit) => Response]>) {
  const calls: string[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    calls.push(input);
    const url = new URL(input);
    const hit = routes.find(([pattern]) => pattern.test(input));
    return hit ? hit[1](url, init) : new Response(`not stubbed: ${input}`, { status: 599 });
  };
  return { calls, fetchImpl };
}

const netDate = (day: string) => `/Date(${Date.parse(`${day}T00:00:00Z`)})/`;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM ops_sites WHERE namespace = 'sample'").run();
  await env.DB.prepare(
    "INSERT INTO ops_sites (namespace, name, origin, health_path, platform, script, self_probe) VALUES ('sample', 'Sample', 'https://sample.example.com', '/health', 'cloudflare', 'sample-site', 0)"
  ).run();
});

afterEach(async () => {
  await env.DB.prepare("DELETE FROM ops_sites WHERE namespace = 'sample'").run();
});

describe("a site page's search tab", () => {
  it("serves Bing's data beside Google's reason, and a namespace with no site has a reason for both", async () => {
    const { fetchImpl } = stub([
      [/\/GetUserSites\?/, () => Response.json({ d: [{ Url: "https://sample.example.com/", IsVerified: true }] })],
      [/\/GetRankAndTrafficStats\?/, () => Response.json({ d: [{ Date: netDate("2026-10-20"), Clicks: 4, Impressions: 90 }, { Date: netDate("2026-10-21"), Clicks: 1, Impressions: 30 }] })],
      [/\/GetQueryStats\?/, () => Response.json({ d: [{ Query: "sample query", Date: netDate("2026-10-20"), Clicks: 5, Impressions: 120, AvgImpressionPosition: 7 }] })],
      [/\/GetPageStats\?/, () => Response.json({ d: [] })],
    ]);
    const search = await readSiteSearch(siteEnv({ BING_WEBMASTER_API_KEY: "sample-bing-key" }), "sample", fetchImpl, NOW);
    expect(search.google).toMatchObject({ ok: false, kind: "not_configured" });
    expect(search.google.ok || search.google.reason).toMatch(/GSC_SERVICE_ACCOUNT_KEY/);
    expect(search.bing.ok).toBe(true);
    if (!search.bing.ok) return;
    expect(search.bing.data.totals).toEqual({ clicks: 5, impressions: 120 });
    expect(search.bing.data.days.map((d) => d.date)).toEqual(["2026-10-20", "2026-10-21"]);
    expect(search.bing.data.queries).toEqual([{ key: "sample query", clicks: 5, impressions: 120, ctr: 0.0417, position: 7 }]);
    expect(search.bing.data.pages).toEqual([]);

    const unknown = await readSiteSearch(siteEnv({ BING_WEBMASTER_API_KEY: "sample-bing-key" }), "sample-none", fetchImpl, NOW);
    for (const source of [unknown.google, unknown.bing]) expect(source).toMatchObject({ ok: false, kind: "no_site" });
  });
});

describe("a site page's traffic tab", () => {
  it("serves each report on its own: 404s, zero 5xx as a real zero, and a failed web vitals read as its reason", async () => {
    const { fetchImpl } = stub([
      [
        /\/analytics\/sql$/,
        (_url, init) => {
          const query = String(JSON.parse(String(init?.body)).query);
          if (query.includes("edgeResponseStatus = 404")) return Response.json({ data: [{ path: "/old-page", hits: 12 }, { path: "/wp-login.php", hits: 30 }] });
          if (query.includes("userAgent")) return Response.json({ data: [{ ua: "Mozilla/5.0 (compatible; GPTBot/1.2)", status: 402, hits: 8 }] });
          return Response.json({ data: [] });
        },
      ],
      [/\/rum\/site_info\/list/, () => Response.json({ success: false, errors: [{ message: "Authentication error" }] }, { status: 403 })],
    ]);
    const traffic = await readSiteTraffic(siteEnv({ CF_OPS_TOKEN: "sample-ops-token", CF_ACCOUNT_ID: "sample-account" }), "sample", 7, fetchImpl, NOW);
    expect(traffic.not_found.ok && traffic.not_found.data.paths.map((p) => [p.path, p.probe])).toEqual([
      ["/old-page", false],
      ["/wp-login.php", true],
    ]);
    expect(traffic.server_errors.ok && traffic.server_errors.data.failures).toEqual([]);
    expect(traffic.web_vitals).toMatchObject({ ok: false, kind: "error" });
    expect(traffic.ai_crawlers.ok && traffic.ai_crawlers.data.crawlers.map((c) => [c.name, c.statuses])).toEqual([["GPTBot", { "402": 8 }]]);

    const unset = await readSiteTraffic(siteEnv({}), "sample", 7, fetchImpl, NOW);
    for (const report of [unset.not_found, unset.server_errors, unset.web_vitals, unset.ai_crawlers]) expect(report).toMatchObject({ ok: false, kind: "not_configured" });
  });
});

describe("a site page's deploys tab", () => {
  it("lists the Worker's builds with the message as text, reads one build's log, and says when there are none", async () => {
    let builds: unknown[] = [
      {
        build_uuid: BUILD,
        status: "stopped",
        build_outcome: "success",
        created_on: "2026-11-05T10:00:00Z",
        build_trigger_metadata: { branch: "main", commit_hash: "c".repeat(40), commit_message: "Fix the sample page", build_trigger_source: "push_event" },
      },
    ];
    const { fetchImpl } = stub([
      [/\/workers\/scripts$/, () => Response.json({ success: true, result: [{ id: "sample-site", tag: "sampletag" }] })],
      [/\/builds\/workers\/sampletag\/builds/, () => Response.json({ success: true, result: builds })],
      [new RegExp(`/builds/builds/${BUILD}/logs$`), () => Response.json({ success: true, result: { lines: [["2026-11-05T10:00:01Z", "Installing"], ["2026-11-05T10:00:09Z", "Deployed"]], truncated: false } })],
    ]);
    const cfEnv = siteEnv({ CF_OPS_TOKEN: "sample-ops-token", CF_ACCOUNT_ID: "sample-account" });
    const listed = await readWorkersBuilds(cfEnv, "sample", 10, fetchImpl, NOW);
    expect(listed.script).toBe("sample-site");
    expect(listed.builds.ok && listed.builds.data.builds.map((b) => [b.build_uuid, b.outcome, b.commit_message])).toEqual([[BUILD, "success", "Fix the sample page"]]);

    const log = await readBuildLog(cfEnv, BUILD, fetchImpl, NOW);
    expect(log.log.ok && log.log.data.lines).toEqual(["2026-11-05T10:00:01Z Installing", "2026-11-05T10:00:09Z Deployed"]);

    builds = [];
    expect((await readWorkersBuilds(cfEnv, "sample", 10, fetchImpl, NOW)).builds).toMatchObject({ ok: false, kind: "empty" });
  });
});
