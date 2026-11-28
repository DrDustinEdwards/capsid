import assert from "node:assert/strict";
import { test } from "node:test";
import type { HealthReport } from "../src/health.ts";
import type { OpsSite } from "../src/ops-sites.ts";
import {
  advanceRing,
  buildSnapshot,
  OPS_SNAPSHOT_KEY,
  MAX_HEALTH_BYTES,
  probeSite,
  readSnapshot,
  RING_SLOTS,
  ringSlot,
  type OpsSnapshot,
  type SiteProbe,
} from "../src/ops-snapshot.ts";
import { checkStates, watcherTick, WATCHER_LAST_KEY, type Gathered } from "../src/watcher.ts";
import { WATCHER_CHECKS } from "../src/watcher-checks.ts";
import { type Finding } from "../src/watcher-detect.ts";
import { captureErrors, fakeEnv, fakeKv } from "./fakes.ts";

const NOW = new Date("2026-09-28T12:10:00.000Z");
const SLOT = ringSlot(NOW);

test("the ring advances a slot per half hour, marks skipped slots as no data, keeps the worse of one slot, and holds 7 days", () => {
  const full = { ring: "1".repeat(RING_SLOTS), ring_slot: SLOT };
  const cases: Array<[Parameters<typeof advanceRing>, { ring: string; ring_slot: number }]> = [
    [[undefined, SLOT, true], { ring: "1", ring_slot: SLOT }],
    [[{ ring: "1", ring_slot: SLOT }, SLOT + 1, false], { ring: "10", ring_slot: SLOT + 1 }],
    [[{ ring: "11", ring_slot: SLOT }, SLOT + 3, true], { ring: "11--1", ring_slot: SLOT + 3 }],
    [[{ ring: "10", ring_slot: SLOT }, SLOT, true], { ring: "10", ring_slot: SLOT }],
    [[{ ring: "11", ring_slot: SLOT }, SLOT, false], { ring: "10", ring_slot: SLOT }],
    // A clock that steps back folds into the last slot rather than rewriting history.
    [[{ ring: "11", ring_slot: SLOT }, SLOT - 4, false], { ring: "10", ring_slot: SLOT }],
    [[full, SLOT + 1, false], { ring: "1".repeat(RING_SLOTS - 1) + "0", ring_slot: SLOT + 1 }],
    [
      [full, SLOT + 10_000, true],
      { ring: "-".repeat(RING_SLOTS - 1) + "1", ring_slot: SLOT + 10_000 },
    ],
  ];
  for (const [args, want] of cases)
    assert.deepEqual(advanceRing(...args), want, JSON.stringify(args.slice(0, 2)));
});

type Answer = number | "throw" | { status: number; body: string };
function fetchFor(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const impl = async (url: string) => {
    asked.push(url);
    const a = answers[url];
    if (a === undefined || a === "throw") throw new Error(`connect failed for ${url}`);
    if (typeof a === "number") return new Response("x", { status: a });
    return new Response(a.body, { status: a.status });
  };
  return { impl, asked };
}
const site = (over: Partial<OpsSite>): OpsSite => ({
  namespace: "sample",
  name: "Sample",
  origin: "https://sample.example.com",
  healthPath: "/health",
  platform: "cloudflare",
  ...over,
});
const HEALTH: HealthReport = {
  status: "ok",
  sha: "abc1234",
  schema_version: null,
  store: { d1: "ok", fts: "ok" },
  bindings: { media: "ok", app_kv: "ok" },
  backup: { last_ok: null, age_hours: null },
};

const H = "https://sample.example.com/health";
const ROOT = "https://sample.example.com/";
const FAIL_BODY = JSON.stringify({
  status: "fail",
  ok: false,
  checks: [{ name: "db", status: "fail" }],
});

test("a probe's state, from what the health route and the root answer", async () => {
  const okBody = { status: 200, body: JSON.stringify({ status: "ok", sha: "deadbee" }) };
  const cases: Array<
    [string, Partial<OpsSite>, Record<string, Answer>, SiteProbe["state"], RegExp | null]
  > = [
    // An API host's 404 at its root is not a failure.
    ["health ok, root 404", {}, { [H]: okBody, [ROOT]: 404 }, "ok", null],
    [
      "health ok, home page 5xx",
      {},
      { [H]: okBody, [ROOT]: 500 },
      "degraded",
      /home page answered 500/,
    ],
    ["health 404, root up", {}, { [H]: 404, [ROOT]: 200 }, "degraded", /health route answered 404/],
    ["nothing 2xx", {}, { [H]: 404, [ROOT]: 522 }, "down", /answered 404; root answered 522/],
    [
      "a 2xx body that admits a problem",
      {},
      {
        [H]: {
          status: 200,
          body: JSON.stringify({ ok: true, backup: { warning: "last backup 38h ago" } }),
        },
        [ROOT]: 200,
      },
      "degraded",
      /^backup: last backup 38h ago$/,
    ],
    [
      "a fail body",
      {},
      { [H]: { status: 503, body: FAIL_BODY }, [ROOT]: 503 },
      "down",
      /answered 503 fail \(db\); root answered 503/,
    ],
    ["no health route, root up", { healthPath: null }, { [ROOT]: 200 }, "liveness", null],
    ["no health route, root 503", { healthPath: null }, { [ROOT]: 503 }, "down", null],
    ["no health route, root throws", { healthPath: null }, {}, "down", /connect failed/],
  ];
  for (const [name, over, answers, state, error] of cases) {
    const p = await probeSite(site(over), fetchFor(answers).impl, NOW, null);
    assert.equal(p.state, state, name);
    if (error) assert.match(String(p.error), error, name);
  }

  const f = fetchFor({ [H]: okBody, [ROOT]: 404 });
  const ok = await probeSite(site({}), f.impl, NOW, null);
  assert.equal(ok.sha, "deadbee");
  assert.equal(ok.http_status, 200);
  assert.deepEqual(f.asked.sort(), [ROOT, H]);

  const elsewhere = fetchFor({ "https://health.example.com/health": 404, [ROOT]: 200 });
  await probeSite(
    site({ healthPath: "https://health.example.com/health" }),
    elsewhere.impl,
    NOW,
    null,
  );
  assert.deepEqual(
    elsewhere.asked,
    ["https://health.example.com/health", ROOT],
    "the root fallback stays on the origin",
  );
});

test("PLANT: a health body past the cap is not read whole and yields no sha", async () => {
  const huge = JSON.stringify({
    status: "ok",
    sha: "deadbee",
    pad: "x".repeat(MAX_HEALTH_BYTES),
  });
  const impl = async () => new Response(huge, { status: 200 });
  const p = await probeSite(site({}), impl, NOW, null);
  assert.equal(p.state, "ok");
  assert.equal(p.sha, null, "a body past the cap was read whole");
});

test("a health route that redirects to another host is not that site's answer", async () => {
  const impl = async () => {
    const res = new Response(JSON.stringify({ status: "ok", sha: "deadbee" }), { status: 200 });
    Object.defineProperty(res, "url", { value: "https://other.example.net/health" });
    return res;
  };
  const p = await probeSite(site({}), impl, NOW, null);
  assert.equal(p.state, "down");
  assert.equal(p.sha, null);
  assert.match(String(p.error), /redirected off the site to https:\/\/other\.example\.net/);
});

test("a root that redirects to the Access sign-in is up, and a health route behind it is not", async () => {
  const signIn = async (url: string) => {
    const res = new Response("<html>sign in</html>", { status: 200 });
    Object.defineProperty(res, "url", {
      value: `https://team.cloudflareaccess.com/login?r=${url}`,
    });
    return res;
  };
  assert.equal((await probeSite(site({ healthPath: null }), signIn, NOW, null)).state, "liveness");
  assert.equal((await probeSite(site({}), signIn, NOW, null)).state, "degraded");
});

test("Capsid itself is read in-process, never fetched", async () => {
  const f = fetchFor({});
  const self = site({ self: true });
  assert.equal((await probeSite(self, f.impl, NOW, HEALTH)).state, "ok");
  assert.equal(
    (await probeSite(self, f.impl, NOW, { ...HEALTH, status: "degraded" })).state,
    "degraded",
  );
  assert.equal(
    (
      await probeSite(self, f.impl, NOW, {
        ...HEALTH,
        backup: { last_ok: null, age_hours: 38, warning: "over 26h" },
      })
    ).error,
    "backup: over 26h",
  );
  assert.equal((await probeSite(self, f.impl, NOW, null)).state, "down");
  assert.deepEqual(f.asked, []);
});

test("each check is clear, a finding, or could not run, and only a check that ran can be clear", () => {
  const found: Finding[] = [
    {
      fingerprint: "ci-red-abc1234",
      namespace: "foxhound",
      title: "t",
    },
  ];
  const states = checkStates({
    findings: found,
    ran: new Set(["ci", "health"] as const),
  });
  assert.deepEqual(
    states.map((c) => c.id),
    [...WATCHER_CHECKS],
  );
  const byId = Object.fromEntries(states.map((c) => [c.id, c]));
  assert.equal(byId.ci.state, "finding");
  assert.deepEqual(byId.ci.findings, ["ci-red-abc1234"]);
  assert.equal(byId.health.state, "clear");
  assert.equal(byId.offaccount.state, "could-not-run");
});

const probe = (namespace: string, state: SiteProbe["state"]): SiteProbe => ({
  namespace,
  name: namespace,
  origin: "https://x.example.com",
  health_path: null,
  platform: "cloudflare",
  state,
  http_status: state === "down" ? null : 200,
  latency_ms: 10,
  sha: null,
  error: null,
  checked_at: NOW.toISOString(),
});
const input = (probes: SiteProbe[] | null, at = NOW) => ({
  now: at,
  pass_ms: 1200,
  cadence_min: 30,
  checks: [],
  health: HEALTH,
  offaccount: null,
  ci: [],
  site_map: null,
  probes,
});

test("each pass carries every site's ring forward from the last snapshot", () => {
  const one = buildSnapshot(null, input([probe("a", "liveness"), probe("b", "down")]));
  assert.deepEqual(
    one.sites.map((s) => s.ring),
    ["1", "0"],
  );
  const two = buildSnapshot(
    one,
    input([probe("a", "ok"), probe("b", "ok")], new Date(NOW.getTime() + 30 * 60_000)),
  );
  assert.deepEqual(
    two.sites.map((s) => s.ring),
    ["11", "01"],
  );
  assert.equal(two.version, 1);
  assert.equal(two.pass_at, "2026-09-28T12:40:00.000Z");
});

test("a pass whose probes could not run keeps each site and marks the slot as no data", () => {
  const one = buildSnapshot(null, input([probe("a", "ok")]));
  const two = buildSnapshot(one, input(null, new Date(NOW.getTime() + 60 * 60_000)));
  assert.equal(two.sites.length, 1);
  assert.equal(two.sites[0].ring, "1--");
  assert.equal(two.sites[0].state, "ok", "the last probe is kept, and the ring says it is old");
});

test("an unreadable snapshot is logged and the rings start again", async () => {
  const kv = fakeKv({ seed: { [OPS_SNAPSHOT_KEY]: "{not json" } });
  const { result, errors } = await captureErrors(() => readSnapshot(fakeEnv({ APP_KV: kv.kv })));
  assert.equal(result, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /OPS_SNAPSHOT_UNREADABLE/);
});

function tickEnv(kv: ReturnType<typeof fakeKv>) {
  const noRows = {
    all: async () => ({ results: [] }),
    first: async () => null,
    run: async () => ({}),
  };
  return fakeEnv({
    APP_KV: kv.kv,
    DB: { prepare: () => ({ ...noRows, bind: () => noRows }) },
  });
}
const gathered = (): Gathered => ({
  findings: [],
  ran: new Set(["health", "site probes"] as const),
  observed: {
    health: HEALTH,
    offaccount: {
      reported_at: null,
      sites: [],
      last_run: null,
      last_drill: null,
    },
    ci: [],
    siteMap: { unmapped: [], unknown: [] },
    probes: [probe("capsid", "ok")],
  },
});

test("a pass writes ops:snapshot, then the watcher stamp", async () => {
  const kv = fakeKv();
  const report = await watcherTick(tickEnv(kv), NOW, async () => gathered());
  assert.equal(report.ran, true);
  const keys = kv.puts.map((p) => p.key);
  assert.deepEqual(
    keys,
    [OPS_SNAPSHOT_KEY, WATCHER_LAST_KEY],
    "the snapshot must be written before the stamp",
  );
  const snap = JSON.parse(kv.store.get(OPS_SNAPSHOT_KEY) ?? "null") as OpsSnapshot;
  assert.equal(snap.pass_at, NOW.toISOString());
  assert.equal(snap.cadence_min, 30);
  assert.deepEqual(
    snap.sites.map((s) => [s.namespace, s.state, s.ring]),
    [["capsid", "ok", "1"]],
  );
  assert.equal(snap.checks.find((c) => c.id === "ci")?.state, "could-not-run");
  assert.equal(snap.checks.find((c) => c.id === "health")?.state, "clear");
});

test("a snapshot that cannot be written fails the pass, so the stamp is not written and the next tick runs again", async () => {
  const kv = fakeKv({ failPut: true });
  await assert.rejects(() => watcherTick(tickEnv(kv), NOW, async () => gathered()));
  assert.equal(kv.store.get(WATCHER_LAST_KEY), undefined);
});
