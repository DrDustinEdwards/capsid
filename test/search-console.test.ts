import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeJwt } from "jose";
import { dateWindow, pickProperty, resetSearchConsoleToken, searchConsole } from "../src/search-console.ts";
import { fakeEnv } from "./fakes.ts";

// Search Console for a namespace's site (src/search-console.ts), served as
// capsid_inspect_repo action search. The namespace picks the property; the caller never
// names one, and an inspected URL must be on the namespace's own host.

const NOW = new Date("2026-10-18T12:00:00.000Z");
const ORIGIN = "https://www.sample.example.com";

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

function siteDb(rows: Array<typeof ROW>) {
  return {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (!/FROM ops_sites WHERE namespace = \?1/.test(sql)) throw new Error(`unexpected statement: ${sql}`);
          return rows.find((r) => r.namespace === params[0]) ?? null;
        },
      }),
    }),
  };
}

async function serviceAccountKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({ type: "service_account", client_email: "reader@sample-project.iam.gserviceaccount.com", private_key: pem });
}

function google(sites: Array<{ siteUrl: string; permissionLevel: string }>) {
  const calls: Array<{ method: string; url: string; body: string | null; auth: string | null }> = [];
  const impl = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ method, url, body, auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null });
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "ya29.fake", expires_in: 3600 });
    if (url === "https://www.googleapis.com/webmasters/v3/sites") return Response.json({ siteEntry: sites });
    if (url.endsWith("/searchAnalytics/query")) {
      return Response.json({ rows: [{ keys: ["phage lysis", "https://www.sample.example.com/a"], clicks: 3, impressions: 120, ctr: 0.025, position: 7.4321 }] });
    }
    throw new Error(`unrouted ${method} ${url}`);
  };
  return { impl, calls };
}

test("pickProperty prefers the longest Domain property covering the host, then the exact URL-prefix property, and skips unverified ones", () => {
  const entries = [
    { siteUrl: "https://www.sample.example.com/", permissionLevel: "siteRestrictedUser" },
    { siteUrl: "sc-domain:example.com", permissionLevel: "siteRestrictedUser" },
    { siteUrl: "sc-domain:sample.example.com", permissionLevel: "siteRestrictedUser" },
    { siteUrl: "sc-domain:www.sample.example.com", permissionLevel: "siteUnverifiedUser" },
  ];
  assert.equal(pickProperty(ORIGIN, entries), "sc-domain:sample.example.com");
  assert.equal(pickProperty(ORIGIN, entries.filter((e) => !e.siteUrl.startsWith("sc-domain:"))), "https://www.sample.example.com/");
  // A suffix that is not a parent domain does not match.
  assert.equal(pickProperty("https://notexample.com", [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }]), null);
  assert.equal(pickProperty("https://other.example.net", entries), null);
});

test("dateWindow defaults to the 28 days ending 3 days ago and refuses a bad or reversed window", () => {
  assert.deepEqual(dateWindow({}, NOW), { start: "2026-09-18", end: "2026-10-15" });
  assert.deepEqual(dateWindow({ end_date: "2026-10-01" }, NOW), { start: "2026-09-04", end: "2026-10-01" });
  assert.throws(() => dateWindow({ start_date: "2026-13-01" }, NOW), /start_date must be a date/);
  assert.throws(() => dateWindow({ start_date: "2026-10-10", end_date: "2026-10-01" }, NOW), /is after end_date/);
  assert.throws(() => dateWindow({ start_date: "2024-01-01", end_date: "2026-10-01" }, NOW), /16 months/);
});

test("performance signs in with a read-only assertion, picks the namespace's property, and returns the rows", async () => {
  resetSearchConsoleToken();
  const g = google([
    { siteUrl: "sc-domain:other.example.net", permissionLevel: "siteOwner" },
    { siteUrl: "sc-domain:sample.example.com", permissionLevel: "siteRestrictedUser" },
  ]);
  const env = fakeEnv({ DB: siteDb([ROW]), GSC_SERVICE_ACCOUNT_KEY: await serviceAccountKey() });
  const r = await searchConsole(env, "sample", { dimensions: ["query", "page"], row_limit: 10 }, g.impl, NOW);

  const claims = decodeJwt(new URLSearchParams(g.calls[0].body!).get("assertion")!);
  assert.equal(claims.scope, "https://www.googleapis.com/auth/webmasters.readonly");
  assert.equal(claims.iss, "reader@sample-project.iam.gserviceaccount.com");

  const query = g.calls.find((c) => c.url.endsWith("/searchAnalytics/query"))!;
  assert.equal(query.url, "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Asample.example.com/searchAnalytics/query");
  assert.equal(query.auth, "Bearer ya29.fake");
  assert.deepEqual(JSON.parse(query.body!), { startDate: "2026-09-18", endDate: "2026-10-15", type: "web", dimensions: ["query", "page"], rowLimit: 10, dataState: "final" });

  assert.equal(r.property, "sc-domain:sample.example.com");
  assert.ok("rows" in r);
  assert.deepEqual(r.rows, [{ query: "phage lysis", page: "https://www.sample.example.com/a", clicks: 3, impressions: 120, ctr: 0.025, position: 7.4 }]);
  assert.ok(!JSON.stringify(r).includes("ya29.fake"), "the access token reached the result");
});

test("inspect refuses a URL on another host before signing in, and a property the account cannot read names the fix", async () => {
  resetSearchConsoleToken();
  const g = google([{ siteUrl: "sc-domain:other.example.net", permissionLevel: "siteOwner" }]);
  const env = fakeEnv({ DB: siteDb([ROW]), GSC_SERVICE_ACCOUNT_KEY: await serviceAccountKey() });
  await assert.rejects(() => searchConsole(env, "sample", { report: "inspect", url: "https://other.example.net/a" }, g.impl, NOW), /must be a page on sample's site/);
  assert.equal(g.calls.length, 0);
  await assert.rejects(() => searchConsole(env, "sample", { report: "sitemaps" }, g.impl, NOW), /add reader@sample-project\.iam\.gserviceaccount\.com as a Restricted user/);
});

test("with no key set, it says what is missing and fetches nothing", async () => {
  const g = google([]);
  await assert.rejects(() => searchConsole(fakeEnv({ DB: siteDb([ROW]) }), "sample", {}, g.impl, NOW), /GSC_SERVICE_ACCOUNT_KEY .* is not set/);
  assert.equal(g.calls.length, 0);
});
