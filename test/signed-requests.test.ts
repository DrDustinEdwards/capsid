import assert from "node:assert/strict";
import { test } from "node:test";
import { claimJti, MAX_REPORT_BYTES, readBoundedText } from "../src/signed-requests.ts";
import { fakeD1 } from "./fakes.ts";

// The shared pieces of the signed endpoints (/backup/credential and /bench/*): the
// bounded body read and the jti replay cache.

test("readBoundedText refuses a body over the cap before it is fully buffered", async () => {
  const oversized = "x".repeat(MAX_REPORT_BYTES + 100);
  const stream = new Response(oversized).body;
  const result = await readBoundedText({ body: stream }, MAX_REPORT_BYTES);
  assert.equal(result.ok, false);
});

test("readBoundedText returns the body when it is under the cap", async () => {
  const body = JSON.stringify({ jti: "0123456789", site: "capsid" });
  const stream = new Response(body).body;
  const result = await readBoundedText({ body: stream }, MAX_REPORT_BYTES);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.text, body);
});

// The replay cache is an INSERT against a PRIMARY KEY, so the database decides who
// claimed a nonce. The concurrency property is driven against a real D1 in
// test-integration/scheduled.test.ts.
test("claimJti admits a nonce once, then refuses the replay", async () => {
  const d1 = fakeD1({});
  const first = await claimJti(d1.db, "backup", "nonce-abc");
  assert.equal(first.ok, true);
  const replay = await claimJti(d1.db, "backup", "nonce-abc");
  assert.equal(replay.ok, false);
  assert.equal(replay.ok === false && replay.status, 409);
  // A different nonce, or the same nonce in another scope, is not a replay.
  assert.equal((await claimJti(d1.db, "backup", "nonce-xyz")).ok, true);
  assert.equal((await claimJti(d1.db, "bench:capsid", "nonce-abc")).ok, true);
});

test("claimJti FAILS CLOSED when the database cannot be reached", async () => {
  const broken = {
    prepare: () => ({ bind: () => ({ all: async () => { throw new Error("unavailable"); } }) }),
  } as unknown as D1Database;
  const verdict = await claimJti(broken, "backup", "nonce-abc");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.status, 503);
});
