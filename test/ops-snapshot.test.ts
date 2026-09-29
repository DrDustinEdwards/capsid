import assert from "node:assert/strict";
import { test } from "node:test";
import type { HealthReport } from "../src/health.ts";
import type { OpsSite } from "../src/ops-sites.ts";
import {
  advanceRing,
  buildSnapshot,
  OPS_SNAPSHOT_KEY,
  probeSite,
  readSnapshot,
  RING_SLOTS,
  ringSlot,
  type OpsSnapshot,
  type SiteProbe,
} from "../src/ops-snapshot.ts";
import { checkStates, siteMapFindings, watcherTick, WATCHER_CHECKS, WATCHER_LAST_KEY, type Finding, type Gathered } from "../src/watcher.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// The watcher's pass, kept for the operations dashboard (PR 1 of the Watch Floor
// build, capsid/research/design-ops-console.md).

const NOW = new Date("2026-09-28T12:10:00.000Z");
const SLOT = ringSlot(NOW);

// The ring

test("the ring starts with this pass and advances one slot per half hour", () => {
  const first = advanceRing(undefined, SLOT, true);
  assert.deepEqual(first, { ring: "1", ring_slot: SLOT });
  assert.deepEqual(advanceRing(first, SLOT + 1, false), { ring: "10", ring_slot: SLOT + 1 });
});

test("slots no pass reached are marked as no data, not as up", () => {
  assert.deepEqual(advanceRing({ ring: "11", ring_slot: SLOT }, SLOT + 3, true), { ring: "11--1", ring_slot: SLOT + 3 });
});

test("two passes in one slot keep the worse result, so a success does not hide a failure", () => {
  assert.equal(advanceRing({ ring: "10", ring_slot: SLOT }, SLOT, true).ring, "10");
  assert.equal(advanceRing({ ring: "11", ring_slot: SLOT }, SLOT, false).ring, "10");
  // A clock that steps back folds into the last slot rather than rewriting history.
  assert.deepEqual(advanceRing({ ring: "11", ring_slot: SLOT }, SLOT - 4, false), { ring: "10", ring_slot: SLOT });
});

test("the ring holds 7 days of half-hour slots and no more, even after a long gap", () => {
  assert.equal(RING_SLOTS, 336);
  const full = { ring: "1".repeat(RING_SLOTS), ring_slot: SLOT };
  const next = advanceRing(full, SLOT + 1, false);
  assert.equal(next.ring.length, RING_SLOTS);
  assert.equal(next.ring.slice(-2), "10");
  const afterGap = advanceRing(full, SLOT + 10_000, true);
  assert.equal(afterGap.ring, "-".repeat(RING_SLOTS - 1) + "1");
});

// The probe

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
const site = (over: Partial<OpsSite>): OpsSite => ({ namespace: "sample", name: "Sample", origin: "https://sample.example.com", healthPath: "/health", platform: "cloudflare", ...over });
const HEALTH: HealthReport = {
  status: "ok",
  sha: "abc1234",
  dirty: false,
  builtAt: null,
  schema_version: null,
  store: { d1: "ok", fts: "ok" },
  bindings: { media: "ok", app_kv: "ok" },
  backup: { last_ok: null, age_hours: null },
};

test("a health route that answers 2xx is ok, with the sha it reports", async () => {
  const f = fetchFor({ "https://sample.example.com/health": { status: 200, body: JSON.stringify({ status: "ok", sha: "deadbee" }) } });
  const p = await probeSite(site({}), f.impl, NOW, null);
  assert.equal(p.state, "ok");
  assert.equal(p.sha, "deadbee");
  assert.equal(p.http_status, 200);
  assert.deepEqual(f.asked, ["https://sample.example.com/health"]);
});

test("a health body with no sha is ok and reports no sha", async () => {
  const f = fetchFor({ "https://sample.example.com/health": { status: 200, body: "not json" } });
  const p = await probeSite(site({}), f.impl, NOW, null);
  assert.equal(p.state, "ok");
  assert.equal(p.sha, null);
});

test("a failing health route on a site whose root answers is degraded, not down", async () => {
  const f = fetchFor({ "https://sample.example.com/health": 404, "https://sample.example.com/": 200 });
  const p = await probeSite(site({}), f.impl, NOW, null);
  assert.equal(p.state, "degraded");
  assert.equal(p.http_status, 404);
  assert.match(String(p.error), /health route answered 404/);
});

test("a site where nothing answers 2xx is down, with both reasons", async () => {
  const f = fetchFor({ "https://sample.example.com/health": 404, "https://sample.example.com/": 522 });
  const p = await probeSite(site({}), f.impl, NOW, null);
  assert.equal(p.state, "down");
  assert.match(String(p.error), /answered 404; root answered 522/);
});

test("a site with no health route is liveness at best", async () => {
  assert.equal((await probeSite(site({ healthPath: null }), fetchFor({ "https://sample.example.com/": 200 }).impl, NOW, null)).state, "liveness");
  assert.equal((await probeSite(site({ healthPath: null }), fetchFor({ "https://sample.example.com/": 503 }).impl, NOW, null)).state, "down");
  const thrown = await probeSite(site({ healthPath: null }), fetchFor({}).impl, NOW, null);
  assert.equal(thrown.state, "down");
  assert.match(String(thrown.error), /connect failed/);
});

test("Capsid itself is read in-process, never fetched", async () => {
  const f = fetchFor({});
  const self = site({ self: true });
  assert.equal((await probeSite(self, f.impl, NOW, HEALTH)).state, "ok");
  assert.equal((await probeSite(self, f.impl, NOW, { ...HEALTH, status: "degraded" })).state, "degraded");
  assert.equal((await probeSite(self, f.impl, NOW, null)).state, "down");
  assert.deepEqual(f.asked, []);
});

// The site map is compared with the registered namespaces in test/ops-sites.test.ts.

// Check states

test("each check is clear, a finding, or could not run, and only a check that ran can be clear", () => {
  const found: Finding[] = [{ fingerprint: "ci-red-abc1234", namespace: "foxhound", title: "t", body: "b" }];
  const states = checkStates({ findings: found, ran: new Set(["ci", "health"] as const) });
  assert.deepEqual(states.map((c) => c.id), [...WATCHER_CHECKS]);
  const byId = Object.fromEntries(states.map((c) => [c.id, c]));
  assert.equal(byId.ci.state, "finding");
  assert.deepEqual(byId.ci.findings, ["ci-red-abc1234"]);
  assert.equal(byId.health.state, "clear");
  assert.equal(byId.mirror_runs, undefined);
  assert.equal(byId["mirror runs"].state, "could-not-run");
});

// The snapshot

const probe = (namespace: string, state: SiteProbe["state"]): SiteProbe => ({
  namespace, name: namespace, origin: "https://x.example.com", health_path: null, platform: "cloudflare",
  state, http_status: state === "down" ? null : 200, latency_ms: 10, sha: null, error: null, checked_at: NOW.toISOString(),
});
const input = (probes: SiteProbe[] | null, at = NOW) => ({
  now: at, pass_ms: 1200, cadence_min: 30, checks: [], health: HEALTH, mirror: null, ci: [], site_map: null, probes,
});

test("each pass carries every site's ring forward from the last snapshot", () => {
  const one = buildSnapshot(null, input([probe("a", "liveness"), probe("b", "down")]));
  assert.deepEqual(one.sites.map((s) => s.ring), ["1", "0"]);
  const two = buildSnapshot(one, input([probe("a", "ok"), probe("b", "ok")], new Date(NOW.getTime() + 30 * 60_000)));
  assert.deepEqual(two.sites.map((s) => s.ring), ["11", "01"]);
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
  const errors: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  try {
    assert.equal(await readSnapshot(fakeEnv({ APP_KV: kv.kv })), null);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /OPS_SNAPSHOT_UNREADABLE/);
});

// The tick

function tickEnv(kv: ReturnType<typeof fakeKv>) {
  const noRows = { all: async () => ({ results: [] }), first: async () => null, run: async () => ({}) };
  return fakeEnv({ APP_KV: kv.kv, DB: { prepare: () => ({ ...noRows, bind: () => noRows }) } });
}
const gathered = (): Gathered => ({
  findings: [],
  ran: new Set(["health", "site probes"] as const),
  observed: { health: HEALTH, mirror: { newest_dump: null, last_run: null }, ci: [], siteMap: { unmapped: [], unknown: [] }, probes: [probe("capsid", "ok")] },
});

test("a pass writes ops:snapshot, then the watcher stamp", async () => {
  const kv = fakeKv();
  const report = await watcherTick(tickEnv(kv), NOW, async () => gathered());
  assert.equal(report.ran, true);
  const keys = kv.puts.map((p) => p.key);
  assert.deepEqual(keys, [OPS_SNAPSHOT_KEY, WATCHER_LAST_KEY], "the snapshot must be written before the stamp");
  const snap = JSON.parse(kv.store.get(OPS_SNAPSHOT_KEY) ?? "null") as OpsSnapshot;
  assert.equal(snap.pass_at, NOW.toISOString());
  assert.equal(snap.cadence_min, 30);
  assert.deepEqual(snap.sites.map((s) => [s.namespace, s.state, s.ring]), [["capsid", "ok", "1"]]);
  assert.equal(snap.checks.find((c) => c.id === "ci")?.state, "could-not-run");
  assert.equal(snap.checks.find((c) => c.id === "health")?.state, "clear");
});

test("a snapshot that cannot be written fails the pass, so the stamp is not written and the next tick runs again", async () => {
  const kv = fakeKv({ failPut: true });
  await assert.rejects(() => watcherTick(tickEnv(kv), NOW, async () => gathered()));
  assert.equal(kv.store.get(WATCHER_LAST_KEY), undefined);
});
