import assert from "node:assert/strict";
import { test } from "node:test";
import { RATE_FLOOR, anomalyFindings, chicagoHour, type ActionHour } from "../src/anomaly.ts";
import { owningCheck } from "../src/watcher.ts";

// The anomaly rules (OWASP item 6), each on its own planted case, and the quiet cases
// that must stay quiet. Sample actors only.

const NOW = new Date("2026-10-10T18:00:00.000Z");
const hour = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString().slice(0, 13);

// A steady driver: claim, heartbeat and write, a few rows an hour, every day for 14 days.
function steady(actor: string): ActionHour[] {
  const out: ActionHour[] = [];
  for (let h = 30; h < 14 * 24; h += 6) for (const action of ["jobs-claimed", "heartbeat", "write"]) out.push({ actor, action, hour: hour(h), n: 3 });
  return out;
}

test("an agent doing what it always does raises nothing, and the rows read are counted", () => {
  const rows = [...steady("agent:sample-driver"), { actor: "agent:sample-driver", action: "write", hour: hour(2), n: 4 }];
  assert.ok(rows.length > 100, "the baseline read is not empty, so the silence below means something");
  assert.deepEqual(anomalyFindings(rows, NOW), []);
});

test("PLANT: an action the agent never did in 14 days is a finding, owned by the anomaly check", () => {
  const rows = [...steady("agent:sample-driver"), { actor: "agent:sample-driver", action: "delete_namespace", hour: hour(3), n: 1 }];
  const found = anomalyFindings(rows, NOW);
  assert.deepEqual(found.map((f) => f.fingerprint), ["anomaly-new-action-sample-driver-delete-namespace"]);
  assert.equal(owningCheck(found[0].fingerprint), "agent anomalies");
  assert.match(found[0].body, /nothing was suspended or revoked/);
});

test("PLANT: a busiest hour over three times the baseline's, and over the floor, is a spike; under the floor it is not", () => {
  const spike = [...steady("agent:sample-driver"), { actor: "agent:sample-driver", action: "write", hour: hour(1), n: 40 }];
  assert.deepEqual(anomalyFindings(spike, NOW).map((f) => f.fingerprint), ["anomaly-rate-sample-driver"]);
  // A quiet agent (one row an hour) doubling to a handful is not a spike.
  const quiet: ActionHour[] = [{ actor: "agent:sample-quiet", action: "write", hour: hour(100), n: 1 }, { actor: "agent:sample-quiet", action: "write", hour: hour(1), n: RATE_FLOOR - 1 }];
  assert.deepEqual(anomalyFindings(quiet, NOW), []);
});

test("PLANT: a new key first used at 03:00 Chicago is a finding; one first used at noon is not", () => {
  // 2026-10-10 is CDT (UTC-5): 08:00Z is 03:00 Chicago, 17:00Z is noon.
  assert.equal(chicagoHour("2026-10-10T08"), 3);
  const night = anomalyFindings([{ actor: "agent:sample-new", action: "jobs-claimed", hour: "2026-10-10T08", n: 2 }], NOW);
  assert.deepEqual(night.map((f) => f.fingerprint), ["anomaly-first-use-sample-new"]);
  assert.deepEqual(anomalyFindings([{ actor: "agent:sample-new", action: "jobs-claimed", hour: "2026-10-10T17", n: 2 }], NOW), []);
});

test("activity older than the last day is baseline, never a finding of its own", () => {
  const rows = [...steady("agent:sample-driver"), { actor: "agent:sample-driver", action: "delete_namespace", hour: hour(30), n: 1 }];
  assert.deepEqual(anomalyFindings(rows, NOW), []);
});
