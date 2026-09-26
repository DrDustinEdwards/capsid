import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";

// The canary for the test script itself. A test script that enumerates files by hand
// silently skips a file not on the list, and every other guard in this repo is
// verified by this suite. This asserts the script is still a glob.
test("package.json runs the test suite by glob, not by an enumerated list", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts.test;
  assert.match(script, /test\/\*\.test\.ts/, "the test script no longer uses a glob, so a new test file can be skipped");
  // No enumeration alongside the glob, which would run files twice and hide a
  // regression. [\w.-]+ so a name with digits and dashes is caught as well.
  const enumerated = script.match(/test\/[\w.-]+\.test\.ts/g) ?? [];
  assert.deepEqual(
    enumerated,
    [],
    `the test script names individual files again: ${enumerated.join(", ")}. A file not on that list runs nowhere.`
  );
});
