import assert from "node:assert/strict";
import { test } from "node:test";
import { STANDARD_SECURITY_HEADERS } from "@dustinedwards/site-runtime/headers";
import {
  DEPLOY_GRACE_MINUTES,
  analyticsFinding,
  MAX_PAGE_BYTES,
  MAX_PAGE_RULES,
  MAX_ANALYTICS_RULES,
  MAX_SHA_RULES,
  beaconCount,
  cspAllowsBeaconReport,
  cspAllowsBeaconScript,
  liveChecks,
  pageFindings,
  parseCsp,
  parseLiveConfig,
  readPage,
  shaFinding,
  slug,
  type FetchLike,
  type LiveRule,
} from "../src/live-checks.ts";
import type { OpsSite } from "../src/ops-sites.ts";
import type { SiteProbe, WebAnalyticsSite } from "../src/ops-types.ts";
import { gatherFindings, owningCheck, WATCHER_CHECKS } from "../src/watcher.ts";
import { fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// The watcher's live checks (src/live-checks.ts). The beacon snippet, the CSP
// directives and the rule that Cloudflare reports to the site's own /cdn-cgi/rum are
// from developers.cloudflare.com/web-analytics/faq. A real page from a real site could
// not be fetched from the build sandbox, so the HTML below is the documented snippet.

const NOW = new Date("2026-10-04T12:00:00.000Z");
const BEACON = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "sample"}'></script>`;
const page = (body: string) => `<!doctype html><html><head><title>Sample</title></head><body>${body}</body></html>`;

const SITE: OpsSite = { namespace: "sample", name: "Sample", origin: "https://sample.example.com", healthPath: "/health", platform: "cloudflare" };
const probe = (over: Partial<SiteProbe> = {}): SiteProbe => ({
  namespace: "sample",
  name: "Sample",
  origin: SITE.origin,
  health_path: "/health",
  platform: "cloudflare",
  state: "ok",
  http_status: 200,
  latency_ms: 10,
  sha: "a".repeat(40),
  error: null,
  checked_at: NOW.toISOString(),
  ...over,
});

// the document

test("parseLiveConfig reads only '- site' lines, in all three rules, and ignores prose", () => {
  const parsed = parseLiveConfig(
    [
      "# Live checks",
      "A paragraph that mentions site sample beacon / in prose.",
      "- site sample beacon /",
      "- site sample beacon /pricing",
      "- site sample nobeacon /account/settings",
      "- site sample headers /",
      "- site sample sha",
      "- an ordinary bullet",
    ].join("\n")
  );
  assert.deepEqual(parsed, {
    rules: [
      { namespace: "sample", kind: "beacon", path: "/" },
      { namespace: "sample", kind: "beacon", path: "/pricing" },
      { namespace: "sample", kind: "nobeacon", path: "/account/settings" },
      { namespace: "sample", kind: "headers", path: "/" },
      { namespace: "sample", kind: "sha" },
    ],
  });
});

test("PLANT: a '- site' line that does not parse refuses the whole document, naming the line", () => {
  const bad = [
    "- site sample beacon",
    "- site sample beacon pricing",
    "- site sample beacon /pricing?x=1",
    "- site sample beacon https://other.example.com/",
    "- site sample beacon /a /b",
    "- site sample sha /",
    "- site sample whatever /",
    "- site Sample beacon /",
    "- site capsid sha",
    "- site",
  ];
  for (const line of bad) {
    const parsed = parseLiveConfig(`- site sample beacon /\n${line}`);
    assert.ok("error" in parsed, `accepted: ${line}`);
    assert.match(parsed.error, /line 2/, `the error does not name the line for: ${line}`);
  }
});

test("the document is bounded in page rules and in sha rules", () => {
  const pages = Array.from({ length: MAX_PAGE_RULES + 1 }, (_, i) => `- site sample beacon /p${i}`).join("\n");
  assert.ok("error" in parseLiveConfig(pages));
  const shas = Array.from({ length: MAX_SHA_RULES + 1 }, (_, i) => `- site s${i} sha`).join("\n");
  assert.ok("error" in parseLiveConfig(shas));
  const analytics = (n: number) => Array.from({ length: n }, (_, i) => `- site s${i} analytics`).join("\n");
  assert.ok("error" in parseLiveConfig(analytics(MAX_ANALYTICS_RULES + 1)));
  assert.ok("rules" in parseLiveConfig(analytics(MAX_ANALYTICS_RULES)));
  assert.ok("rules" in parseLiveConfig(Array.from({ length: MAX_PAGE_RULES }, (_, i) => `- site sample beacon /p${i}`).join("\n")));
});

test("slug: a path as one fingerprint-safe word", () => {
  assert.equal(slug("/"), "root");
  assert.equal(slug("/Account/Settings/"), "account-settings");
  assert.equal(slug("/a_b.c"), "a-b-c");
});

// the beacon

test("beaconCount counts script tags that load the beacon, in any quoting and for a protocol-relative src", () => {
  assert.equal(beaconCount(page("")), 0);
  assert.equal(beaconCount(page(BEACON)), 1);
  assert.equal(beaconCount(page(`<script src='https://static.cloudflareinsights.com/beacon.min.js'></script>`)), 1);
  assert.equal(beaconCount(page(`<SCRIPT DEFER SRC=//static.cloudflareinsights.com/beacon.min.js></SCRIPT>`)), 1);
  assert.equal(beaconCount(page(BEACON + BEACON)), 2);
});

test("beaconCount does not count other scripts, a mention in text, or a lookalike host", () => {
  assert.equal(beaconCount(page(`<script src="https://example.com/app.js"></script>`)), 0);
  assert.equal(beaconCount(page(`<p>static.cloudflareinsights.com is where the beacon lives</p>`)), 0);
  assert.equal(beaconCount(page(`<script src="https://static.cloudflareinsights.com.evil.example/x.js"></script>`)), 0);
  assert.equal(beaconCount(page(`<script>var u = "https://static.cloudflareinsights.com/beacon.min.js";</script>`)), 0);
});

// the CSP

const csp = (header: string) => parseCsp(header);

test("parseCsp: directives per policy, the first occurrence wins, several policies on one header", () => {
  const [one] = csp("default-src 'self'; script-src a.example; script-src b.example");
  assert.deepEqual(one.get("script-src"), ["a.example"]);
  assert.equal(csp("default-src 'self', script-src 'none'").length, 2);
  assert.deepEqual(csp(""), []);
});

test("script: the host, a wildcard, https:, * and an absent directive allow the beacon; default-src is the fallback", () => {
  for (const header of [
    "script-src 'self' https://static.cloudflareinsights.com",
    "script-src static.cloudflareinsights.com",
    "script-src https://*.cloudflareinsights.com",
    "script-src https:",
    "script-src *",
    "default-src 'self' https://static.cloudflareinsights.com",
    "img-src 'self'",
    "default-src 'self' https://static.cloudflareinsights.com; script-src 'self' https://static.cloudflareinsights.com/beacon.min.js",
  ]) {
    assert.deepEqual(cspAllowsBeaconScript(csp(header)), { ok: true, why: null }, header);
  }
});

test("PLANT: a CSP that blocks the beacon script is reported, whichever way it blocks", () => {
  for (const header of [
    "script-src 'self'",
    "default-src 'self'",
    "script-src 'none'",
    "script-src",
    "script-src 'nonce-abc' 'strict-dynamic' https://static.cloudflareinsights.com",
    "script-src https://cloudflareinsights.com",
    "script-src https://evil-static.cloudflareinsights.com",
    "script-src 'self' https://static.cloudflareinsights.com, script-src 'self'",
  ]) {
    const verdict = cspAllowsBeaconScript(csp(header));
    assert.equal(verdict.ok, false, `allowed: ${header}`);
    assert.ok(verdict.why);
  }
});

test("report: 'self' is enough on Cloudflare, never on another host, and the apex is not matched by a wildcard", () => {
  assert.equal(cspAllowsBeaconReport(csp("connect-src 'self'"), "cloudflare").ok, true);
  assert.equal(cspAllowsBeaconReport(csp("connect-src 'self'"), "vercel").ok, false);
  assert.equal(cspAllowsBeaconReport(csp("connect-src https://cloudflareinsights.com"), "vercel").ok, true);
  assert.equal(cspAllowsBeaconReport(csp("connect-src https://*.cloudflareinsights.com"), "vercel").ok, false);
  assert.equal(cspAllowsBeaconReport(csp("default-src 'self'"), "cloudflare").ok, true, "default-src is the fallback");
  assert.equal(cspAllowsBeaconReport(csp("connect-src 'none'"), "cloudflare").ok, false);
  assert.equal(cspAllowsBeaconReport(csp("script-src 'self'"), "vercel").ok, true, "no connect-src and no default-src allows it");
});

// findings from one page

const read = (html: string, csp?: string): Parameters<typeof pageFindings>[2] => ({
  status: 200,
  headers: new Headers(csp ? { "content-security-policy": csp } : {}),
  html,
  problem: null,
  gated: false,
});
const beaconRule: Extract<LiveRule, { path: string }> = { namespace: "sample", kind: "beacon", path: "/" };
const noBeaconRule: Extract<LiveRule, { path: string }> = { namespace: "sample", kind: "nobeacon", path: "/account" };
const prints = (findings: Array<{ fingerprint: string }>) => findings.map((f) => f.fingerprint);

test("a public page with one beacon and a CSP that allows it is clean", () => {
  const ok = "script-src 'self' https://static.cloudflareinsights.com; connect-src 'self'";
  assert.deepEqual(pageFindings(SITE, beaconRule, read(page(BEACON), ok)), []);
  assert.deepEqual(pageFindings(SITE, beaconRule, read(page(BEACON))), [], "no CSP at all blocks nothing");
});

test("a beacon rule no longer counts beacons: a Worker cannot see the one the edge injects, so none or two is not a finding", () => {
  assert.deepEqual(pageFindings(SITE, beaconRule, read(page(""))), []);
  assert.deepEqual(pageFindings(SITE, beaconRule, read(page(BEACON + BEACON))), []);
});

test("PLANT: a blocked script and a blocked report each file their own finding", () => {
  assert.deepEqual(prints(pageFindings(SITE, beaconRule, read(page(BEACON), "script-src 'self'; connect-src 'self'"))), ["live-csp-script-sample-root"]);
  assert.deepEqual(
    prints(pageFindings(SITE, beaconRule, read(page(BEACON), "script-src https://static.cloudflareinsights.com; connect-src 'none'"))),
    ["live-csp-report-sample-root"]
  );
  assert.deepEqual(prints(pageFindings(SITE, beaconRule, read(page(""), "default-src 'none'"))), [
    "live-csp-script-sample-root",
    "live-csp-report-sample-root",
  ]);
});

test("a page that must carry no beacon is clean without one and a finding with one; its CSP is not judged", () => {
  assert.deepEqual(pageFindings(SITE, noBeaconRule, read(page(""), "default-src 'none'")), []);
  assert.deepEqual(prints(pageFindings(SITE, noBeaconRule, read(page(BEACON)))), ["live-beacon-present-sample-account"]);
});

test("a page that was not read yields no finding about the beacon: not read is not clean and not dirty", () => {
  const unread = { status: 500, headers: null, html: null, problem: "answered 500", gated: false };
  assert.deepEqual(pageFindings(SITE, beaconRule, unread), []);
  assert.deepEqual(pageFindings(SITE, noBeaconRule, unread), []);
});

// the security headers

const headersRule: Extract<LiveRule, { path: string }> = { namespace: "sample", kind: "headers", path: "/" };
const GOOD_CSP = "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; report-uri /csp-report";
const goodHeaders = (): Headers => new Headers({ ...STANDARD_SECURITY_HEADERS, "content-security-policy": GOOD_CSP });
const withHeaders = (headers: Headers): Parameters<typeof pageFindings>[2] => ({ status: 200, headers, html: page(""), problem: null, gated: false });

test("a page that carries every standard header and an enforced policy is clean under the headers rule", () => {
  assert.deepEqual(pageFindings(SITE, headersRule, withHeaders(goodHeaders())), []);
});

test("PLANT: a missing header, a report-only policy and no policy at all each file one finding naming what failed", () => {
  const noFrame = goodHeaders();
  noFrame.delete("X-Frame-Options");
  const missing = pageFindings(SITE, headersRule, withHeaders(noFrame));
  assert.deepEqual(prints(missing), ["live-headers-sample-root"]);
  assert.ok(missing[0]?.evidence.some((line) => line.startsWith("X-Frame-Options is present")), "the finding names the header");

  const reportOnly = goodHeaders();
  reportOnly.set("content-security-policy-report-only", reportOnly.get("content-security-policy") ?? "");
  reportOnly.delete("content-security-policy");
  assert.deepEqual(prints(pageFindings(SITE, headersRule, withHeaders(reportOnly))), ["live-headers-sample-root"]);

  assert.deepEqual(prints(pageFindings(SITE, headersRule, withHeaders(new Headers()))), ["live-headers-sample-root"], "a response with none of them");
});

test("the headers rule counts a page read, and a page it cannot read is unread, not clean", async () => {
  const body = "- site sample headers /";
  const ok = await liveChecks({ body }, [SITE], [probe()], deps({ "/": () => new Response(page(""), { headers: { "content-type": "text/html", ...Object.fromEntries(goodHeaders()) } }) }), NOW);
  assert.deepEqual(ok.findings, []);
  assert.deepEqual(ok.summary, { pages_expected: 1, pages_read: 1, shas_expected: 0, shas_read: 0, analytics_expected: 0, analytics_read: 0 });
  const bare = await liveChecks({ body }, [SITE], [probe()], deps({ "/": () => html(page("")) }), NOW);
  assert.deepEqual(prints(bare.findings), ["live-headers-sample-root"]);
  const unread = await liveChecks({ body }, [SITE], [probe()], deps({ "/": () => new Response("no", { status: 500 }) }), NOW);
  assert.deepEqual(prints(unread.findings), ["live-page-unread-sample-root"]);
  assert.equal(unread.ran, false);
});

// the Web Analytics setting

const ANALYTICS_SITE = { namespace: "sample", name: "Sample", origin: "https://sample.example.com" };
const wa = (over: Partial<WebAnalyticsSite> = {}): WebAnalyticsSite => ({ host: "sample.example.com", auto_install: true, enabled: true, ...over });

test("analyticsFinding: automatic setup on is clean; a missing host, auto_install off and a switched-off ruleset each file their own finding", () => {
  assert.equal(analyticsFinding(ANALYTICS_SITE, [wa()]), null);
  assert.equal(analyticsFinding(ANALYTICS_SITE, [wa({ enabled: null })]), null, "a ruleset switch Cloudflare does not report is not a finding");
  assert.equal(analyticsFinding(ANALYTICS_SITE, [wa({ host: "other.example.com", auto_install: false })])?.fingerprint, "live-analytics-missing-sample");
  assert.equal(analyticsFinding(ANALYTICS_SITE, [])?.fingerprint, "live-analytics-missing-sample");
  assert.equal(analyticsFinding(ANALYTICS_SITE, [wa({ auto_install: false })])?.fingerprint, "live-analytics-off-sample");
  assert.equal(analyticsFinding(ANALYTICS_SITE, [wa({ auto_install: null })])?.fingerprint, "live-analytics-off-sample", "an unreported setting is not read as on");
  assert.equal(analyticsFinding(ANALYTICS_SITE, [wa({ enabled: false })])?.fingerprint, "live-analytics-off-sample");
});

test("the analytics rule takes no path, and reads the account's list once for any number of sites", async () => {
  assert.ok("error" in parseLiveConfig("- site sample analytics /"));
  const other: OpsSite = { ...SITE, namespace: "other", name: "Other", origin: "https://other.example.com" };
  let reads = 0;
  const counting = { ...deps({}), analytics: async () => (reads++, [wa(), wa({ host: "other.example.com", auto_install: false })]) };
  const out = await liveChecks({ body: "- site sample analytics\n- site other analytics" }, [SITE, other], [probe(), probe({ namespace: "other", name: "Other", origin: other.origin })], counting, NOW);
  assert.equal(reads, 1);
  assert.deepEqual(prints(out.findings), ["live-analytics-off-other"]);
  assert.equal(out.ran, true);
  assert.equal(out.summary.analytics_read, 2);
});

test("PLANT: an analytics read that fails is an unread finding for the site and leaves the check un-run, never clean", async () => {
  const failing = {
    ...deps({}),
    analytics: async (): Promise<WebAnalyticsSite[]> => {
      throw new Error("the Web Analytics sites list was refused with 403: CF_OPS_TOKEN lacks Account / Account Settings / Read");
    },
  };
  const out = await liveChecks({ body: "- site sample analytics" }, [SITE], [probe()], failing, NOW);
  assert.deepEqual(prints(out.findings), ["live-analytics-unread-sample"]);
  assert.match(out.findings[0]?.evidence[0] ?? "", /Account Settings \/ Read/);
  assert.equal(out.ran, false);
  assert.deepEqual(out.summary, { pages_expected: 0, pages_read: 0, shas_expected: 0, shas_read: 0, analytics_expected: 1, analytics_read: 0 });
});

// the sha

const HEAD = { sha: "b".repeat(40), committed_at: "2026-10-04T10:00:00.000Z" };

test("shaFinding: equal, a short prefix either way, and a head inside the grace are clean", () => {
  assert.equal(shaFinding(SITE, HEAD.sha, HEAD, NOW), null);
  assert.equal(shaFinding(SITE, HEAD.sha.slice(0, 7), HEAD, NOW), null);
  assert.equal(shaFinding(SITE, "a".repeat(40), { sha: HEAD.sha, committed_at: new Date(NOW.getTime() - (DEPLOY_GRACE_MINUTES - 1) * 60_000).toISOString() }, NOW), null);
});

test("PLANT: a deployed sha that is not the head, past the grace, is a finding naming both; so is a site with no sha to compare", () => {
  const f = shaFinding(SITE, "a".repeat(40), HEAD, NOW);
  assert.equal(f?.fingerprint, `live-sha-drift-sample-${HEAD.sha.slice(0, 7)}`);
  assert.ok(f?.evidence.some((e) => e.includes("a".repeat(40))) && f.evidence.some((e) => e.includes(HEAD.sha)));
  assert.equal(shaFinding(SITE, "a".repeat(40), { sha: HEAD.sha, committed_at: new Date(NOW.getTime() - (DEPLOY_GRACE_MINUTES + 1) * 60_000).toISOString() }, NOW)?.fingerprint.startsWith("live-sha-drift"), true);
  assert.equal(shaFinding(SITE, null, HEAD, NOW)?.fingerprint, "live-sha-unreported-sample");
  assert.equal(shaFinding(SITE, "a".repeat(40), { sha: HEAD.sha, committed_at: null }, NOW), null, "a head with no commit time cannot be judged against a grace");
  assert.equal(shaFinding(SITE, "abc", HEAD, NOW)?.fingerprint.startsWith("live-sha-drift"), true, "a 3 character sha is not a prefix match");
});

// reading a page

const html = (body: string, init: ResponseInit = {}, url?: string): Response => {
  const res = new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });
  if (url) Object.defineProperty(res, "url", { value: url });
  return res;
};
const fetchOf = (res: () => Response | Promise<Response>): FetchLike => async () => res();

test("readPage returns the HTML and the headers of a 200 page", async () => {
  const got = await readPage(fetchOf(() => html(page(BEACON), { headers: { "content-type": "text/html", "content-security-policy": "default-src 'self'" } })), SITE.origin, "/");
  assert.equal(got.problem, null);
  assert.equal(got.headers?.get("content-security-policy"), "default-src 'self'");
  assert.equal(beaconCount(got.html ?? ""), 1);
});

test("readPage reaches only the site's own origin plus the path, with a timeout", async () => {
  const seen: Array<{ url: string; signal: boolean }> = [];
  await readPage(async (url, init) => { seen.push({ url, signal: init?.signal instanceof AbortSignal }); return html(page("")); }, "https://sample.example.com", "/a/b");
  assert.deepEqual(seen, [{ url: "https://sample.example.com/a/b", signal: true }]);
});

test("PLANT: a page that cannot be judged says why: an error, a 404, a login redirect, not HTML, too large", async () => {
  const cases: Array<[string, FetchLike, RegExp, boolean]> = [
    ["throws", async () => { throw new Error("connection refused"); }, /no answer: connection refused/, false],
    ["404", fetchOf(() => html("nope", { status: 404 })), /answered 404/, false],
    ["403", fetchOf(() => html("denied", { status: 403 })), /answered 403/, true],
    ["redirect off site", fetchOf(() => html(page(""), {}, "https://team.cloudflareaccess.com/login")), /redirected off the site to https:\/\/team\.cloudflareaccess\.com/, true],
    ["json", fetchOf(() => html("{}", { headers: { "content-type": "application/json" } })), /not HTML/, false],
    ["huge", fetchOf(() => html("x".repeat(MAX_PAGE_BYTES + 1))), /larger than/, false],
  ];
  for (const [name, impl, why, gated] of cases) {
    const got = await readPage(impl, SITE.origin, "/");
    assert.match(got.problem ?? "", why, name);
    assert.equal(got.html, null, name);
    assert.equal(got.gated, gated, `${name} gated`);
  }
});

// a whole pass

const ANALYTICS_ON: WebAnalyticsSite[] = [{ host: "sample.example.com", auto_install: true, enabled: true }];
const deps = (pages: Record<string, () => Response>, head = HEAD, analytics: WebAnalyticsSite[] = ANALYTICS_ON) => ({
  fetchImpl: (async (url: string) => (pages[new URL(url).pathname] ?? (() => html("missing", { status: 404 })))()) as FetchLike,
  head: async () => head,
  analytics: async () => analytics,
});
const CONFIG = [
  "- site sample beacon /",
  "- site sample beacon /pricing",
  "- site sample nobeacon /account",
  "- site sample sha",
  "- site sample analytics",
].join("\n");

test("no document: nothing is read and the check does not run", async () => {
  const out = await liveChecks(null, [SITE], [probe()], deps({}), NOW);
  assert.deepEqual(out, { findings: [], ran: false, summary: { pages_expected: 0, pages_read: 0, shas_expected: 0, shas_read: 0, analytics_expected: 0, analytics_read: 0 } });
});

test("an invalid document is one finding, and the check does not run", async () => {
  const out = await liveChecks({ body: "- site sample beacon" }, [SITE], [probe()], deps({}), NOW);
  assert.deepEqual(prints(out.findings), ["live-config-invalid"]);
  assert.equal(out.ran, false);
});

test("a clean pass reads every page and sha, files nothing, and counts what it read", async () => {
  const out = await liveChecks(
    { body: CONFIG },
    [SITE],
    [probe({ sha: HEAD.sha })],
    deps({ "/": () => html(page(BEACON)), "/pricing": () => html(page(BEACON)), "/account": () => html(page("")) }),
    NOW
  );
  assert.deepEqual(out.findings, []);
  assert.equal(out.ran, true);
  assert.deepEqual(out.summary, { pages_expected: 3, pages_read: 3, shas_expected: 1, shas_read: 1, analytics_expected: 1, analytics_read: 1 });
});

test("a pass over a dirty site files each finding and still counts every page read", async () => {
  const out = await liveChecks(
    { body: CONFIG },
    [SITE],
    [probe()],
    deps({ "/": () => html(page("")), "/pricing": () => html(page(BEACON)), "/account": () => html(page(BEACON)) }, HEAD, [{ host: "sample.example.com", auto_install: false, enabled: true }]),
    NOW
  );
  assert.deepEqual(prints(out.findings).sort(), [
    "live-analytics-off-sample",
    "live-beacon-present-sample-account",
    `live-sha-drift-sample-${HEAD.sha.slice(0, 7)}`,
  ]);
  assert.equal(out.ran, true);
  assert.equal(out.summary.pages_read, 3);
});

test("an unread public page is its own finding and leaves the check un-run, so nothing is cleared on no evidence", async () => {
  const out = await liveChecks({ body: "- site sample beacon /" }, [SITE], [probe()], deps({ "/": () => html("oops", { status: 502 }) }), NOW);
  assert.deepEqual(prints(out.findings), ["live-page-unread-sample-root"]);
  assert.equal(out.ran, false);
  assert.deepEqual(out.summary, { pages_expected: 1, pages_read: 0, shas_expected: 0, shas_read: 0, analytics_expected: 0, analytics_read: 0 });
});

test("a page that must carry no beacon and answers with a login redirect or 403 passes as read", async () => {
  const body = "- site sample nobeacon /account\n- site sample nobeacon /admin";
  const out = await liveChecks(
    { body },
    [SITE],
    [probe()],
    deps({ "/account": () => html(page(""), {}, "https://team.cloudflareaccess.com/login"), "/admin": () => html("no", { status: 403 }) }),
    NOW
  );
  assert.deepEqual(out.findings, []);
  assert.equal(out.ran, true);
  assert.equal(out.summary.pages_read, 2);
});

test("a site that is down is the site-down check's finding: its pages are not read and the check does not run", async () => {
  const calls: string[] = [];
  const out = await liveChecks(
    { body: CONFIG },
    [SITE],
    [probe({ state: "down", sha: null })],
    { fetchImpl: (async (url: string) => { calls.push(url); return html(page("")); }) as FetchLike, head: async () => { calls.push("head"); return HEAD; }, analytics: async () => { calls.push("analytics"); return ANALYTICS_ON; } },
    NOW
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(out.findings, []);
  assert.equal(out.ran, false);
});

test("a rule for a site that is not configured is a finding, since it can never run", async () => {
  const out = await liveChecks({ body: "- site elsewhere beacon /" }, [SITE], [probe()], deps({}), NOW);
  assert.deepEqual(prints(out.findings), ["live-config-unknown-site-elsewhere"]);
});

test("PLANT: two rules for one unknown site, or one page named twice, file one finding, not two", async () => {
  const unknown = await liveChecks({ body: "- site elsewhere beacon /\n- site elsewhere nobeacon /account" }, [SITE], [probe()], deps({}), NOW);
  assert.deepEqual(prints(unknown.findings), ["live-config-unknown-site-elsewhere"]);
  const twice = await liveChecks({ body: "- site sample beacon /\n- site sample beacon /" }, [SITE], [probe()], deps({ "/": () => html(page(BEACON), { headers: { "content-type": "text/html", "content-security-policy": "script-src 'self'; connect-src 'self'" } }) }), NOW);
  assert.deepEqual(prints(twice.findings), ["live-csp-script-sample-root"]);
  assert.equal(twice.summary.pages_read, 2, "both rules were read; only their finding is one");
});

// through the watcher

test("the live checks are a watcher check, and every live-* fingerprint belongs to it", () => {
  assert.ok((WATCHER_CHECKS as readonly string[]).includes("live checks"));
  for (const fingerprint of ["live-analytics-off-a", "live-headers-a-root", "live-csp-script-a-root", "live-sha-drift-a-1234567", "live-config-invalid", "live-page-unread-a-root"]) {
    assert.equal(owningCheck(fingerprint), "live checks", fingerprint);
  }
});

// A D1 that answers the site configuration and the live-checks document, and throws on
// every other read, as a real outage would: those checks fail into attempt() and the
// live checks are all that runs here.
function liveDb(doc: string | null) {
  const rows = [
    { namespace: "sample", name: "Sample", origin: "https://sample.example.com", health_path: null, platform: "cloudflare", script: null, self_probe: 0, revision: 1, updated_at: "2026-10-04 00:00:00" },
  ];
  return {
    prepare: (sql: string) => {
      if (/FROM ops_sites/i.test(sql)) return { bind: () => ({ all: async () => ({ results: rows }) }), all: async () => ({ results: rows }) };
      if (/FROM documents WHERE namespace = \?1 AND path = \?2/i.test(sql)) {
        return { bind: () => ({ first: async () => (doc === null ? null : { body: doc }) }) };
      }
      throw new Error("fake D1 is down");
    },
  };
}

async function gather(doc: string | null, pages: Record<string, () => Response>) {
  const requested: string[] = [];
  const impl = async (url: string) => {
    requested.push(url);
    const path = new URL(url).pathname;
    return (pages[path] ?? (() => html(page("")))) ();
  };
  const log: string[] = [];
  const original = { log: console.log, error: console.error };
  console.log = (...a: unknown[]) => void log.push(a.join(" "));
  console.error = () => undefined;
  try {
    let result: Awaited<ReturnType<typeof gatherFindings>> | null = null;
    await withFetch({}, async () => {
      result = await gatherFindings(fakeEnv({ DB: liveDb(doc), APP_KV: fakeKv({}).kv }), NOW, impl as typeof fetch);
    });
    return { gathered: result as unknown as Awaited<ReturnType<typeof gatherFindings>>, requested, log };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

test("through gatherFindings: a document in the store makes the check run and its findings reach the queue, with the count logged", async () => {
  const { gathered, requested, log } = await gather("- site sample beacon /\n- site sample nobeacon /account", {
    "/": () => html(page(BEACON), { headers: { "content-type": "text/html", "content-security-policy": "script-src 'self'; connect-src 'self'" } }),
    "/account": () => html(page(BEACON)),
  });
  const fps = gathered.findings.map((f) => f.fingerprint);
  assert.ok(fps.includes("live-csp-script-sample-root"), fps.join(", "));
  assert.ok(fps.includes("live-beacon-present-sample-account"), fps.join(", "));
  assert.ok(gathered.ran.has("live checks"));
  assert.ok(requested.includes("https://sample.example.com/account"));
  assert.ok(log.some((l) => JSON.parse(l).message === "WATCHER_LIVE pages 2/2 shas 0/0 analytics 0/0 findings 2"), log.join(" | "));
  const finding = gathered.findings.find((f) => f.fingerprint === "live-csp-script-sample-root");
  assert.match(finding?.title ?? "", /^Watcher: .*\[live-csp-script-sample-root\]$/);
});

test("PLANT: with no live-checks document the pass fetches no page and the check does not run", async () => {
  const { gathered, requested } = await gather(null, {});
  assert.equal(gathered.ran.has("live checks"), false);
  assert.ok(!gathered.findings.some((f) => f.fingerprint.startsWith("live-")));
  // The only request to the site is the probe's own, to the root, not a page the document
  // names. (The pass also reads RDAP for the site's domain, src/domain-expiry.ts, which is
  // not the site.)
  const toSite = requested.filter((u) => new URL(u).hostname === "sample.example.com");
  assert.ok(toSite.length > 0, "the probe's request was not seen, so this proves nothing");
  assert.ok(toSite.every((u) => u === "https://sample.example.com/"), toSite.join(", "));
});
