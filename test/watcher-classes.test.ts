import assert from "node:assert/strict";
import test from "node:test";
import { runPass } from "../src/watcher-pass.ts";
import {
  CLASS_PATTERNS,
  OWNER_PATTERNS,
  WATCHER_CHECKS,
  findingClass,
} from "../src/watcher-checks.ts";
import { type Finding } from "../src/watcher-detect.ts";
import type { FindingRow } from "../src/watcher-findings.ts";
import { fakeFindingMemory } from "./fakes.ts";

const NOW = new Date("2026-10-12T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const fake = (fingerprint: string, namespace = "sample"): Finding => ({
  fingerprint,
  namespace,
  title: `Watcher: something [${fingerprint}]`,
  evidence: ["line"],
});

function pass(found: Finding[], memory = fakeFindingMemory()) {
  const result = runPass(
    {
      findings: async () => ({ findings: found, ran: new Set(WATCHER_CHECKS) }),
      memory: memory.memory,
    },
    NOW,
  );
  return { result, memory };
}

test("an unclassed fingerprint is an alert", () => {
  assert.equal(findingClass("something-new-entirely"), "alert");
});

test("EVERY OWNERS PATTERN HAS A CLASS, and every class names an owner (derived, both ways)", () => {
  const missingClass = OWNER_PATTERNS.filter((p) => !CLASS_PATTERNS.includes(p));
  const missingOwner = CLASS_PATTERNS.filter((p) => !OWNER_PATTERNS.includes(p));
  assert.deepEqual(missingClass, [], "an OWNERS pattern has no class");
  assert.deepEqual(missingOwner, [], "a class names a pattern OWNERS does not");
  assert.deepEqual(
    CLASS_PATTERNS,
    OWNER_PATTERNS,
    "same patterns in the same order, so first-match agrees",
  );
});

test("a digest or attention finding is recorded open, and a second sighting is counted", async () => {
  const w = pass([fake("live-csp-script-sample-home"), fake("anomaly-rate-sample-driver")]);
  const result = await w.result;
  assert.deepEqual(result.recorded, ["live-csp-script-sample-home", "anomaly-rate-sample-driver"]);
  assert.equal(w.memory.rows.get("live-csp-script-sample-home")!.state, "open");
  await pass([fake("live-csp-script-sample-home")], w.memory).result;
  assert.equal(w.memory.rows.get("live-csp-script-sample-home")!.seen_count, 2);
});

test("a digest finding that stops being seen is cleared in memory", async () => {
  const w = pass([fake("live-headers-sample-home")]);
  await w.result;
  await pass([], w.memory).result;
  assert.equal(w.memory.rows.get("live-headers-sample-home")!.state, "cleared");
});

const row = (over: Partial<FindingRow>): FindingRow => ({
  fingerprint: "live-headers-sample-home",
  namespace: "sample",
  title: "Watcher: x [live-headers-sample-home]",
  state: "open",
  first_seen_at: hoursAgo(100),
  last_seen_at: hoursAgo(1),
  seen_count: 3,
  cleared_at: null,
  reopen_after: null,
  evidence: "[]",
  updated_at: hoursAgo(1),
  ...over,
});

test("A CLEARED DIGEST ROW STAYS CLEARED INSIDE THE QUIET PERIOD and reopens outside it", async () => {
  const inside = row({
    state: "cleared",
    cleared_at: hoursAgo(1),
    reopen_after: new Date(NOW.getTime() + 3_600_000).toISOString(),
  });
  const outside = row({
    fingerprint: "anomaly-rate-x",
    state: "cleared",
    cleared_at: hoursAgo(30),
    reopen_after: hoursAgo(6),
  });
  const memory = fakeFindingMemory([inside, outside]);
  await pass([fake("live-headers-sample-home"), fake("anomaly-rate-x")], memory).result;
  assert.equal(memory.rows.get("live-headers-sample-home")!.state, "cleared");
  assert.equal(memory.rows.get("anomaly-rate-x")!.state, "open");
});
