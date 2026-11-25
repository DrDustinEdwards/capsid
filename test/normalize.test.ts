import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDashes } from "../src/normalize.ts";

test("em dash, word-hugging em dash, horizontal bar and spaced en dash collapse to a comma-space", () => {
  for (const [input, want] of [
    ["the shell — the capsid", "the shell, the capsid"],
    ["word—word", "word, word"],
    ["a ― b", "a, b"],
    ["a – b", "a, b"],
  ]) {
    assert.equal(normalizeDashes(input), want, input);
  }
});

test("title mode uses a spaced hyphen", () => {
  assert.equal(normalizeDashes("capsid — core", "title"), "capsid - core");
});

test("markdown heading lines in a body use a spaced hyphen, prose uses a comma", () => {
  assert.equal(
    normalizeDashes("# capsid — core\nthe shell — the capsid"),
    "# capsid - core\nthe shell, the capsid",
  );
});

test("numeric en-dash range becomes a plain hyphen", () => {
  assert.equal(normalizeDashes("built 2014–2018 in total"), "built 2014-2018 in total");
});

test("text with no wide dashes is returned unchanged", () => {
  assert.equal(normalizeDashes("plain ascii text, with a comma"), "plain ascii text, with a comma");
});
