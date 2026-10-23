import assert from "node:assert/strict";
import { test } from "node:test";
import { weakenedTests } from "../src/test-protection.ts";

// Narrow test protection: what a pull request takes away from its tests.

const mod = (filename: string, patch: string) => ({ filename, status: "modified", additions: 1, deletions: 1, patch });

test("a removed test file, a removed or renamed test, and an added skip are each found", () => {
  const found = weakenedTests(
    [
      { filename: "test/gone.test.ts", status: "removed", deletions: 9 },
      { filename: "src/moved.ts", previous_filename: "tests/test_moved.py", status: "renamed" },
      mod("test/a.test.ts", `@@ -1,3 +1,3 @@\n-it("refuses a red run", () => {\n+it("refuses a run", () => {\n-it("waits", () => {\n+it.skip("waits", () => {`),
      mod("tests/test_b.py", `@@ -1 +1 @@\n-def test_parse():\n+@pytest.mark.skip\n+def test_parse():`),
      mod("pkg/x_test.go", `-func TestOld(t *testing.T) {`),
    ],
    ""
  );
  assert.deepEqual(found, [
    "removes the test file test/gone.test.ts",
    "removes the test file tests/test_moved.py",
    'adds a skip in test/a.test.ts: it.skip("waits", () => {',
    'removes or renames the test "refuses a red run" in test/a.test.ts',
    "adds a skip in tests/test_b.py: @pytest.mark.skip",
    'removes or renames the test "TestOld" in pkg/x_test.go',
  ]);
});

test("a test kept, a new test, a body edit and anything the job names pass", () => {
  const rows = [
    { filename: "test/new.test.ts", status: "added", additions: 5, deletions: 0 },
    mod("test/a.test.ts", `-  expect(x).toBe(1);\n+  expect(x).toBe(2);\n-it("keeps", () => {\n+it("keeps", () => {`),
    mod("src/a.ts", `-it("not a test file", () => {`),
    mod("test/d.test.ts", `+it.skip("a new case, not yet", () => {\n+@pytest.mark.skip\n+def test_new():`),
    { filename: "test/old.test.ts", status: "removed", deletions: 3 },
    mod("test/c.test.ts", `-it("obsolete case", () => {`),
  ];
  assert.deepEqual(weakenedTests(rows, 'Delete test/old.test.ts and the "obsolete case" test.'), []);
});
