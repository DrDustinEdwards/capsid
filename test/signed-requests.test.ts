import assert from "node:assert/strict";
import { test } from "node:test";
import { claimJti, MAX_REPORT_BYTES, readBoundedText } from "../src/signed-requests.ts";
import { fakeD1 } from "./fakes.ts";

test("readBoundedText refuses a body over the cap before it is fully buffered", async () => {
  const oversized = "x".repeat(MAX_REPORT_BYTES + 100);
  const stream = new Response(oversized).body;
  const result = await readBoundedText({ body: stream }, MAX_REPORT_BYTES);
  assert.equal(result.ok, false);
});

// The replay cache is an INSERT against a PRIMARY KEY, so the database decides who claimed a nonce; the concurrency
// property runs against real D1 in test-integration/scheduled.test.ts.
test("claimJti admits a nonce once, then refuses the replay", async () => {
  const d1 = fakeD1({});
  const first = await claimJti(d1.db, "backup", "nonce-abc");
  assert.equal(first.ok, true);
  const replay = await claimJti(d1.db, "backup", "nonce-abc");
  assert.equal(replay.ok, false);
  assert.equal(replay.ok === false && replay.status, 409);
  assert.equal((await claimJti(d1.db, "backup", "nonce-xyz")).ok, true);
  assert.equal((await claimJti(d1.db, "bench:capsid", "nonce-abc")).ok, true);
});

test("claimJti FAILS CLOSED when the database cannot be reached", async () => {
  const broken = {
    prepare: () => ({
      bind: () => ({
        all: async () => {
          throw new Error("unavailable");
        },
      }),
    }),
  } as unknown as D1Database;
  const verdict = await claimJti(broken, "backup", "nonce-abc");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.status, 503);
});
