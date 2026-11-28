import assert from "node:assert/strict";
import { test } from "node:test";
import { claimJti } from "../src/signed-requests.ts";

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
