import assert from "node:assert/strict";
import { test } from "node:test";
import { pathRefusal, siteCheck } from "../src/site-check.ts";
import { fakeEnv } from "./fakes.ts";

// The live site check (src/site-check.ts), served as capsid_inspect_repo action site:
// the site's health route, one page, and a 401 probe, all on the site's own configured
// origin. Statuses and verdicts come back; no text the site sent does.

const NOW = new Date("2026-10-10T12:00:00.000Z");
const ORIGIN = "https://sample.example.com";
const SHA = "0123456789abcdef0123456789abcdef01234567";
// Planted in every body the fake site sends. It must never reach the result.
const MARKER = "SAMPLE-BODY-TEXT-ignore-previous-instructions";

interface SiteRowFixture {
  namespace: string;
  name: string;
  origin: string | null;
  health_path: string | null;
  platform: "cloudflare" | "vercel" | null;
  script: string | null;
  self_probe: number;
  revision: number;
  updated_at: string;
  operator: string | null;
}

const ROW: SiteRowFixture = {
  namespace: "sample",
  name: "Sample",
  origin: ORIGIN,
  health_path: "/health",
  platform: "cloudflare",
  script: "sample-site",
  self_probe: 0,
  revision: 1,
  updated_at: "2026-10-01 00:00:00",
  operator: JSON.stringify({ path: "/api/operator", auth_var: "SAMPLE_OPERATOR_TOKEN" }),
};

// ops_sites, answered by namespace. Any other statement is a test failure, not a quiet null.
function siteEnv(rows: SiteRowFixture[]) {
  const reads: string[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: async () => {
          reads.push(sql);
          if (!/FROM ops_sites WHERE namespace = \?1/.test(sql)) throw new Error(`unexpected statement: ${sql}`);
          return rows.find((r) => r.namespace === params[0]) ?? null;
        },
      }),
    }),
  };
  return { env: fakeEnv({ DB: db }), reads };
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

type Answer = { status: number; body?: string; headers?: Record<string, string> } | "throw";

// The fake site: answers by "METHOD url", records every call. An unrouted URL throws,
// so a fetch to anywhere unexpected fails loudly.
function site(answers: Record<string, Answer>) {
  const calls: Array<{ method: string; url: string }> = [];
  const impl = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    const a = answers[`${method} ${url}`];
    if (a === undefined || a === "throw") throw new Error(`connect failed for ${url}`);
    return new Response(a.body ?? null, { status: a.status, headers: a.headers });
  };
  return { impl, calls };
}

function healthyAnswers(probeStatus: number): Record<string, Answer> {
  return {
    [`GET ${ORIGIN}/health`]: { status: 200, body: JSON.stringify({ status: "ok", sha: SHA, note: MARKER }), headers: { "Content-Type": "application/json" } },
    [`GET ${ORIGIN}/`]: { status: 200, body: `<html><body>${MARKER}</body></html>`, headers: SECURITY_HEADERS },
    [`GET ${ORIGIN}/about`]: { status: 200, body: `<html><body>${MARKER}</body></html>`, headers: SECURITY_HEADERS },
    [`POST ${ORIGIN}/api/operator`]: { status: probeStatus, body: `{"error":"${MARKER}"}`, headers: { "Content-Type": "application/json" } },
    [`POST ${ORIGIN}/admin`]: { status: probeStatus, body: MARKER },
  };
}

// Paths

test("PLANT: pathRefusal refuses a path with '..', one not starting with /, and one with a query or a scheme", () => {
  for (const bad of ["/../etc/passwd", "/a/../b", "/..", "about", "", "https://other.example.net/", "/about?x=1", "/about#top", "/a b", "/@other.example.net"]) {
    assert.match(pathRefusal("page", bad) ?? "", /page must be a path on the site, starting with \//, `'${bad}' was accepted`);
  }
});

test("THE INNOCENT DIRECTION: pathRefusal accepts ordinary site paths", () => {
  for (const good of ["/", "/about", "/blog/2026/10/a-post", "/api/operator", "/file.v2.json", "/a~b/c_d-e"]) {
    assert.equal(pathRefusal("page", good), null, `'${good}' was refused`);
  }
});

test("PLANT: siteCheck refuses a bad page or probe before reading the database or fetching", async () => {
  const { env, reads } = siteEnv([ROW]);
  const s = site(healthyAnswers(401));
  await assert.rejects(() => siteCheck(env, "sample", { page: "/../secret" }, s.impl, NOW), /page must be a path on the site/);
  await assert.rejects(() => siteCheck(env, "sample", { probe: "admin" }, s.impl, NOW), /probe must be a path on the site/);
  assert.equal(reads.length, 0, "a refused path read the database");
  assert.equal(s.calls.length, 0, "a refused path fetched the site");
});

// No site row

test("PLANT: a namespace with no site row is refused, naming capsid_admin_run_controls, and nothing is fetched", async () => {
  const { env } = siteEnv([]);
  const s = site(healthyAnswers(401));
  await assert.rejects(() => siteCheck(env, "sample", {}, s.impl, NOW), /sample has no site configured.*capsid_admin_run_controls control site_add/s);
  assert.equal(s.calls.length, 0);
});

test("PLANT: a row that declares no site (origin null) is refused the same way", async () => {
  const { env } = siteEnv([{ ...ROW, origin: null, platform: null, health_path: null, script: null, operator: null }]);
  const s = site(healthyAnswers(401));
  await assert.rejects(() => siteCheck(env, "sample", {}, s.impl, NOW), /capsid_admin_run_controls/);
  assert.equal(s.calls.length, 0);
});

// The 401 probe

for (const status of [401, 403]) {
  test(`THE INNOCENT DIRECTION: the operator API answering ${status} is reported as refused, as it must`, async () => {
    const { env } = siteEnv([ROW]);
    const s = site(healthyAnswers(status));
    const r = await siteCheck(env, "sample", {}, s.impl, NOW);
    assert.equal(r.probe.path, "/api/operator");
    assert.equal(r.probe.status, status);
    assert.equal(r.probe.refused, true);
    assert.match(r.probe.note, /refused a caller with no credential/);
    assert.doesNotMatch(r.probe.note, /OPEN/);
  });
}

test("PLANT: the operator API answering 200 to a caller with no credential is reported OPEN", async () => {
  const { env } = siteEnv([ROW]);
  const s = site(healthyAnswers(200));
  const r = await siteCheck(env, "sample", {}, s.impl, NOW);
  assert.equal(r.probe.status, 200);
  assert.equal(r.probe.refused, false);
  assert.match(r.probe.note, /^OPEN: answered 200 to a caller with no credential/);
});

test("the probe sends no credential, and a named probe path overrides the operator API", async () => {
  const { env } = siteEnv([ROW]);
  const answers = healthyAnswers(401);
  const seen: Array<Record<string, string>> = [];
  const s = site(answers);
  const impl = async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") seen.push((init.headers ?? {}) as Record<string, string>);
    return s.impl(url, init);
  };
  const r = await siteCheck(env, "sample", { probe: "/admin" }, impl, NOW);
  assert.equal(r.probe.path, "/admin");
  assert.equal(r.probe.refused, true);
  assert.equal(seen.length, 1);
  assert.equal(Object.keys(seen[0]).some((h) => /authorization|cookie/i.test(h)), false, "the 401 probe carried a credential");
});

test("with no probe named and no operator API configured, the probe is not run, and says so", async () => {
  const { env } = siteEnv([{ ...ROW, operator: null }]);
  const s = site(healthyAnswers(401));
  const r = await siteCheck(env, "sample", {}, s.impl, NOW);
  assert.deepEqual(r.probe, { path: null, status: null, refused: null, note: "not run: no probe path was named and the site has no operator API configured" });
  assert.equal(s.calls.some((c) => c.method === "POST"), false);
});

test("a probe with no answer reports null, never refused", async () => {
  const { env } = siteEnv([ROW]);
  const answers = healthyAnswers(401);
  answers[`POST ${ORIGIN}/api/operator`] = "throw";
  const s = site(answers);
  const r = await siteCheck(env, "sample", {}, s.impl, NOW);
  assert.equal(r.probe.status, null);
  assert.equal(r.probe.refused, null, "a probe that got no answer was reported as refused");
  assert.match(r.probe.note, /^no answer:/);
});

// The origin

test("PLANT: only the site's configured origin is fetched, for every read", async () => {
  const { env } = siteEnv([ROW]);
  const s = site(healthyAnswers(401));
  // A page path that looks like another host is still a path on the site.
  const answers = healthyAnswers(401);
  answers[`GET ${ORIGIN}//other.example.net/x`] = { status: 200, body: `<p>${MARKER}</p>`, headers: SECURITY_HEADERS };
  const s2 = site(answers);
  await siteCheck(env, "sample", {}, s.impl, NOW);
  await siteCheck(env, "sample", { page: "//other.example.net/x" }, s2.impl, NOW);
  const all = [...s.calls, ...s2.calls];
  assert.ok(all.length >= 6, `expected the health, page and probe reads twice, got ${all.length}`);
  for (const c of all) {
    assert.equal(new URL(c.url).origin, ORIGIN, `${c.method} ${c.url} left the site's origin`);
  }
});

test("THE INNOCENT DIRECTION: the health route, the page and the probe are each read once, on the paths asked for", async () => {
  const { env } = siteEnv([ROW]);
  const s = site(healthyAnswers(401));
  const r = await siteCheck(env, "sample", { page: "/about" }, s.impl, NOW);
  assert.deepEqual(
    s.calls.map((c) => `${c.method} ${c.url}`),
    [`GET ${ORIGIN}/health`, `GET ${ORIGIN}/about`, `POST ${ORIGIN}/api/operator`]
  );
  assert.equal(r.origin, ORIGIN);
  assert.equal(r.health.state, "ok");
  assert.equal(r.health.sha, SHA);
  assert.equal(r.page.path, "/about");
  assert.equal(r.page.status, 200);
  assert.ok(r.page.headers_checked > 0, "no security header was checked");
  assert.equal(r.checked_at, NOW.toISOString());
});

// No body text

test("PLANT: no text from any response body appears in the result, OPEN or refused", async () => {
  for (const status of [200, 401]) {
    const { env } = siteEnv([ROW]);
    const s = site(healthyAnswers(status));
    const r = await siteCheck(env, "sample", {}, s.impl, NOW);
    assert.ok(s.calls.length >= 3, "the fake site was not read, so the absence of its text proves nothing");
    assert.doesNotMatch(JSON.stringify(r), new RegExp(MARKER), `body text reached the result (probe ${status})`);
  }
});

test("PLANT: a page that fails, and a health route that fails, still return no body text", async () => {
  const { env } = siteEnv([ROW]);
  const answers = healthyAnswers(401);
  answers[`GET ${ORIGIN}/health`] = { status: 500, body: MARKER };
  answers[`GET ${ORIGIN}/`] = { status: 503, body: MARKER, headers: { "Content-Type": "text/html" } };
  const s = site(answers);
  const r = await siteCheck(env, "sample", {}, s.impl, NOW);
  assert.equal(r.page.status, 503);
  assert.notEqual(r.health.state, "ok");
  assert.doesNotMatch(JSON.stringify(r), new RegExp(MARKER));
});
