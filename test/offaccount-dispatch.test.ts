import assert from "node:assert/strict";
import { test } from "node:test";
import { offaccountDispatchTick } from "../src/offaccount-dispatch.ts";
import { fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// The nightly Amazon copy's fallback start (src/offaccount-dispatch.ts): GitHub's schedule
// can be hours late, so the tick starts the workflow itself, once a day, and never twice.

const RUNS = "GET /repos/DrDustinEdwards/capsid-backups/actions/workflows/offaccount.yml/runs";
const DISPATCH =
  "POST /repos/DrDustinEdwards/capsid-backups/actions/workflows/offaccount.yml/dispatches";
const LATE = new Date("2026-11-08T11:30:00.000Z");

function setup() {
  const kv = fakeKv({ seedToken: true });
  return { kv, env: fakeEnv({ APP_KV: kv.kv }) };
}

test("starts the copy once when no run exists today, and not before 11:25", async () => {
  const { env } = setup();
  await withFetch(
    { [RUNS]: { body: { total_count: 0 } }, [DISPATCH]: { status: 204 } },
    async (calls) => {
      assert.deepEqual(await offaccountDispatchTick(env, new Date("2026-11-08T11:20:00.000Z")), {
        ran: false,
      });
      assert.equal(calls.length, 0, "before 11:25 nothing is asked of GitHub");
      const report = await offaccountDispatchTick(env, LATE);
      assert.equal(report.ran && report.ok, true);
      assert.deepEqual(calls.find((c) => c.method === "POST")?.body, { ref: "master" });
      const again = await offaccountDispatchTick(env, new Date("2026-11-08T11:35:00.000Z"));
      assert.deepEqual(again, { ran: false });
      assert.equal(calls.filter((c) => c.method === "POST").length, 1);
    },
  );
});

test("leaves the copy alone when the schedule or a person already started it today", async () => {
  const { env } = setup();
  await withFetch({ [RUNS]: { body: { total_count: 1 } } }, async (calls) => {
    const report = await offaccountDispatchTick(env, LATE);
    assert.equal(report.ran && report.ok, true);
    assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  });
});

test("a refused dispatch is recorded as a failure and tried again an hour later, not at once", async () => {
  const { kv, env } = setup();
  await withFetch(
    { [RUNS]: { body: { total_count: 0 } }, [DISPATCH]: { status: 403 } },
    async (calls) => {
      const report = await offaccountDispatchTick(env, LATE);
      assert.equal(report.ran && !report.ok, true);
      assert.match(report.ran ? report.note : "", /403/);
      assert.deepEqual(await offaccountDispatchTick(env, new Date("2026-11-08T11:35:00.000Z")), {
        ran: false,
      });
      assert.equal(calls.filter((c) => c.method === "POST").length, 1);
      assert.equal(kv.puts.find((p) => p.key === "offaccount-dispatch:retry")?.ttl, 3600);
    },
  );
});
