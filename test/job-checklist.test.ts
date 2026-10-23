import assert from "node:assert/strict";
import { test } from "node:test";
import { checklistItems, checklistWarning, unchangedItems } from "../src/job-checklist.ts";

// The DONE WHEN checklist: which items name a path, and which of those no pull request changed.

const BODY = [
  "GOAL: fix it.",
  "DO:",
  "1. Edit things; changes `src/not-done-when.ts`",
  "DONE WHEN:",
  "1. The breaker skips run keys: changes `src/job-breaker.ts`",
  "2) Docs say so (changes `docs/`), and `npm test` passes",
  "3. Nobody is paged",
  "```",
  "4. changes `src/in-a-fence.ts`",
  "```",
  "RULES: none.",
  "5. changes `src/after.ts`",
].join("\n");

test("only DONE WHEN's numbered items count, and only the paths they say they change", () => {
  assert.deepEqual(checklistItems(BODY), [
    { n: 1, paths: ["src/job-breaker.ts"] },
    { n: 2, paths: ["docs/"] },
    { n: 3, paths: [] },
  ]);
  assert.deepEqual(unchangedItems(checklistItems(BODY), ["docs/work-queue.md"]), ["DONE WHEN item 1 changes `src/job-breaker.ts`"]);
  assert.equal(checklistWarning(BODY), null);
  assert.match(checklistWarning(`DONE WHEN:\n${Array.from({ length: 11 }, (_, i) => `${i + 1}. x`).join("\n")}`) ?? "", /11 numbered items/);
});
