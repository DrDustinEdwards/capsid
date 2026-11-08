import assert from "node:assert/strict";
import { test } from "node:test";
import { offaccountDispatchTick } from "../src/offaccount-dispatch.ts";
import { fakeEnv, fakeKv, withFetch, type Route } from "./fakes.ts";

// The nightly Amazon copy's fallback start (src/offaccount-dispatch.ts): GitHub's schedule
// can be hours late, so the tick starts the workflow itself, once a day, and never twice. A
// daily probe asks for a branch that does not exist: GitHub answers 422 to an App that may
// dispatch and 403 to one that may not, and starts nothing.

const RUNS = "GET /repos/DrDustinEdwards/capsid-backups/actions/workflows/offaccount.yml/runs";
const DISPATCH =
  "POST /repos/DrDustinEdwards/capsid-backups/actions/workflows/offaccount.yml/dispatches";
const LATE = new Date("2026-11-08T11:30:00.000Z");

const PROBE_REF = "permission-probe-no-such-ref";
// The dispatch endpoint as GitHub answers it: the probe's missing branch is a 422 for an App
// allowed to dispatch, a real branch starts a run, and a forbidding answer is every call's.
const dispatch =
  (real: number, probe = 422): Route =>
  (body) => ({ status: (body as { ref?: string }).ref === PROBE_REF ? probe : real });

function setup() {
  const kv = fakeKv({ seedToken: true });
  return { kv, env: fakeEnv({ APP_KV: kv.kv }) };
}

test("starts the copy once when no run exists today, and not before 11:25", async () => {
  const { env } = setup();
  await withFetch(
    { [RUNS]: { body: { total_count: 0 } }, [DISPATCH]: dispatch(204) },
    async (calls) => {
      const early = await offaccountDispatchTick(env, new Date("2026-11-08T11:20:00.000Z"));
      assert.equal(early.ran && early.ok, true, "the probe passes, nothing is started");
      assert.equal(calls.filter((c) => (c.body as { ref?: string })?.ref === "master").length, 0);
      const report = await offaccountDispatchTick(env, LATE);
      assert.equal(report.ran && report.ok, true);
      assert.equal(calls.filter((c) => (c.body as { ref?: string })?.ref === "master").length, 1);
      const again = await offaccountDispatchTick(env, new Date("2026-11-08T11:35:00.000Z"));
      assert.deepEqual(again, { ran: false });
      assert.equal(calls.filter((c) => c.method === "POST").length, 2, "one probe, one start");
    },
  );
});

test("leaves the copy alone when the schedule or a person already started it today", async () => {
  const { env } = setup();
  await withFetch(
    { [RUNS]: { body: { total_count: 1 } }, [DISPATCH]: dispatch(204) },
    async (calls) => {
      const report = await offaccountDispatchTick(env, LATE);
      assert.equal(report.ran && report.ok, true);
      assert.equal(calls.filter((c) => (c.body as { ref?: string })?.ref === "master").length, 0);
    },
  );
});

test("a forbidden dispatch is a failure the ledger shows, tried again an hour later, not at once", async () => {
  const { kv, env } = setup();
  await withFetch(
    { [RUNS]: { body: { total_count: 0 } }, [DISPATCH]: dispatch(403, 403) },
    async (calls) => {
      const report = await offaccountDispatchTick(env, LATE);
      assert.equal(report.ran && !report.ok, true);
      assert.match(report.ran ? report.note : "", /may not dispatch.*403/);
      assert.equal(kv.puts.find((p) => p.key === "offaccount-dispatch:probe-retry")?.ttl, 3600);
      // The probe waits an hour; the copy itself is still tried, and its refusal waits an hour too.
      const next = await offaccountDispatchTick(env, new Date("2026-11-08T11:35:00.000Z"));
      assert.equal(next.ran && !next.ok, true);
      assert.match(next.ran ? next.note : "", /dispatching.*refused.*403/);
      assert.deepEqual(await offaccountDispatchTick(env, new Date("2026-11-08T11:40:00.000Z")), {
        ran: false,
      });
      assert.equal(calls.filter((c) => c.method === "POST").length, 2);
    },
  );
});
