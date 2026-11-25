import assert from "node:assert/strict";
import { test } from "node:test";

// Reported 2026-09-29: new Activity rows read "in 16s". Two causes: the app compared server timestamps with its own
// clock, and a zone-less D1 timestamp handed to Date.parse is read as local time, hours ahead behind UTC.
process.env.TZ = "America/Chicago";
const { ago } = await import("../dashboard/src/lib/format.ts");
const { parse: ms, serverNow: portalNow } = await import("capsomer/behavior/time");

test("the test really runs behind UTC, so the zone-less cases below mean something", () => {
  assert.notEqual(
    Date.parse("2026-09-29T13:00:00"),
    Date.parse("2026-09-29T13:00:00Z"),
    "TZ did not take effect",
  );
});

test("PLANT: a zone-less server timestamp is read as UTC, in either spelling D1 writes", () => {
  const utc = Date.parse("2026-09-29T13:00:00Z");
  assert.equal(ms("2026-09-29 13:00:00"), utc);
  assert.equal(ms("2026-09-29T13:00:00"), utc);
  assert.equal(ms("2026-09-29T13:00:00.250"), utc + 250);
  assert.equal(ms("2026-09-29T13:00:00Z"), utc);
  assert.equal(ms("2026-09-29T08:00:00-05:00"), utc);
});

test("PLANT: a row the server wrote just now never reads as in the future", () => {
  // The browser's clock is 20 s behind the server's, and the app last ticked 5 s after the feed arrived.
  const server = Date.parse("2026-09-29T13:00:30Z");
  const browserAtFeed = server - 20_000;
  const skew = server - browserAtFeed;
  const tickedAt = browserAtFeed + 5_000;
  const row = Date.parse("2026-09-29T13:00:44Z");
  const generated = Date.parse("2026-09-29T13:00:45Z");
  const now = portalNow(tickedAt, skew, generated);
  assert.equal(ago(row, now), "1s ago");
  assert.equal(ago(row, tickedAt), "in 29s");
});
