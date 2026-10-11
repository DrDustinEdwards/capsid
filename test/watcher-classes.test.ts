import assert from "node:assert/strict";
import test from "node:test";
import { CLASS_PATTERNS, OWNER_PATTERNS, WATCHER_CHECKS, findingClass, runPass, type Finding, type FindingClass } from "../src/watcher.ts";
import type { FindingRow } from "../src/watcher-findings.ts";
import { fakeFindingMemory } from "./fakes.ts";

// What a finding is for (job_2c92174d5bff item 5): only job-class findings post jobs; the
// digest and attention classes are remembered and shown, and file nothing.

const NOW = new Date("2026-10-12T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const fake = (fingerprint: string, namespace = "sample"): Finding => ({ fingerprint, namespace, title: `Watcher: something [${fingerprint}]`, body: "evidence", evidence: ["line"] });

function pass(found: Finding[], open: Map<string, string>, memory = fakeFindingMemory()) {
  const posted: string[] = [];
  const closed: Array<{ id: string; summary?: string }> = [];
  const result = runPass(
    {
      findings: async () => ({ findings: found, ran: new Set(WATCHER_CHECKS) }),
      open: async () => open,
      clear: async (id, summary) => {
        closed.push({ id, summary });
        return true;
      },
      post: async (f) => {
        posted.push(f.fingerprint);
        return { ok: true as const, jobId: `job_${f.fingerprint}` };
      },
      memory: memory.memory,
    },
    NOW
  );
  return { result, posted, closed, memory };
}

// One fingerprint for each pattern in the table, the class it must have.
const EXPECTED: Array<[string, FindingClass]> = [
  ["site-down-sample", "job"],
  ["site-errors-sample", "job"],
  ["deploy-rolled-back-capsid", "job"],
  ["deploy-rollback-failed-capsid", "job"],
  ["backup-stale", "job"],
  ["backup-never", "job"],
  ["mirror-no-dump", "job"],
  ["mirror-not-running", "job"],
  ["mirror-run-failed-failure", "job"],
  ["mirror-green-no-dump", "job"],
  ["domain-expiry-7d-example-com", "job"],
  ["ci-red-sample", "job"],
  ["schema-behind-0045_x", "job"],
  ["health-degraded", "job"],
  ["deploy-drift-abc1234", "job"],
  ["site-map-drift-add-sample", "job"],
  ["unmapped-repo-owner--x", "job"],
  ["unmapped-repos-unreadable", "job"],
  ["live-config-invalid", "job"],
  ["live-config-unknown-site-sample", "job"],
  ["site-health-sample", "job"],
  ["live-csp-script-sample-home", "digest"],
  ["live-csp-report-sample-home", "digest"],
  ["live-headers-sample-home", "digest"],
  ["live-analytics-missing-sample", "digest"],
  ["live-analytics-off-sample", "digest"],
  ["live-analytics-unread-sample", "digest"],
  ["live-beacon-present-sample-home", "digest"],
  ["live-sha-unreported-sample", "digest"],
  ["live-sha-drift-sample-abc1234", "digest"],
  ["live-page-unread-sample-home", "digest"],
  ["scorer-diverged-a-b", "digest"],
  ["scorer-unread-x", "digest"],
  ["scorer-identity-unknown", "digest"],
  ["site-weekly-sample-tool", "digest"],
  ["anomaly-first-use-x", "attention"],
  ["anomaly-new-action-x-y", "attention"],
  ["anomaly-rate-x", "attention"],
  ["paused-sample", "attention"],
  ["budget-model-2026-10", "attention"],
  ["breaker-open-sample", "attention"],
];

test("every fingerprint has the class the ruling gives it", () => {
  for (const [fp, want] of EXPECTED) assert.equal(findingClass(fp), want, fp);
});

test("an unclassed fingerprint is a job", () => {
  assert.equal(findingClass("something-new-entirely"), "job");
});

test("EVERY OWNERS PATTERN HAS A CLASS, and every class names an owner (derived, both ways)", () => {
  const missingClass = OWNER_PATTERNS.filter((p) => !CLASS_PATTERNS.includes(p));
  const missingOwner = CLASS_PATTERNS.filter((p) => !OWNER_PATTERNS.includes(p));
  assert.deepEqual(missingClass, [], "an OWNERS pattern has no class");
  assert.deepEqual(missingOwner, [], "a class names a pattern OWNERS does not");
  assert.deepEqual(CLASS_PATTERNS, OWNER_PATTERNS, "same patterns in the same order, so first-match agrees");
});

test("A JOB-CLASS FINDING STILL POSTS A JOB", async () => {
  const w = pass([fake("site-down-sample")], new Map());
  assert.deepEqual((await w.result).posted, ["site-down-sample"]);
  assert.deepEqual(w.posted, ["site-down-sample"]);
});

test("A DIGEST-CLASS FINDING POSTS NO JOB, and is remembered open with no job", async () => {
  const w = pass([fake("live-csp-script-sample-home")], new Map());
  const result = await w.result;
  assert.deepEqual(w.posted, []);
  assert.deepEqual(result.posted, []);
  assert.deepEqual(result.routed, ["live-csp-script-sample-home"]);
  const row = w.memory.rows.get("live-csp-script-sample-home")!;
  assert.equal(row.state, "open");
  assert.equal(row.job_id, null);
  const again = pass([fake("live-csp-script-sample-home")], new Map(), w.memory);
  await again.result;
  assert.deepEqual(again.posted, [], "a second sighting posted");
  assert.equal(w.memory.rows.get("live-csp-script-sample-home")!.seen_count, 2);
});

test("AN ATTENTION-CLASS FINDING POSTS NO JOB", async () => {
  const w = pass([fake("anomaly-rate-sample-driver", "capsid"), fake("paused-sample")], new Map());
  await w.result;
  assert.deepEqual(w.posted, []);
  assert.equal(w.memory.rows.get("anomaly-rate-sample-driver")!.job_id, null);
});

test("a digest finding that stops being seen is cleared in memory", async () => {
  const w = pass([fake("live-headers-sample-home")], new Map());
  await w.result;
  await pass([], new Map(), w.memory).result;
  assert.equal(w.memory.rows.get("live-headers-sample-home")!.state, "cleared");
});

test("a queued job for a finding that is now digest or attention class is cleared with a note, once", async () => {
  const row: FindingRow = {
    fingerprint: "live-headers-sample-home",
    namespace: "sample",
    title: "Watcher: x [live-headers-sample-home]",
    state: "open",
    job_id: "job_old",
    first_seen_at: hoursAgo(10),
    last_seen_at: hoursAgo(1),
    seen_count: 3,
    cleared_at: null,
    reopen_after: null,
    evidence: "[]",
    updated_at: hoursAgo(1),
  };
  const memory = fakeFindingMemory([row, { ...row, fingerprint: "anomaly-rate-x", job_id: "job_old2" }]);
  const w = pass([fake("live-headers-sample-home"), fake("anomaly-rate-x"), fake("ci-red-sample")], new Map([["live-headers-sample-home", "job_old"], ["anomaly-rate-x", "job_old2"], ["ci-red-sample", "job_ci"]]), memory);
  const result = await w.result;
  assert.deepEqual(w.closed, [
    { id: "job_old", summary: "cleared: moved to the weekly digest, no job needed" },
    { id: "job_old2", summary: "cleared: moved to the Portal's attention list, no job needed" },
  ]);
  assert.deepEqual(result.cleared, ["live-headers-sample-home", "anomaly-rate-x"]);
  assert.equal(memory.rows.get("live-headers-sample-home")!.job_id, null, "the row still points at the closed job");
  assert.deepEqual(w.posted, [], "a job-class finding with an open job was posted again");
});

const routedRow = (over: Partial<FindingRow>): FindingRow => ({
  fingerprint: "live-headers-sample-home",
  namespace: "sample",
  title: "Watcher: x [live-headers-sample-home]",
  state: "open",
  job_id: null,
  first_seen_at: hoursAgo(100),
  last_seen_at: hoursAgo(1),
  seen_count: 3,
  cleared_at: null,
  reopen_after: null,
  evidence: "[]",
  updated_at: hoursAgo(1),
  ...over,
});

test("A DISMISSED DIGEST OR ATTENTION ROW STAYS DISMISSED", async () => {
  const memory = fakeFindingMemory([routedRow({ state: "dismissed" }), routedRow({ fingerprint: "anomaly-rate-x", state: "dismissed" })]);
  const w = pass([fake("live-headers-sample-home"), fake("anomaly-rate-x")], new Map(), memory);
  await w.result;
  assert.equal(memory.rows.get("live-headers-sample-home")!.state, "dismissed");
  assert.equal(memory.rows.get("anomaly-rate-x")!.state, "dismissed");
});

test("A CLEARED DIGEST ROW STAYS CLEARED INSIDE THE QUIET PERIOD and reopens outside it", async () => {
  const inside = routedRow({ state: "cleared", cleared_at: hoursAgo(1), reopen_after: new Date(NOW.getTime() + 3_600_000).toISOString() });
  const outside = routedRow({ fingerprint: "anomaly-rate-x", state: "cleared", cleared_at: hoursAgo(30), reopen_after: hoursAgo(6) });
  const memory = fakeFindingMemory([inside, outside]);
  await pass([fake("live-headers-sample-home"), fake("anomaly-rate-x")], new Map(), memory).result;
  assert.equal(memory.rows.get("live-headers-sample-home")!.state, "cleared");
  assert.equal(memory.rows.get("anomaly-rate-x")!.state, "open");
  assert.equal(memory.rows.get("anomaly-rate-x")!.job_id, null);
});

test("A ROUTED FINDING WHOSE JOB IS CLAIMED STAYS ATTACHED TO IT", async () => {
  const memory = fakeFindingMemory([routedRow({ job_id: "job_held" })]);
  const closed: string[] = [];
  const result = await runPass(
    {
      findings: async () => ({ findings: [fake("live-headers-sample-home")], ran: new Set(WATCHER_CHECKS) }),
      open: async () => new Map([["live-headers-sample-home", "job_held"]]),
      clear: async (id) => {
        closed.push(id);
        return false;
      },
      post: async () => ({ ok: false as const }),
      memory: memory.memory,
    },
    NOW
  );
  assert.deepEqual(closed, ["job_held"]);
  assert.deepEqual(result.cleared, []);
  assert.equal(memory.rows.get("live-headers-sample-home")!.job_id, "job_held", "the job was orphaned");
  assert.equal(memory.rows.get("live-headers-sample-home")!.state, "open");
});
