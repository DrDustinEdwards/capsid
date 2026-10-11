import assert from "node:assert/strict";
import { test } from "node:test";
import { adminAgentForEmail, legacyAgent } from "../src/agents.ts";
import { editJob } from "../src/jobs-edit.ts";
import { missingPartsWarning, placeholderRefusal } from "../src/job-body-check.ts";
import { fakeEnv } from "./fakes.ts";

// job_9a8d13d2d926: post and edit refuse an unfilled placeholder and warn on a body
// missing the five headed parts. The tool-level wiring is asserted in the second half.

const FULL = ["GOAL: x", "DO:", "1. y", "OUT OF SCOPE: z", "DONE WHEN: w", "RULES: r"].join("\n");

for (const [name, text] of [
  ["<ID>", "Work job <ID> now"],
  ["<id>", "Work job <id> now"],
  ["<...>", "Run <...> now"],
  ["{{name}}", "Hello {{name}} there"],
  ["TODO:", "TODO: fill this"],
  ["TBD", "The owner is TBD"],
] as const) {
  test(`a body with ${name} unfilled is refused, naming it`, () => {
    const refusal = placeholderRefusal("body", `${FULL}\n${text}`);
    assert.ok(refusal, `${name} was accepted`);
    assert.ok(refusal.includes(name), refusal);
  });
}

test("a title is checked too", () => {
  assert.match(placeholderRefusal("title", "Fix <ID>") ?? "", /title/);
});

test("a placeholder in a code fence, an external fence or an inline span is accepted", () => {
  const body = [FULL, "```", "<ID> TODO: {{x}}", "```", "~~~external source=review ref=1", "TBD <id>", "~~~", "Use `<ID>` here."].join("\n");
  assert.equal(placeholderRefusal("body", body), null);
});

test("a fence does not hide a placeholder after it closes", () => {
  assert.ok(placeholderRefusal("body", "```\nx\n```\nTBD"));
});

test("a filled body passes, and words that merely contain TBD or TODO do not trip it", () => {
  assert.equal(placeholderRefusal("body", `${FULL}\nOUTBD and todo: lowercase are prose.`), null);
});

test("a body missing parts is warned about, naming each", () => {
  const warning = missingPartsWarning("GOAL: only this");
  assert.ok(warning);
  for (const part of ["DO", "OUT OF SCOPE", "DONE WHEN", "DECIDED or RULES"]) assert.ok(warning.includes(part), warning);
  assert.ok(!warning.split(". Posted")[0].includes("GOAL"), warning);
});

test("a body with all five parts, in either heading style, draws no warning", () => {
  assert.equal(missingPartsWarning(FULL), null);
  assert.equal(missingPartsWarning("## GOAL\n## DO\n**OUT OF SCOPE**\n## DONE WHEN\n## DECIDED"), null);
});

test("prose that starts with a part word is not a heading", () => {
  const warning = missingPartsWarning("DO NOT touch the schema\nGOALS are below\nDONE WHEN-ish");
  assert.ok(warning);
  assert.ok(warning.includes("GOAL") && warning.includes("DO,"), warning);
});

test("edit refuses a placeholder, but only after the caller is known to be the seat", async () => {
  const env = fakeEnv({ IMPROVE_SCORE_SECRET: "test-secret" });
  const now = new Date("2026-10-11T00:00:00Z");
  const seat = await editJob(env, adminAgentForEmail("admin@example.com"), now, "job_x", { body: "GOAL: do <ID>" });
  assert.equal(seat.ok, false);
  assert.match(seat.refusal ?? "", /placeholder, <ID>/);
  const driver = await editJob(env, legacyAgent("read", "agent:driver"), now, "job_x", { body: "GOAL: do <ID>" });
  assert.match(driver.refusal ?? "", /cannot edit a job/);
  const title = await editJob(env, adminAgentForEmail("admin@example.com"), now, "job_x", { title: "Fix TBD" });
  assert.match(title.refusal ?? "", /title has an unfilled placeholder, TBD/);
});
