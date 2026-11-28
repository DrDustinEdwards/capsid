import assert from "node:assert/strict";
import { test } from "node:test";
import { ciVerdict, jobIdFromBody } from "../src/github/pr-files.ts";

test("jobIdFromBody finds the id in prose and refuses a malformed one", () => {
  assert.equal(jobIdFromBody("Closes job_4c0ecc28548b."), "job_4c0ecc28548b");
  assert.equal(jobIdFromBody("job_4c0ecc28548"), null, "eleven hex digits is not a job id");
  assert.equal(jobIdFromBody(""), null);
});

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
