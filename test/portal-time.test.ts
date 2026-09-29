import assert from "node:assert/strict";
import { test } from "node:test";

// Capsid Portal's relative times (dashboard/src/lib/format.ts), in a browser time zone
// behind UTC. Reported 2026-09-29: the newest Activity rows read "in 16s" and "in 8s"
// for actions that had just happened.
//
// Two causes, each reproduced here before it was fixed:
// - The app compared server timestamps with its own clock, ticked every 15 s. A row
//   written after the last tick, or on a server whose clock is ahead of the browser's,
//   is in the future of that clock.
// - A zone-less D1 timestamp ("YYYY-MM-DD HH:MM:SS") handed to Date.parse is read as
//   local time. Behind UTC that puts it hours in the future.
process.env.TZ = "America/Chicago";
const { ago, ms, portalNow } = await import("../dashboard/src/lib/format.ts");

test("the test really runs behind UTC, so the zone-less cases below mean something", () => {
  assert.notEqual(Date.parse("2026-09-29T13:00:00"), Date.parse("2026-09-29T13:00:00Z"), "TZ did not take effect");
});

test("PLANT: a zone-less server timestamp is read as UTC, in either spelling D1 writes", () => {
  const utc = Date.parse("2026-09-29T13:00:00Z");
  assert.equal(ms("2026-09-29 13:00:00"), utc);
  assert.equal(ms("2026-09-29T13:00:00"), utc);
  assert.equal(ms("2026-09-29T13:00:00.250"), utc + 250);
  // Anything with a zone is left to Date.parse.
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
  // Measured against the browser's tick alone, the same row is 29 s in the future.
  assert.equal(ago(row, tickedAt), "in 29s");
});

test("the Portal's now is the server's clock, and never earlier than the newest server read", () => {
  assert.equal(portalNow(1_000, 500, 0), 1_500);
  assert.equal(portalNow(1_000, 500, 9_000), 9_000);
  assert.equal(portalNow(1_000, -500, 0), 500);
});
