import assert from "node:assert/strict";
import { test } from "node:test";
import { backupSlots, ciDays, costWeeks, isoWeek, lastDays, mondayOf, sessionMinutes, timeMs, weekStarts } from "../src/trends.ts";

// The counting rules behind GET /portal/api/trends, on plain values. The SQL runs against
// a real D1 in test-integration/portal-trends.test.ts.

const NOW = new Date("2026-10-11T04:30:00.000Z"); // a Sunday
const at = (s: string) => timeMs(s);

test("weeks start on Monday and carry their ISO label, across a year's end", () => {
  assert.equal(mondayOf("2026-10-11"), "2026-10-05");
  assert.equal(mondayOf("2026-10-05"), "2026-10-05");
  assert.equal(isoWeek("2026-10-05"), "2026-W41");
  // 2026-12-28 is the Monday of 2026-W53; 2027-01-04 begins 2027-W01.
  assert.equal(isoWeek("2026-12-28"), "2026-W53");
  assert.equal(isoWeek("2027-01-04"), "2027-W01");
  assert.deepEqual(weekStarts(NOW, 3), ["2026-09-21", "2026-09-28", "2026-10-05"]);
  assert.deepEqual(lastDays(NOW, 3), ["2026-10-09", "2026-10-10", "2026-10-11"]);
});

test("both stored time formats are read as UTC", () => {
  assert.equal(timeMs("2026-10-05 09:00:00"), Date.parse("2026-10-05T09:00:00Z"));
  assert.equal(timeMs("2026-10-05T09:00:00.000Z"), Date.parse("2026-10-05T09:00:00Z"));
});

test("PLANT: a session ends after a gap over five minutes, and counts its span plus one minute", () => {
  const weeks = sessionMinutes(
    [
      // One session, 09:00 to 09:09 (gaps of 4 and 5 minutes): 9 + 1 = 10 minutes.
      at("2026-10-05 09:00:00"),
      at("2026-10-05 09:04:00"),
      at("2026-10-05 09:09:00"),
      // A gap of 6 minutes: a second session of one click, 1 minute.
      at("2026-10-05 09:15:00"),
      // The week before: one click.
      at("2026-09-30 12:00:00"),
      // Before the window: not counted.
      at("2026-09-01 12:00:00"),
    ],
    ["2026-09-28", "2026-10-05"]
  );
  assert.deepEqual(weeks.get("2026-10-05"), { minutes: 11, sessions: 2 });
  assert.deepEqual(weeks.get("2026-09-28"), { minutes: 1, sessions: 1 });
});

test("PLANT: a CI day is the last completed run's verdict, carried over days with none", () => {
  const days = ["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"];
  const run = (created_at: string, conclusion: string | null, status = "completed") => ({ created_at, conclusion, status });
  const out = ciDays(
    [
      run("2026-10-09T08:00:00Z", "success"),
      run("2026-10-09T10:00:00Z", "failure"),
      // Canceled and still running decide nothing.
      run("2026-10-09T11:00:00Z", "cancelled"),
      run("2026-10-11T03:00:00Z", null, "in_progress"),
      run("2026-10-11T02:00:00Z", "success"),
    ],
    days
  );
  assert.deepEqual(
    out.map((d) => [d.day, d.state, d.runs, d.failed]),
    [
      ["2026-10-08", "none", 0, 0],
      ["2026-10-09", "red", 2, 1],
      ["2026-10-10", "red", 0, 0],
      ["2026-10-11", "green", 1, 0],
    ]
  );
});

test("PLANT: a green run of one workflow does not hide another workflow that is red", () => {
  const days = ["2026-10-09", "2026-10-10"];
  const run = (created_at: string, conclusion: string, workflow_id: number) => ({ created_at, conclusion, status: "completed", workflow_id });
  const out = ciDays(
    [
      run("2026-10-09T08:00:00Z", "failure", 1),
      // A later green run of another workflow: workflow 1 is still red.
      run("2026-10-09T09:00:00Z", "success", 2),
      run("2026-10-10T08:00:00Z", "success", 1),
    ],
    days
  );
  assert.deepEqual(
    out.map((d) => [d.day, d.state]),
    [
      ["2026-10-09", "red"],
      ["2026-10-10", "green"],
    ]
  );
});

test("PLANT: a backup slot is filled only by a complete run inside it", () => {
  const slots = backupSlots(["2026-10-11T03-10-00-000Z", "2026-10-09T03-10-00-000Z", "2026-08-01T03-10-00-000Z"], NOW);
  assert.equal(slots.daily.length, 14);
  assert.equal(slots.weekly.length, 8);
  assert.equal(slots.monthly.length, 6);
  const filled = (list: Array<{ key: string; filled: boolean }>) => list.filter((s) => s.filled).map((s) => s.key);
  assert.deepEqual(filled(slots.daily), ["2026-10-09", "2026-10-11"]);
  assert.deepEqual(filled(slots.weekly), ["2026-10-05"]);
  assert.deepEqual(filled(slots.monthly), ["2026-08", "2026-10"]);
  assert.equal(slots.monthly[0]!.key, "2026-05");
});

test("PLANT: a week's cost sums its costed outcomes, and a week with none is null, not zero", () => {
  const weeks = weekStarts(NOW, 3);
  const out = costWeeks(
    [
      { day: "2026-10-05", usd: 1.25, n: 2 },
      { day: "2026-10-09", usd: 0.5, n: 1 },
      { day: "2026-09-22", usd: 3.333, n: 1 },
      // Before the window: not counted.
      { day: "2026-09-01", usd: 9, n: 1 },
    ],
    weeks
  );
  assert.deepEqual(
    out.map((w) => [w.week, w.usd, w.jobs]),
    [
      ["2026-W39", 3.33, 1],
      ["2026-W40", null, 0],
      ["2026-W41", 1.75, 3],
    ]
  );
});
