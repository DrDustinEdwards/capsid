import assert from "node:assert/strict";
import { test } from "node:test";
import { ciVerdict } from "../src/github/pr-files.ts";

test("ciVerdict calls no checks, pending checks and a failure all not-green", () => {
  const run = (status: string, conclusion: string | null) => ({ name: "c", status, conclusion });
  assert.equal(ciVerdict([]).conclusion, null);
  assert.equal(ciVerdict([run("in_progress", null)]).conclusion, "pending");
  assert.equal(ciVerdict([run("completed", "success")]).conclusion, "success");
  assert.equal(
    ciVerdict([run("completed", "success"), run("completed", "failure")]).conclusion,
    "failure",
  );
});
