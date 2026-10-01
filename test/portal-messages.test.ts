import assert from "node:assert/strict";
import { test } from "node:test";

// The Portal's message region (dashboard/src/lib/messages.ts; capsid/decisions.md
// 2026-09-30, "admin panels review adopted", item 3): a plain result is replaced by the
// next one, and a warning, a failed Undo or a failure stays until dismissed.
const { lasting, withMessage } = await import("../dashboard/src/lib/messages.ts");
type Message = Parameters<typeof withMessage>[1];

let id = 0;
const msg = (over: Partial<Message>): Message => ({ id: ++id, text: "t", warning: null, undo: null, error: null, busy: false, failure: false, ...over });

test("a plain result is replaced by the next", () => {
  const first = msg({ text: "Paused sample." });
  const second = msg({ text: "Unpaused sample." });
  assert.deepEqual(withMessage(withMessage([], first), second), [second]);
});

test("PLANT: a result whose audit row was not written stays through every later result until dismissed", () => {
  const warned = msg({ text: "Paused sample.", warning: "the Portal audit row naming you was not written" });
  let region = withMessage([], warned);
  for (const text of ["Unpaused sample.", "Seat start is on.", "Seat start is off."]) region = withMessage(region, msg({ text }));
  assert.deepEqual(region.map((m) => m.text), ["Seat start is off.", "Paused sample."]);
  assert.equal(region[1]?.warning, "the Portal audit row naming you was not written");
});

test("PLANT: a failure and a failed Undo stay; the newest is first", () => {
  const failed = msg({ text: "Refresh failed: the watcher pass failed (HTTP 500)", failure: true });
  const undoFailed = msg({ text: "Seat start is on.", error: "Undo was refused: changed since" });
  const region = withMessage(withMessage(withMessage([], failed), undoFailed), msg({ text: "Copied" }));
  assert.deepEqual(region.map((m) => m.text), ["Copied", "Seat start is on.", "Refresh failed: the watcher pass failed (HTTP 500)"]);
});

test("lasting is exactly a warning, an error or a failure", () => {
  assert.equal(lasting(msg({})), false);
  assert.equal(lasting(msg({ warning: "w" })), true);
  assert.equal(lasting(msg({ error: "e" })), true);
  assert.equal(lasting(msg({ failure: true })), true);
});
