import assert from "node:assert/strict";
import { test } from "node:test";
import { mapLimit } from "../src/map-limit";

test("mapLimit keeps the items' order and never runs more than the limit at once", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([30, 5, 20, 1, 10], 2, async (ms, i) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, ms));
    running--;
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
});
