import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FLOOR,
  PublicStatsSchema,
  readStatsRows,
  summarize,
  type StatsRows,
} from "../src/public-stats.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

const NOW = new Date("2026-10-11T00:05:00Z");

function rows(over: Partial<StatsRows> = {}): StatsRows {
  return {
    rings: [],
    documents: 0,
    namespaces: 0,
    systems: null,
    sha: undefined,
    ...over,
  };
}

// Every key the document may carry, as dotted paths. A new field is a decision: it
// goes here, with the reason it cannot leak in docs/public-data.md.
const ALLOWED = [
  "version",
  "as_of",
  "sites",
  "sites.watched",
  "sites.uptime_7d",
  "sites.slots_measured_7d",
  "store",
  "store.documents",
  "store.namespaces",
  "systems",
  "systems.public",
  "systems.private",
  "capsid",
  "capsid.sha7",
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
  const doc = summarize(
    rows({ systems: { public: 12, private: 5 }, sha: "a0446da4e41a3dec99026e8e5023d4c6e54919cf" }),
    NOW,
  );
  assert.deepEqual([...keyPaths(doc)].sort(), [...ALLOWED].sort());
  assert.deepEqual(strings(doc).sort(), ["2026-10-11", "a0446da"]);
  assert.ok(PublicStatsSchema.safeParse(doc).success);
  const planted = { ...doc, store: { ...doc.store, newest_title: "x" } };
  assert.equal(
    PublicStatsSchema.safeParse(planted).success,
    false,
    "the strict schema let an extra key through",
  );
});

test("uptime counts measured slots only, across every site", () => {
  const doc = summarize(rows({ rings: ["111-0", "11--1", "1111"] }), NOW);
  assert.equal(doc.sites.watched, 3);
  assert.equal(doc.sites.slots_measured_7d, 11);
  assert.equal(doc.sites.uptime_7d, 0.909);
});

test(`uptime over fewer than ${FLOOR} measured slots is null, never a number`, () => {
  const doc = summarize(rows({ rings: ["1".repeat(FLOOR - 1)] }), NOW);
  assert.equal(doc.sites.uptime_7d, null);
  assert.equal(doc.sites.slots_measured_7d, FLOOR - 1);
});

test("the reads count documents and namespaces, and a sha that is not one reads as unknown", async () => {
  const d1 = fakeD1({
    documents: [
      { namespace: "sample", path: "a.md" },
      { namespace: "sample", path: "b.md" },
    ],
    namespaces: [{ namespace: "sample" }, { namespace: "other" }],
  });
  const read = await readStatsRows(
    fakeEnv({ DB: d1.db, APP_KV: fakeKv().kv, BUILD_SHA: "not-a-sha" }),
    NOW,
    null,
  );
  assert.equal(read.namespaces, 2);
  assert.equal(read.documents, 2);
  assert.deepEqual(read.rings, []);
  assert.equal(summarize(read, NOW).capsid.sha7, "unknown");
});
