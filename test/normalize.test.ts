import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDashes } from "../src/normalize.ts";

test("wide dashes become a comma in prose, a spaced hyphen in titles and headings, a hyphen in a range", () => {
  const cases: Array<[string, string, "title"?]> = [
    ["the shell — the capsid", "the shell, the capsid"],
    ["word—word", "word, word"],
    ["a ― b", "a, b"],
    ["a – b", "a, b"],
    ["capsid — core", "capsid - core", "title"],
    ["# capsid — core\nthe shell — the capsid", "# capsid - core\nthe shell, the capsid"],
    ["built 2014–2018 in total", "built 2014-2018 in total"],
    ["plain ascii text, with a comma", "plain ascii text, with a comma"],
  ];
  for (const [input, want, mode] of cases) assert.equal(normalizeDashes(input, mode), want, input);
});
