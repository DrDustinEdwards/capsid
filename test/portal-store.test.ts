import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { D1_CAP_BYTES, sizeFrom } from "../src/ops-feed.ts";
import type { OpsFeed } from "../src/ops-types.ts";

// The D1 store's size against its cap (capsid/decisions.md 2026-09-30, "admin panels
// review adopted", item 5): read from the jobs read's meta.size_after, shown on Backups,
// and a warning in Needs attention from half the cap.
const { attentionItems, storeUse } = await import("../dashboard/src/lib/derive.ts");
const { bytes } = await import("../dashboard/src/lib/format.ts");

const SAMPLE = readFileSync(join(import.meta.dirname, "..", "dashboard", "dev", "sample-feed.json"), "utf8");
function feed(size: number | null): { f: OpsFeed; now: number } {
  const f = JSON.parse(SAMPLE) as OpsFeed;
  f.live.store = { size_bytes: size, cap_bytes: D1_CAP_BYTES };
  return { f, now: Date.parse(f.live.generated) };
}
const storeRows = (f: OpsFeed, now: number) => attentionItems(f, now).filter((a) => a.title.startsWith("The D1 store"));

test("PLANT: a size D1 did not report is null, never zero", () => {
  assert.equal(sizeFrom({ size_after: 50_646_220 }), 50_646_220);
  assert.equal(sizeFrom({ size_after: 0 }), 0);
  for (const meta of [undefined, null, {}, { size_after: "12" }, { size_after: -1 }, { size_after: Number.NaN }]) {
    assert.equal(sizeFrom(meta), null, JSON.stringify(meta));
  }
});

test("the cap is D1's 10 GB per database on Workers Paid", () => {
  assert.equal(D1_CAP_BYTES, 10 * 1024 * 1024 * 1024);
  assert.equal(bytes(D1_CAP_BYTES), "10 GB");
});

test("PLANT: from half the cap the store is a warning in Needs attention, and not below it", () => {
  const below = feed(D1_CAP_BYTES / 2 - 1);
  assert.deepEqual(storeRows(below.f, below.now), []);
  assert.equal(storeUse(below.f)?.warn, false);
  const half = feed(D1_CAP_BYTES / 2);
  assert.deepEqual(
    storeRows(half.f, half.now).map((a) => [a.sev, a.title, a.sub, a.open]),
    [["warn", "The D1 store is at 50% of its 10 GB cap", "5 GB used", "view:backups"]]
  );
});

test("a size that was not reported is no row and no fraction", () => {
  const { f, now } = feed(null);
  assert.equal(storeUse(f), null);
  assert.deepEqual(storeRows(f, now), []);
});

test("bytes reads in binary units, one decimal under a hundred", () => {
  assert.deepEqual([bytes(512), bytes(2048), bytes(50_646_220), bytes(150 * 1024 * 1024), bytes(5 * 1024 ** 3)], ["512 B", "2 KB", "48.3 MB", "150 MB", "5 GB"]);
});
