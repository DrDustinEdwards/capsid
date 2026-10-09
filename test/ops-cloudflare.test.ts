import assert from "node:assert/strict";
import { test } from "node:test";
import { CF_GRAPHQL, DEPLOYS_KEPT, WEB_ANALYTICS_PERMISSION, cloudflareCredentials, errorWindow, readCloudflare, readWebAnalyticsSites } from "../src/ops-cloudflare.ts";
import type { OpsSite } from "../src/ops-sites.ts";
import { buildSnapshot, OPS_SNAPSHOT_KEY, readSnapshot, ringSlot, type OpsSnapshot, type SiteProbe } from "../src/ops-snapshot.ts";
import type { SiteCloudflare } from "../src/ops-types.ts";
import {
  ERROR_RATE_MIN_REQUESTS,
  ERROR_RATE_THRESHOLD,
  gatherFindings,
  owningCheck,
  runPass,
  siteDownFindings,
  siteErrorFindings,
  type Finding,
} from "../src/watcher.ts";
import { fakeEnv, fakeFindingMemory, fakeKv, withFetch } from "./fakes.ts";
import { sourceFiles } from "./source-files.ts";

// The watcher's read of Cloudflare for the Watch Floor (src/ops-cloudflare.ts), and the
// two findings built on the snapshot: a site down on two probes in a row, and a
// Worker's error rate over the approved threshold.

const NOW = new Date("2026-09-28T12:10:00.000Z");
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "sample-token";
const CREDS = { CF_OPS_TOKEN: TOKEN, CF_ACCOUNT_ID: ACCOUNT };
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;

const site = (over: Partial<OpsSite>): OpsSite => ({
  namespace: "sample",
  name: "Sample",
  origin: "https://sample.example.com",
  healthPath: null,
  platform: "cloudflare",
  ...over,
});
const WORKERS_DEV = site({ namespace: "sample-dev", name: "Sample dev", origin: "https://sample-dev.example.workers.dev", script: "sample-dev" });
const CUSTOM = site({});
const ORPHAN = site({ namespace: "orphan", name: "Orphan", origin: "https://orphan.example.com" });
const VERCEL = site({ namespace: "sample-vercel", name: "Sample Vercel", origin: "https://vercel.example.com", platform: "vercel" });

// Cloudflare, as the three endpoints answer. Every call is recorded with its method,
// url, body and whether it carried the bearer token and a timeout signal.
type Answer = { status?: number; body: unknown } | "throw";
interface Call {
  method: string;
  url: string;
  body: { query?: string; variables?: Record<string, string> } | null;
  bearer: boolean;
  signal: boolean;
}
function cloudflare(answers: Record<string, Answer>) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      bearer: headers.Authorization === `Bearer ${TOKEN}`,
      signal: init?.signal instanceof AbortSignal,
    });
    const a = answers[`${method} ${url}`];
    if (a === undefined || a === "throw") throw new Error(`connect failed for ${url}`);
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  };
  return { impl, calls };
}
const ok = (result: unknown) => ({ body: { success: true, errors: [], messages: [], result } });
const domains = (list: Array<[string, string]>) => ok(list.map(([hostname, service], i) => ({ id: `d${i}`, hostname, service, zone_id: "z", zone_name: "example.com" })));
const deploy = (id: string, created_on: string, versions: Array<[string, number]>, extra: Record<string, unknown> = {}) => ({
  id,
  created_on,
  source: "wrangler",
  strategy: "percentage",
  versions: versions.map(([version_id, percentage]) => ({ version_id, percentage })),
  ...extra,
});
const deployments = (list: unknown[]) => ok({ deployments: list });
const LAST_HOUR = "2026-09-28T11:00:00Z";
const graph = (rows: Array<[string, string, number, number]>) => ({
  body: {
    data: {
      viewer: {
        accounts: [{ workersInvocationsAdaptive: rows.map(([scriptName, datetimeHour, requests, errors]) => ({ sum: { requests, errors }, dimensions: { scriptName, datetimeHour } })) }],
      },
    },
    errors: null,
  },
});

async function quietly<T>(fn: () => Promise<T>): Promise<{ value: T; logged: string[] }> {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  try {
    return { value: await fn(), logged };
  } finally {
    console.error = original;
  }
}

// No token

test("with no token or no account, every Cloudflare site says exactly what is unset and nothing is fetched", async () => {
  const cases: Array<[Record<string, string>, RegExp, RegExp | null]> = [
    [{}, /CF_OPS_TOKEN is not set/, /neither CF_ACCOUNT_ID nor R2_ACCOUNT_ID is set/],
    [{ CF_ACCOUNT_ID: ACCOUNT }, /^CF_OPS_TOKEN is not set$/, null],
    [{ CF_OPS_TOKEN: TOKEN }, /^neither CF_ACCOUNT_ID nor R2_ACCOUNT_ID is set$/, null],
  ];
  for (const [env, first, second] of cases) {
    const cf = cloudflare({});
    const read = await readCloudflare(env, [WORKERS_DEV, CUSTOM, VERCEL], cf.impl, NOW);
    assert.equal(read.ran, false);
    assert.equal(cf.calls.length, 0, "a read with no token still called Cloudflare");
    for (const ns of ["sample-dev", "sample"]) {
      const state = read.bySite[ns];
      assert.equal(state.state, "no-token");
      assert.match(state.state === "no-token" ? state.reason : "", first);
      if (second) assert.match(state.state === "no-token" ? state.reason : "", second);
    }
    assert.equal(read.bySite["sample-vercel"].state, "not-cloudflare");
  }
});

test("the account falls back to R2_ACCOUNT_ID, the same Cloudflare account", () => {
  const creds = cloudflareCredentials({ CF_OPS_TOKEN: TOKEN, R2_ACCOUNT_ID: ACCOUNT });
  assert.deepEqual(creds, { ok: true, token: TOKEN, account: ACCOUNT });
  assert.deepEqual(cloudflareCredentials({ CF_OPS_TOKEN: TOKEN, CF_ACCOUNT_ID: "cf", R2_ACCOUNT_ID: "r2" }), { ok: true, token: TOKEN, account: "cf" });
});

test("a Vercel site is not Cloudflare's, with a reason, even with a token", async () => {
  const cf = cloudflare({});
  const read = await readCloudflare(CREDS, [VERCEL], cf.impl, NOW);
  assert.deepEqual(read.bySite["sample-vercel"], { state: "not-cloudflare", reason: "Sample Vercel is served by vercel, not Cloudflare" });
  assert.equal(cf.calls.length, 0);
});

// Script resolution

// The seed's scripts (a script named only where the host proves it) are checked
// against the migrated table in test-integration/ops-sites.test.ts.

test("a custom-domain site resolves to the Worker its custom domain names; one with none is unresolved, never guessed", async () => {
  const cf = cloudflare({
    [`GET ${API}/workers/domains`]: domains([["sample.example.com", "sample-web"], ["other.example.com", "other"]]),
    [`GET ${API}/workers/scripts/sample-web/deployments`]: deployments([]),
    [`POST ${CF_GRAPHQL}`]: graph([]),
  });
  const read = await readCloudflare(CREDS, [CUSTOM, ORPHAN], cf.impl, NOW);
  assert.equal(read.bySite.sample.state, "ok");
  assert.equal(read.bySite.sample.state === "ok" ? read.bySite.sample.script : "", "sample-web");
  assert.deepEqual(read.bySite.orphan, { state: "unresolved", reason: "no Workers custom domain on the account names orphan.example.com, so its script is not known" });
  assert.ok(!cf.calls.some((c) => c.url.includes("/scripts/orphan")), "an unresolved site's script was guessed and fetched");
  assert.equal(read.ran, true, "an unresolved site is a finding about the map, not a failed read");
});

test("a workers.dev site needs no domains read", async () => {
  const cf = cloudflare({
    [`GET ${API}/workers/scripts/sample-dev/deployments`]: deployments([]),
    [`POST ${CF_GRAPHQL}`]: graph([]),
  });
  const read = await readCloudflare(CREDS, [WORKERS_DEV], cf.impl, NOW);
  assert.equal(read.bySite["sample-dev"].state, "ok");
  assert.ok(!cf.calls.some((c) => c.url.endsWith("/workers/domains")));
});

test("a domains list that cannot be read makes each custom-domain site an error, and the check does not run", async () => {
  const cf = cloudflare({
    [`GET ${API}/workers/domains`]: { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } },
    [`GET ${API}/workers/scripts/sample-dev/deployments`]: deployments([]),
    [`POST ${CF_GRAPHQL}`]: graph([]),
  });
  const { value: read, logged } = await quietly(() => readCloudflare(CREDS, [WORKERS_DEV, CUSTOM], cf.impl, NOW));
  assert.equal(read.ran, false);
  assert.equal(read.bySite.sample.state, "error");
  assert.match(read.bySite.sample.state === "error" ? read.bySite.sample.reason : "", /answered 403: Authentication error/);
  assert.equal(read.bySite["sample-dev"].state, "ok", "a site that needed no domains read is still read");
  assert.ok(logged.some((l) => l.includes("WATCHER_READ_FAILED cloudflare custom domains")));
});

// Deployments

test("deployments are newest first, at most ten, with the version serving the largest share", async () => {
  const many = Array.from({ length: 12 }, (_, i) => deploy(`d${i}`, `2026-09-${String(10 + i).padStart(2, "0")}T00:00:00Z`, [["v" + i, 100]]));
  const newest = deploy("dnew", "2026-09-28T09:00:00Z", [["v-old", 30], ["v-new", 70]], {
    annotations: { "workers/message": "sample release", "workers/triggered_by": "upload" },
    author_email: "dev@example.com",
  });
  const cf = cloudflare({
    [`GET ${API}/workers/scripts/sample-dev/deployments`]: deployments([...many, newest]),
    [`POST ${CF_GRAPHQL}`]: graph([]),
  });
  const read = await readCloudflare(CREDS, [WORKERS_DEV], cf.impl, NOW);
  const state = read.bySite["sample-dev"];
  assert.ok(state.state === "ok");
  assert.equal(state.deploys.length, DEPLOYS_KEPT);
  assert.deepEqual(state.deploys[0], {
    id: "dnew",
    created_on: "2026-09-28T09:00:00Z",
    version_id: "v-new",
    message: "sample release",
    triggered_by: "upload",
    author_email: "dev@example.com",
  });
  assert.equal(state.deploys[1].id, "d11");
  assert.equal(state.deploys[1].message, null);
  for (const c of cf.calls) {
    assert.ok(c.bearer, `${c.url} did not carry the token`);
    assert.ok(c.signal, `${c.url} has no timeout`);
  }
});

test("a deployments read that fails makes that site an error with the reason, and the check does not run", async () => {
  const cf = cloudflare({ [`POST ${CF_GRAPHQL}`]: graph([]) });
  const { value: read } = await quietly(() => readCloudflare(CREDS, [WORKERS_DEV], cf.impl, NOW));
  assert.equal(read.ran, false);
  assert.equal(read.bySite["sample-dev"].state, "error");
  assert.match(read.bySite["sample-dev"].state === "error" ? read.bySite["sample-dev"].reason : "", /connect failed/);
});

// Errors

test("ONE analytics query covers every script: 24 hourly buckets, oldest first, an hour with no row a real zero", async () => {
  const cf = cloudflare({
    [`GET ${API}/workers/domains`]: domains([["sample.example.com", "sample-web"]]),
    [`GET ${API}/workers/scripts/sample-web/deployments`]: deployments([]),
    [`GET ${API}/workers/scripts/sample-dev/deployments`]: deployments([]),
    [`POST ${CF_GRAPHQL}`]: graph([
      ["sample-web", LAST_HOUR, 200, 3],
      ["sample-dev", "2026-09-27T12:00:00Z", 10, 1],
      ["sample-dev", "2026-09-27T12:00:00Z", 5, 0],
    ]),
  });
  const read = await readCloudflare(CREDS, [WORKERS_DEV, CUSTOM], cf.impl, NOW);
  assert.equal(read.ran, true);
  const graphCalls = cf.calls.filter((c) => c.url === CF_GRAPHQL);
  assert.equal(graphCalls.length, 1, "the analytics query ran more than once per pass");
  assert.match(String(graphCalls[0].body?.query), /workersInvocationsAdaptive/);
  assert.match(String(graphCalls[0].body?.query), /scriptName_in: \["sample-dev","sample-web"\]/);
  assert.deepEqual(graphCalls[0].body?.variables, { accountTag: ACCOUNT, datetimeStart: "2026-09-27T12:00:00.000Z", datetimeEnd: "2026-09-28T12:00:00.000Z" });

  const web = read.bySite.sample;
  const dev = read.bySite["sample-dev"];
  assert.ok(web.state === "ok" && dev.state === "ok");
  assert.equal(web.errors24?.length, 24);
  assert.deepEqual(web.errors24?.at(-1), { hour: "2026-09-28T11:00:00.000Z", requests: 200, errors: 3 });
  assert.deepEqual(web.errors24?.[0], { hour: "2026-09-27T12:00:00.000Z", requests: 0, errors: 0 });
  assert.deepEqual(dev.errors24?.[0], { hour: "2026-09-27T12:00:00.000Z", requests: 15, errors: 1 });
  assert.equal(web.errors_reason, null);
  assert.deepEqual(errorWindow(NOW).hours.slice(-1), ["2026-09-28T11:00:00.000Z"]);
});

test("an analytics query that fails is no data with its reason, never zeros, and the deploys still show", async () => {
  const failures: Array<[string, Answer]> = [
    ["a GraphQL error", { body: { data: null, errors: [{ message: "unknown field datetimeHour" }] } }],
    ["an HTTP error", { status: 500, body: { errors: [{ message: "internal" }] } }],
    ["a missing account", { body: { data: { viewer: { accounts: [] } }, errors: null } }],
    ["a row outside the window", graph([["sample-dev", "2026-09-20T00:00:00Z", 1, 0]])],
  ];
  for (const [what, answer] of failures) {
    const cf = cloudflare({
      [`GET ${API}/workers/scripts/sample-dev/deployments`]: deployments([deploy("d1", "2026-09-28T09:00:00Z", [["v1", 100]])]),
      [`POST ${CF_GRAPHQL}`]: answer,
    });
    const { value: read, logged } = await quietly(() => readCloudflare(CREDS, [WORKERS_DEV], cf.impl, NOW));
    const state = read.bySite["sample-dev"];
    assert.ok(state.state === "ok", what);
    assert.equal(state.errors24, null, `${what} was reported as buckets`);
    assert.ok(state.errors_reason && state.errors_reason.length > 0, `${what} has no reason`);
    assert.equal(state.deploys.length, 1);
    assert.equal(read.ran, false, `${what} still counted the check as run`);
    assert.ok(logged.some((l) => l.includes("WATCHER_READ_FAILED cloudflare analytics")), `${what} was not logged`);
  }
  const cf = cloudflare({
    [`GET ${API}/workers/scripts/sample-dev/deployments`]: deployments([]),
    [`POST ${CF_GRAPHQL}`]: failures[0][1],
  });
  const { value: read } = await quietly(() => readCloudflare(CREDS, [WORKERS_DEV], cf.impl, NOW));
  const state = read.bySite["sample-dev"];
  assert.match(state.state === "ok" ? String(state.errors_reason) : "", /unknown field datetimeHour/);
});

// The findings

const probe = (namespace: string, state: SiteProbe["state"]): SiteProbe => ({
  namespace,
  name: namespace,
  origin: `https://${namespace}.example.com`,
  health_path: null,
  platform: "cloudflare",
  state,
  http_status: state === "down" ? 522 : 200,
  latency_ms: null,
  sha: null,
  error: state === "down" ? "root answered 522" : null,
  checked_at: NOW.toISOString(),
});
const prevWith = (rings: Record<string, string>): OpsSnapshot =>
  ({
    version: 1,
    pass_at: NOW.toISOString(),
    pass_ms: 1,
    cadence_min: 30,
    checks: [],
    health: null,
    mirror: null,
    ci: [],
    site_map: null,
    sites: Object.entries(rings).map(([ns, ring]) => ({ ...probe(ns, ring.endsWith("0") ? "down" : "ok"), ring, ring_slot: ringSlot(NOW) - 1 })),
  } satisfies OpsSnapshot);

test("a site is down only on two failed probes in a row", () => {
  const prev = prevWith({ a: "110", b: "111", c: "10-", d: "100" });
  const found = siteDownFindings(prev, [probe("a", "down"), probe("b", "down"), probe("c", "down"), probe("d", "liveness"), probe("e", "down")]);
  assert.deepEqual(found.map((f) => [f.namespace, f.fingerprint]), [["a", "site-down-a"]]);
  assert.match(found[0].body, /root answered 522/);
  assert.deepEqual(siteDownFindings(null, [probe("a", "down")]), [], "a first pass has no previous probe");
});

const hourly = (requests: number, errors: number, earlier: { requests: number; errors: number } = { requests: 0, errors: 0 }): Extract<SiteCloudflare, { state: "ok" }> => ({
  state: "ok",
  script: "sample-web",
  deploys: [],
  errors24: [
    ...Array.from({ length: 23 }, (_, i) => ({ hour: `h${i}`, ...earlier })),
    { hour: "2026-09-28T11:00:00.000Z", requests, errors },
  ],
  errors_reason: null,
});

test("the error rate fires above 1 percent of at least 100 requests in the last complete hour, and not at the boundary", () => {
  assert.equal(ERROR_RATE_THRESHOLD, 0.01);
  assert.equal(ERROR_RATE_MIN_REQUESTS, 100);
  const sites = [{ namespace: "sample", name: "Sample" }];
  const fires = (cf: SiteCloudflare) => siteErrorFindings(sites, { sample: cf }).map((f) => f.fingerprint);
  assert.deepEqual(fires(hourly(100, 2)), ["site-errors-sample"]);
  assert.deepEqual(fires(hourly(1000, 11)), ["site-errors-sample"]);
  assert.deepEqual(fires(hourly(100, 1)), [], "exactly 1 percent fired");
  assert.deepEqual(fires(hourly(1000, 10)), [], "exactly 1 percent fired");
  assert.deepEqual(fires(hourly(99, 50)), [], "99 requests fired");
  assert.deepEqual(fires(hourly(100, 0, { requests: 1000, errors: 900 })), [], "an earlier hour fired");
  assert.deepEqual(fires({ ...hourly(100, 50), errors24: null, errors_reason: "query failed" }), [], "no data was judged");
  assert.deepEqual(fires({ state: "no-token", reason: "CF_OPS_TOKEN is not set" }), []);
});

test("site-down is owned by the probes and site-errors by the cloudflare check, so each clears only when its check ran", async () => {
  assert.equal(owningCheck("site-down-sample"), "site probes");
  assert.equal(owningCheck("site-errors-sample"), "cloudflare");
  assert.equal(owningCheck("site-map-drift-add-sample"), "site map");
  const open = new Map([["site-errors-sample", "j1"], ["site-down-sample", "j2"]]);
  const cleared: string[] = [];
  const pass = (ran: Set<"site probes" | "cloudflare">) =>
    runPass(
      {
        findings: async () => ({ findings: [] as Finding[], ran }),
        open: async () => open,
        clear: async (id) => {
          cleared.push(id);
          return true;
        },
        post: async () => ({ ok: true as const, jobId: "job_new" }),
        memory: fakeFindingMemory().memory,
      },
      NOW
    );
  await pass(new Set(["site probes"]));
  assert.deepEqual(cleared, ["j2"], "a site-errors job was cleared on a pass where the cloudflare check did not run");
  cleared.length = 0;
  await pass(new Set(["cloudflare"]));
  assert.deepEqual(cleared, ["j1"], "a site-down job was cleared on a pass where the probes did not run");
});

// The snapshot

test("the snapshot carries each site's Cloudflare state, and an old snapshot without it still reads", async () => {
  const cf: Record<string, SiteCloudflare> = {
    a: hourly(10, 0),
    b: { state: "unresolved", reason: "no Workers custom domain on the account names b.example.com, so its script is not known" },
  };
  const base = { now: NOW, pass_ms: 1, cadence_min: 30, checks: [], health: null, mirror: null, ci: [], site_map: null };
  const snap = buildSnapshot(null, { ...base, probes: [probe("a", "ok"), probe("b", "ok"), probe("c", "ok")], cloudflare: cf });
  assert.equal(snap.version, 1);
  assert.deepEqual(snap.sites[0].cloudflare, cf.a);
  assert.deepEqual(snap.sites[1].cloudflare, cf.b);
  assert.equal("cloudflare" in snap.sites[2], false, "a site with no state this pass was given one");

  const old = JSON.parse(JSON.stringify(snap)) as OpsSnapshot;
  for (const s of old.sites) delete s.cloudflare;
  const kv = fakeKv({ seed: { [OPS_SNAPSHOT_KEY]: JSON.stringify(old) } });
  const read = await readSnapshot(fakeEnv({ APP_KV: kv.kv }));
  assert.ok(read, "a snapshot written before the Cloudflare read no longer reads");
  const next = buildSnapshot(read, { ...base, now: new Date(NOW.getTime() + 30 * 60_000), probes: [probe("a", "ok")], cloudflare: cf });
  assert.equal(next.sites[0].ring, "11");
  assert.deepEqual(next.sites[0].cloudflare, cf.a);

  const carried = buildSnapshot(snap, { ...base, now: new Date(NOW.getTime() + 30 * 60_000), probes: null, cloudflare: { a: cf.b } });
  assert.deepEqual(carried.sites.find((s) => s.namespace === "a")?.cloudflare, cf.b, "a site the probes missed does not get this pass's Cloudflare state");
});

// Through gatherFindings

// A D1 that throws on everything: every D1 check fails into attempt(), which is the
// path a real outage takes, so only the probes, the snapshot and Cloudflare run.
const deadDb = { prepare: () => { throw new Error("fake D1 is down"); } };

// The site configuration a pass reads (src/ops-sites.ts), shaped like the migration's
// seed: a self-probed workers.dev site, a second workers.dev site, two custom domains
// resolved from Cloudflare's list, and a Vercel site. Every other read fails, as deadDb.
const CONFIG_ROWS = [
  { namespace: "capsid", name: "Capsid", origin: "https://capsid.sample.workers.dev", health_path: "/health", platform: "cloudflare", script: "capsid", self_probe: 1 },
  { namespace: "bsw", name: "BSW", origin: "https://bsw.sample.workers.dev", health_path: null, platform: "cloudflare", script: "bsw", self_probe: 0 },
  { namespace: "foxing", name: "Foxing", origin: "https://foxing.example.com", health_path: null, platform: "cloudflare", script: null, self_probe: 0 },
  { namespace: "germomics", name: "Germomics", origin: "https://germomics.example.com", health_path: "/health", platform: "cloudflare", script: null, self_probe: 0 },
  { namespace: "julieedwards", name: "julieedwards", origin: "https://julieedwards.example.com", health_path: null, platform: "vercel", script: null, self_probe: 0 },
  { namespace: "claude-skills", name: "claude-skills", origin: null, health_path: null, platform: null, script: null, self_probe: 0 },
].map((r) => ({ ...r, revision: 1, updated_at: "2026-09-29 00:00:00" }));

function configDb(rows: unknown[]) {
  return {
    prepare: (sql: string) => {
      if (!/FROM ops_sites/i.test(sql)) throw new Error("fake D1 is down");
      return { bind: () => ({ all: async () => ({ results: rows }) }), all: async () => ({ results: rows }) };
    },
  };
}

async function gather(env: Record<string, unknown>, answers: Record<string, Answer>, prev: OpsSnapshot | null, db: unknown = configDb(CONFIG_ROWS)) {
  const kv = fakeKv(prev ? { seed: { [OPS_SNAPSHOT_KEY]: JSON.stringify(prev) } } : {});
  const cf = cloudflare(answers);
  let result: Awaited<ReturnType<typeof gatherFindings>> | null = null;
  // GitHub is read through the global fetch; every route answers 500 here.
  await withFetch({}, async () => {
    ({ value: result } = await quietly(() => gatherFindings(fakeEnv({ DB: db, APP_KV: kv.kv, ...env }), NOW, cf.impl as typeof fetch)));
  });
  return { gathered: result as unknown as Awaited<ReturnType<typeof gatherFindings>>, calls: cf.calls };
}

test("with no token the cloudflare check does not run, nothing reaches Cloudflare, and every site says why", async () => {
  const { gathered, calls } = await gather({}, {}, null);
  assert.equal(gathered.ran.has("cloudflare"), false);
  assert.ok(!calls.some((c) => c.url.startsWith("https://api.cloudflare.com")), "a pass with no token called Cloudflare");
  const cf = gathered.observed.cloudflare ?? {};
  const sites = CONFIG_ROWS.filter((r) => r.origin !== null);
  assert.equal(Object.keys(cf).length, sites.length, "the no-site row got a Cloudflare state");
  for (const s of sites) {
    assert.equal(cf[s.namespace]?.state, s.platform === "vercel" ? "not-cloudflare" : "no-token", s.namespace);
  }
});

// scanner-rule: with nothing configured, the watcher reaches no site
test("PLANT: with no site configured, the pass probes nothing and reaches no Cloudflare API", async () => {
  const noSites = CONFIG_ROWS.filter((r) => r.origin === null);
  const { gathered, calls } = await gather(CREDS, {}, prevWith({}), configDb(noSites));
  // Only GitHub is fetched, and through the global fetch the stub does not see.
  assert.deepEqual(calls.map((c) => c.url), [], "a pass with no site configured fetched a site or Cloudflare");
  assert.deepEqual(gathered.observed.probes, []);
  assert.equal(gathered.observed.cloudflare, undefined);
  assert.equal(gathered.ran.has("cloudflare"), false);
  assert.ok(!gathered.findings.some((f) => f.fingerprint.startsWith("site-")), "a pass with no site configured raised a site finding");
});

test("an unreadable site configuration runs no site check, probes nothing, and clears nothing", async () => {
  const { gathered, calls } = await gather(CREDS, {}, prevWith({}), deadDb);
  assert.deepEqual(calls.map((c) => c.url), []);
  for (const check of ["site map", "site probes", "cloudflare"] as const) {
    assert.equal(gathered.ran.has(check), false, `${check} counted as run on an unreadable configuration`);
  }
  assert.equal(gathered.observed.probes, null);
});

test("a site down on two probes in a row, and a Worker over the error rate, reach the findings through gatherFindings", async () => {
  const prev: OpsSnapshot = {
    ...prevWith({}),
    sites: [{ ...probe("bsw", "down"), ring: "10", ring_slot: ringSlot(NOW) - 1 }],
  };
  const answers: Record<string, Answer> = {
    [`GET ${API}/workers/domains`]: domains([]),
    [`GET ${API}/workers/scripts/capsid/deployments`]: deployments([]),
    [`GET ${API}/workers/scripts/bsw/deployments`]: deployments([]),
    [`POST ${CF_GRAPHQL}`]: graph([["bsw", LAST_HOUR, 200, 5], ["capsid", LAST_HOUR, 200, 2]]),
  };
  const { gathered } = await gather(CREDS, answers, prev);
  const fps = gathered.findings.map((f) => f.fingerprint);
  assert.ok(fps.includes("site-down-bsw"), `site-down did not reach the findings: ${fps.join(", ")}`);
  assert.ok(fps.includes("site-errors-bsw"), `site-errors did not reach the findings: ${fps.join(", ")}`);
  assert.ok(!fps.includes("site-errors-capsid"), "exactly 1 percent fired through gatherFindings");
  assert.ok(gathered.ran.has("cloudflare"));
  assert.ok(gathered.ran.has("site probes"));
  assert.equal(gathered.observed.cloudflare?.foxing?.state, "unresolved");
});

// scanner-rule: Cloudflare is read in the watcher pass only, never per dashboard request
test("only the watcher and the admin cloudflare_config reads import the Cloudflare read, so no dashboard request can call Cloudflare", () => {
  const importersOf = (module: string) =>
    sourceFiles()
      // A static import, a bare side-effect import, or a dynamic import().
      .filter((f) => new RegExp(`(\\bfrom\\s*|\\bimport\\s*\\(?\\s*)["'](\\.\\.?\\/)+${module}(\\.ts)?["']`).test(f.text))
      .map((f) => f.name);
  assert.deepEqual(importersOf("ops-cloudflare"), ["ops-cloudflare-config.ts", "watcher.ts"]);
  // The config reads run per call of an admin-only MCP tool and nowhere else: not from
  // a Portal route, whose every page load would then call Cloudflare.
  assert.deepEqual(importersOf("ops-cloudflare-config"), ["tools/cloudflare.ts"]);
});

// The live checks' Web Analytics read (GET /accounts/{id}/rum/site_info/list).

const rumPage = (result: unknown[], page: number, totalPages: number): Response =>
  Response.json({ success: true, errors: [], result, result_info: { page, per_page: 2, total_pages: totalPages, total_count: 3 } });

test("readWebAnalyticsSites follows the pages, lower-cases hosts, keeps no site token, and reads what it cannot judge as null", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (input: string) => {
    urls.push(input);
    const page = Number(new URL(input).searchParams.get("page"));
    return page === 1
      ? rumPage([{ host: "A.example.com", auto_install: true, site_token: "secret-token", ruleset: { enabled: true } }, { host: "" }], 1, 2)
      : rumPage([{ host: "b.example.com", auto_install: "yes" }], 2, 2);
  }) as unknown as Parameters<typeof readWebAnalyticsSites>[0];
  const got = await readWebAnalyticsSites(fetchImpl, TOKEN, ACCOUNT);
  assert.deepEqual(got, [
    { host: "a.example.com", auto_install: true, enabled: true },
    { host: "b.example.com", auto_install: null, enabled: null },
  ]);
  assert.equal(urls.length, 2, "both pages were read");
  assert.ok(urls.every((u) => u.startsWith(`${API}/rum/site_info/list?`)), urls.join(", "));
  assert.doesNotMatch(JSON.stringify(got), /secret-token/);
});

test("PLANT: a 403 on the Web Analytics list names the permission the token lacks, and no other failure is turned into a list", async () => {
  const refused = (async () => Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 })) as unknown as Parameters<typeof readWebAnalyticsSites>[0];
  await assert.rejects(readWebAnalyticsSites(refused, TOKEN, ACCOUNT), (err: Error) => err.message.includes(`CF_OPS_TOKEN lacks ${WEB_ANALYTICS_PERMISSION}`));
  const broken = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as Parameters<typeof readWebAnalyticsSites>[0];
  await assert.rejects(readWebAnalyticsSites(broken, TOKEN, ACCOUNT), /not JSON|502/);
});
