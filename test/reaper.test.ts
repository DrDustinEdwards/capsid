import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error the scripts/ tree is plain .mjs with no type declarations, and
// deliberately so: it runs in the live CI job with no npm ci and no build step.
import { reapProbeClient, reportFor } from "../scripts/reap-lib.mjs";

// The reaper reads before it deletes. KV DELETE is idempotent: deleting a key that
// was never there returns the same 200, and the read-back returns 404 either way. So
// DELETE then confirm-404 cannot tell a normal delete from data loss.
//
// Every test here checks that distinction, not the cleanup.

type Call = { url: string; method: string };

// A KV REST API stand-in. `present` is the state of the one key, and the stub
// mutates it on DELETE exactly as the real API does, so a test cannot pass by
// asserting against a store that never changed.
function fakeKvApi(opts: { present: boolean; failReadWith?: number; failDeleteWith?: number; deleteReally?: boolean }) {
  const calls: Call[] = [];
  let present = opts.present;
  const fetchImpl = (async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "DELETE") {
      if (opts.failDeleteWith) return { ok: false, status: opts.failDeleteWith, text: async () => "boom" };
      // The real API removes the key and answers 200 whether or not it existed.
      if (opts.deleteReally !== false) present = false;
      return { ok: true, status: 200, text: async () => "" };
    }
    if (opts.failReadWith) return { ok: false, status: opts.failReadWith, text: async () => "unauthorized" };
    return present
      ? { ok: true, status: 200, text: async () => '{"clientId":"probe"}' }
      : { ok: false, status: 404, text: async () => "" };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, isPresent: () => present };
}

const run = (stub: ReturnType<typeof fakeKvApi>) =>
  reapProbeClient({ fetchImpl: stub.fetchImpl, base: "https://kv.example/ns", key: "client:probe123", auth: { Authorization: "Bearer t" } });

test("a key that existed is reported as DELETED, and the read came first", async () => {
  const stub = fakeKvApi({ present: true });
  const result = await run(stub);
  assert.equal(result.outcome, "deleted");
  assert.equal(stub.isPresent(), false, "the key was not actually removed");
  // A GET before the DELETE is the only thing that tells this case apart from the
  // next one.
  assert.deepEqual(
    stub.calls.map((c) => c.method),
    ["GET", "DELETE", "GET"],
    "the reaper did not read before deleting"
  );
  assert.equal(reportFor(result.outcome, "client:probe123").ok, true);
});

test("a key that was ALREADY GONE is reported distinctly, and fails the job", async () => {
  // Same final state as above, same 200 from DELETE, same 404 on read-back. Only the
  // pre-read separates them.
  const stub = fakeKvApi({ present: false });
  const result = await run(stub);
  assert.equal(result.outcome, "already-absent", "an absent key was reported as a successful delete");
  const report = reportFor(result.outcome, "client:probe123");
  assert.equal(report.ok, false, "a vanished record did not fail the job");
  assert.match(report.message, /ALREADY ABSENT/);
  // The message names both explanations.
  assert.match(report.message, /vanished-client-record anomaly of 2026-08-17/);
  assert.match(report.message, /wrong KV namespace/);
  // And it must not claim this run removed something it created.
  assert.doesNotMatch(report.message, /^reap: read .* deleted it/);
});

test("the two outcomes are genuinely different, given identical API responses", async () => {
  // The DELETE and the read-back are identical between the two runs.
  const existed = fakeKvApi({ present: true });
  const vanished = fakeKvApi({ present: false });
  const a = await run(existed);
  const b = await run(vanished);
  assert.notEqual(a.outcome, b.outcome, "the reaper cannot distinguish data loss from a normal delete");
  assert.deepEqual(
    existed.calls.map((c) => c.method),
    vanished.calls.map((c) => c.method),
    "the two runs should differ in what they CONCLUDE, not in what they call"
  );
  assert.equal(existed.isPresent(), false);
  assert.equal(vanished.isPresent(), false);
});

test("an unreadable key is NOT reported as data loss", async () => {
  // A bad token or a KV outage says nothing about whether the record exists.
  const stub = fakeKvApi({ present: true, failReadWith: 401 });
  const result = await run(stub);
  assert.equal(result.outcome, "unreadable");
  assert.equal(result.status, 401);
  const report = reportFor(result.outcome, "client:probe123");
  assert.equal(report.ok, false);
  assert.match(report.message, /NOT evidence of data loss/);
  // Nothing was deleted, because nothing was known.
  assert.deepEqual(stub.calls.map((c) => c.method), ["GET"], "the reaper deleted a key it could not read");
  assert.equal(stub.isPresent(), true);
});

test("the delete is still issued when the pre-read 404s, so a read blip cannot leak the key", async () => {
  // If the 404 was itself a blip, skipping the delete would leave the probe client
  // behind.
  const stub = fakeKvApi({ present: false });
  await run(stub);
  assert.equal(stub.calls.filter((c) => c.method === "DELETE").length, 1, "the delete was skipped on an absent pre-read");
});

test("a failed delete is not reported as gone", async () => {
  const stub = fakeKvApi({ present: true, failDeleteWith: 500 });
  const result = await run(stub);
  assert.equal(result.outcome, "delete-failed");
  assert.equal(reportFor(result.outcome, "k").ok, false);
  assert.equal(stub.isPresent(), true);
});

test("a key that still reads back after a 2xx delete is logged, and does not fail the job", async () => {
  // KV is eventually consistent, so the read straight after a delete can still see
  // the value. The 2xx DELETE is taken as done; the read-back is reported, not
  // failed on.
  const stub = fakeKvApi({ present: true, deleteReally: false });
  const result = await run(stub);
  assert.equal(result.outcome, "still-present");
  const report = reportFor(result.outcome, "k");
  assert.equal(report.ok, true, "an eventually consistent read-back failed the job");
  assert.match(report.message, /still read back/);
  assert.match(report.message, /eventual consistency/);
});
