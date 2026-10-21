import assert from "node:assert/strict";
import { test } from "node:test";
import { RATE_FLOOR, TOOL_RATE_FLOOR, anomalyFindings, chicagoHour, readToolHours, toolRateFindings, type ActionHour, type ToolHour } from "../src/anomaly.ts";
import { owningCheck } from "../src/watcher-checks.ts";

// The anomaly rules (OWASP item 6), each on its own planted case, and the quiet cases
// that must stay quiet. Sample actors only.

const NOW = new Date("2026-10-10T18:00:00.000Z");
const hour = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString().slice(0, 13);

// A steady driver: claim, read and write, a few rows an hour, every day for 14 days.
function steady(actor: string): ActionHour[] {
  const out: ActionHour[] = [];
  for (let h = 30; h < 14 * 24; h += 6) for (const action of ["jobs-claimed", "read", "write"]) out.push({ actor, action, hour: hour(h), n: 3 });
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

// ---- the tool-use rate rule (session_events, on its own series) ----------------------

// A steady tool baseline: 100 calls an hour, every sixth hour, 14 days.
function steadyTools(actor: string): ToolHour[] {
  const out: ToolHour[] = [];
  for (let h = 30; h < 14 * 24; h += 6) out.push({ actor, hour: hour(h), n: 100 });
  return out;
}

test("PLANT: a tool-call hour over the floor and over three times the baseline is a finding, owned by the tool anomaly check", () => {
  const rows = [...steadyTools("agent:sample-driver"), { actor: "agent:sample-driver", hour: hour(1), n: TOOL_RATE_FLOOR }];
  const found = toolRateFindings(rows, NOW);
  assert.deepEqual(found.map((f) => f.fingerprint), ["anomaly-tool-rate-sample-driver"]);
  assert.match(found[0].title, /made 600 tool calls in one hour, over 3 times its busiest/);
  // Its own check, so a failed tool read never holds the audit findings open, or the reverse.
  assert.equal(owningCheck(found[0].fingerprint), "tool anomalies");
  assert.equal(owningCheck("anomaly-rate-sample-driver"), "agent anomalies");
  // An ordinary busy hour, the baseline's own size, is quiet.
  assert.deepEqual(toolRateFindings([...steadyTools("agent:sample-driver"), { actor: "agent:sample-driver", hour: hour(1), n: 100 }], NOW), []);
  // Over the factor but exactly at three times is not over it.
  assert.deepEqual(toolRateFindings([{ actor: "agent:sample-driver", hour: hour(100), n: 200 }, { actor: "agent:sample-driver", hour: hour(1), n: 600 }], NOW), []);
});

test("a tool-call spike under the floor is quiet, and so is an agent with no tool baseline", () => {
  const under = [{ actor: "agent:sample-quiet", hour: hour(100), n: 10 }, { actor: "agent:sample-quiet", hour: hour(1), n: TOOL_RATE_FLOOR - 1 }];
  assert.deepEqual(toolRateFindings(under, NOW), []);
  // The first day of tool reporting: rows only in the last day, however many.
  assert.deepEqual(toolRateFindings([{ actor: "agent:sample-new", hour: hour(1), n: 5000 }], NOW), []);
});

test("readToolHours reads tool events only, from the ISO window start, the watcher left out", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({ all: async () => (calls.push({ sql, params }), { results: [{ actor: "agent:x", hour: "2026-10-10T17", n: 2 }] }) }),
    }),
  } as unknown as D1Database;
  const rows = await readToolHours(db, NOW, "agent:capsid-watcher");
  assert.equal(rows.length, 1);
  assert.match(calls[0].sql, /event IN \('PostToolUse', 'PostToolUseFailure'\)/);
  assert.deepEqual(calls[0].params, ["2026-09-25T18:00:00.000Z", "agent:capsid-watcher"]);
});
