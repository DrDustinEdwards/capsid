import assert from "node:assert/strict";
import { test } from "node:test";
import { FLOOR, PublicStatsSchema, readStatsRows, summarize, type StatsRows } from "../src/public-stats.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// The public aggregate numbers (docs/public-data.md). Ruling 3: counts and rates only,
// never a title, body, name, email, error text or time of day.

const NOW = new Date("2026-10-11T00:05:00Z");
const DAY = 86_400_000;
const daysAgo = (d: number, hour = 12) => new Date(Date.UTC(2026, 9, 11) - d * DAY + hour * 3_600_000).toISOString();

function rows(over: Partial<StatsRows> = {}): StatsRows {
  return { finished: [], open: [], outcomes: [], evaluations: [], waits: [], rings: [], documents: 0, namespaces: 0, systems: null, sha: undefined, ...over };
}

// Every key the document may carry, as dotted paths. A new field is a decision: it
// goes here, with the reason it cannot leak in docs/public-data.md.
const ALLOWED = [
  "version", "as_of",
  "jobs", "jobs.completed_7d", "jobs.completed_30d", "jobs.failed_30d", "jobs.completed_by_week", "jobs.failed_by_week", "jobs.open", "jobs.blocked", "jobs.median_duration_minutes_30d",
  "verification", "verification.evaluations_90d", "verification.agreement_rate_90d", "verification.pr_merge_rate_90d", "verification.ci_green_rate_90d", "verification.agreement_by_week",
  "gates", "gates.waits_30d", "gates.median_wait_minutes_30d", "gates.share_ended_by_policy_30d", "gates.waits_by_week",
  "sites", "sites.watched", "sites.uptime_7d", "sites.slots_measured_7d",
  "store", "store.documents", "store.namespaces",
  "systems", "systems.public", "systems.private",
  "capsid", "capsid.sha7",
];

function keyPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => [prefix + k, ...keyPaths(v, `${prefix}${k}.`)]);
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

test("the document carries exactly the listed keys, and no string but the date and the sha", () => {
  const doc = summarize(rows({ systems: { public: 12, private: 5 }, sha: "a0446da4e41a3dec99026e8e5023d4c6e54919cf" }), NOW);
  const paths = keyPaths(doc);
  assert.ok(paths.length >= 30, `walked only ${paths.length} keys`);
  assert.deepEqual([...paths].sort(), [...ALLOWED].sort());
  assert.deepEqual(strings(doc).sort(), ["2026-10-11", "a0446da"]);
  assert.ok(PublicStatsSchema.safeParse(doc).success);
  const planted = { ...doc, jobs: { ...doc.jobs, newest_title: "x" } };
  assert.equal(PublicStatsSchema.safeParse(planted).success, false, "the strict schema let an extra key through");
});

test("windows are whole UTC days ending at midnight: today's activity is not counted yet", () => {
  const finished = [
    { status: "done", updated_at: daysAgo(0, 0.01) }, // today, after midnight: excluded
    { status: "done", updated_at: daysAgo(1) }, // yesterday
    { status: "done", updated_at: daysAgo(8) }, // 8 days ago: outside the 7-day window
    { status: "done", updated_at: daysAgo(29) },
    { status: "failed", updated_at: daysAgo(3) },
    { status: "done", updated_at: daysAgo(50) }, // week 8
  ];
  const doc = summarize(rows({ finished }), NOW);
  assert.equal(doc.as_of, "2026-10-11");
  assert.equal(doc.jobs.completed_7d, 1);
  assert.equal(doc.jobs.completed_30d, 3);
  assert.equal(doc.jobs.failed_30d, 1);
  assert.deepEqual(doc.jobs.completed_by_week, [1, 0, 0, 1, 0, 0, 1, 1]);
  assert.equal(doc.jobs.completed_by_week.reduce((a, b) => a + b, 0), 4);
});

test(`a rate or median over fewer than ${FLOOR} rows is null, never a number one job could be read off`, () => {
  const agreeing = (n: number) => Array.from({ length: n }, () => ({ agreement: "agree", recorded_at: daysAgo(3) }));
  const below = summarize(rows({ evaluations: [...agreeing(FLOOR - 2), { agreement: "disagree", recorded_at: daysAgo(3) }, { agreement: "unclaimed", recorded_at: daysAgo(3) }] }), NOW);
  assert.equal(below.verification.agreement_rate_90d, null, "agree plus disagree is under the floor; unclaimed must not count");
  assert.equal(below.verification.evaluations_90d, FLOOR);
  const at = summarize(rows({ evaluations: [...agreeing(FLOOR - 1), { agreement: "disagree", recorded_at: daysAgo(3) }] }), NOW);
  assert.equal(at.verification.agreement_rate_90d, 0.9);

  const waits = Array.from({ length: FLOOR - 1 }, () => ({ actor_kind: "human", waited_ms: 60_000, at: daysAgo(3) }));
  const fewWaits = summarize(rows({ waits }), NOW);
  assert.equal(fewWaits.gates.median_wait_minutes_30d, null);
  assert.equal(fewWaits.gates.share_ended_by_policy_30d, null);
  const enough = summarize(rows({ waits: [...waits, { actor_kind: "policy", waited_ms: 180_000, at: daysAgo(3) }] }), NOW);
  assert.equal(enough.gates.median_wait_minutes_30d, 1);
  assert.equal(enough.gates.share_ended_by_policy_30d, 0.1);
});

test("the weekly series count each of the eight whole weeks, and a week's agreement under the floor is null", () => {
  const evaluations = [
    ...Array.from({ length: FLOOR }, (_, i) => ({ agreement: i ? "agree" : "disagree", recorded_at: daysAgo(2) })),
    ...Array.from({ length: FLOOR - 1 }, () => ({ agreement: "agree", recorded_at: daysAgo(10) })),
  ];
  const waits = [{ actor_kind: "human", waited_ms: 1, at: daysAgo(3) }, { actor_kind: "human", waited_ms: 1, at: daysAgo(40) }];
  const finished = [{ status: "failed", updated_at: daysAgo(3) }, { status: "failed", updated_at: daysAgo(50) }, { status: "done", updated_at: daysAgo(3) }];
  const doc = summarize(rows({ evaluations, waits, finished }), NOW);
  assert.deepEqual(doc.verification.agreement_by_week, [null, null, null, null, null, null, null, 0.9]);
  assert.deepEqual(doc.gates.waits_by_week, [0, 0, 1, 0, 0, 0, 0, 1]);
  assert.equal(doc.gates.waits_30d, 1, "a wait from 40 days ago is in its week but not in the 30 days");
  assert.deepEqual(doc.jobs.failed_by_week, [1, 0, 0, 0, 0, 0, 0, 1]);
});

test("only verified outcome fields feed a rate, as the agent record reads them", () => {
  const outcome = (verified: object, o: Partial<StatsRows["outcomes"][number]>) => ({ recorded_at: daysAgo(5), duration_minutes: 30, prs_opened: 1, prs_merged: 1, ci_green: 1, verified: JSON.stringify(verified), ...o });
  const outcomes = [
    ...Array.from({ length: 8 }, () => outcome({ prs_opened: true, prs_merged: true, ci_green: true }, {})),
    ...Array.from({ length: 2 }, () => outcome({ prs_opened: true, prs_merged: true, ci_green: true }, { prs_merged: 0, ci_green: 0 })),
    // Driver-reported only: must not count.
    ...Array.from({ length: 20 }, () => outcome({}, { prs_merged: 0, ci_green: 0 })),
  ];
  const doc = summarize(rows({ outcomes }), NOW);
  assert.equal(doc.verification.pr_merge_rate_90d, 0.8);
  assert.equal(doc.verification.ci_green_rate_90d, 0.8);
  assert.equal(doc.jobs.median_duration_minutes_30d, 30);
});

test("uptime counts measured slots only, across every site", () => {
  const doc = summarize(rows({ rings: ["111-0", "11--1", "1111"] }), NOW);
  assert.equal(doc.sites.watched, 3);
  assert.equal(doc.sites.slots_measured_7d, 11);
  assert.equal(doc.sites.uptime_7d, 0.909);
});

test("the reads keep each window and status, so rows outside them never reach the numbers", async () => {
  const d1 = fakeD1({
    jobs: [
      { id: "j1", status: "done", updated_at: daysAgo(2) },
      { id: "j2", status: "done", updated_at: daysAgo(0, 0.01) },
      { id: "j3", status: "done", updated_at: daysAgo(70) },
      { id: "j4", status: "claimed", updated_at: daysAgo(1) },
      { id: "j5", status: "blocked", updated_at: daysAgo(1) },
      { id: "j6", status: "superseded", updated_at: daysAgo(1) },
    ],
    namespaces: [{ namespace: "sample" }, { namespace: "other" }],
  });
  d1.rows.job_evaluations.push({ agreement: "agree", recorded_at: daysAgo(10) }, { agreement: "agree", recorded_at: daysAgo(100) });
  d1.rows.job_touches.push({ actor_kind: "policy", waited_ms: 1000, at: daysAgo(4) }, { actor_kind: "human", waited_ms: null, at: daysAgo(4) }, { actor_kind: "human", waited_ms: 5, at: daysAgo(70) });
  const read = await readStatsRows(fakeEnv({ DB: d1.db, APP_KV: fakeKv().kv, BUILD_SHA: "abc1234" }), NOW, null);
  assert.deepEqual(read.finished.map((r) => r.updated_at), [daysAgo(2)]);
  assert.deepEqual(read.open.map((r) => [r.status, r.n]).sort(), [["blocked", 1], ["claimed", 1]]);
  assert.equal(read.evaluations.length, 1);
  assert.deepEqual(read.waits, [{ actor_kind: "policy", waited_ms: 1000, at: daysAgo(4) }]);
  assert.equal(read.namespaces, 2);
  assert.deepEqual(read.rings, []);
});
