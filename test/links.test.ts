import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_NAMESPACE } from "../src/limits.ts";
import { parseLinks } from "../src/links.ts";

test("parseLinks accepts an edge, defaults to_ns to the source namespace, and reads [] as clear", () => {
  assert.deepEqual(parseLinks('[{"type":"references","to_path":"decisions.md"}]', "capsid"), {
    edges: [{ type: "references", to_ns: "capsid", to_path: "decisions.md" }],
  });
  assert.deepEqual(
    parseLinks('[{"type":"governs","to_path":"core.md","to_ns":"sample"}]', "capsid"),
    {
      edges: [{ type: "governs", to_ns: "sample", to_path: "core.md" }],
    },
  );
  assert.deepEqual(parseLinks("[]", "capsid"), { edges: [] });
});

test("parseLinks rejects a non-array, an unknown type, a missing to_path and invalid JSON", () => {
  const cases: Array<[string, RegExp]> = [
    ['{"type":"references","to_path":"x"}', /must be a JSON array/],
    ['[{"type":"mentions","to_path":"x"}]', /type in governs/],
    ['[{"type":"references"}]', /to_path/],
    ["{not json", /invalid links JSON/],
  ];
  for (const [raw, expected] of cases) {
    const result = parseLinks(raw, "capsid");
    assert.ok("error" in result, `${raw} was accepted`);
    assert.match(result.error, expected);
  }
});

test("an edge endpoint is held to the document path grammar", () => {
  // The grammar itself is test/limits.test.ts.
  const result = parseLinks(
    JSON.stringify([{ type: "references", to_path: "../escape.md" }]),
    "capsid",
  );
  assert.ok("error" in result);
  assert.match(result.error, /is not a document path.*must not contain '\.\.'/s);
});

test("an edge namespace is held to the SAME namespace rule the tools use", () => {
  // That rule is nsName, which bounds length only. This asserts what it does, so it
  // keeps passing if nsName is tightened and fails if it is dropped.
  const tooLong = "n".repeat(MAX_NAMESPACE + 1);
  const result = parseLinks(
    JSON.stringify([{ type: "references", to_path: "core.md", to_ns: tooLong }]),
    "capsid",
  );
  assert.ok("error" in result, "an unbounded namespace was accepted on an edge");
  assert.match(result.error, /is not a namespace name/);
});
