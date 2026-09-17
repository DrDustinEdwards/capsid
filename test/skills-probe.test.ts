import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runEvaluationCycle } from "../src/skills-evaluate.ts";
import { fakeD1, fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// A SKILL'S STATUS CANNOT CHANGE, AND THESE ARE THE TWO REASONS WHY.
//
// job_513843de1e96 found that no skill can ever leave `candidate`, with the improve
// loop on or off. Status moves only through commitTransition, which runs only when
// two skill_evaluations rows exist at the skill's current version, and two things
// stop those rows ever existing:
//
//   1. The evaluation cycle dispatches improve-score.yml with `mode`, `skill_id` and
//      `skill_version`. That workflow declares none of them and REQUIRES `branch`,
//      `run_id` and `attempt_id`, which the cycle does not send. GitHub rejects such
//      a dispatch outright; the cycle catches the error and logs it.
//   2. Nothing writes skill_evaluations. evaluationStatement is the only writer and
//      has no production caller.
//
// Neither has ever been observed, because no skill has ever existed to run the
// cycle over. That is why these drive the cycle with one candidate skill rather
// than asserting that the pieces exist.

const WORKFLOW = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "improve-score.yml"), "utf8");

interface DeclaredInput {
  name: string;
  required: boolean;
}

// The workflow_dispatch inputs, read by indentation to match how the other workflow
// guards in this suite read YAML: no dependency, and the shape checked is the shape a
// reader sees.
function declaredInputs(text: string): DeclaredInput[] {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const start = lines.findIndex((l) => /^ {4}inputs:\s*$/.test(l));
  if (start === -1) return [];
  const out: DeclaredInput[] = [];
  let current: DeclaredInput | null = null;
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,4}\S/.test(line)) break;
    const name = /^ {6}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (name) {
      current = { name: name[1], required: false };
      out.push(current);
      continue;
    }
    const req = /^ {8}required:\s*(true|false)\s*$/.exec(line);
    if (req && current) current.required = req[1] === "true";
  }
  return out;
}

const SKILL = {
  id: "sk-probe",
  status: "candidate",
  version: 1,
  source_namespace: "capsid",
  title: "a probe skill",
};

function harness() {
  const d1 = fakeD1({
    namespaces: [{ namespace: "capsid", repos: JSON.stringify([{ repo: "DrDustinEdwards/capsid-mcp", label: "primary" }]) }],
    improveSkills: [SKILL],
  });
  // No last-cycle stamp, so the cycle is due.
  const kv = fakeKv({ seed: {}, seedToken: true });
  const env = fakeEnv({
    DB: d1.db,
    APP_KV: kv.kv,
    GITHUB_APP_CLIENT_ID: "x",
    GITHUB_APP_PRIVATE_KEY: "x",
  });
  return { d1, env };
}

const ROUTES = {
  "GET /repos/DrDustinEdwards/capsid-mcp": { body: { default_branch: "master" } },
  "POST /repos/DrDustinEdwards/capsid-mcp/actions/workflows/improve-score.yml/dispatches": { status: 204 },
};

const NOW = new Date("2026-09-17T01:00:00Z");

test("the workflow's declared inputs are read at all, so the guard below cannot pass on nothing", () => {
  const inputs = declaredInputs(WORKFLOW);
  assert.ok(inputs.length >= 3, `only ${inputs.length} workflow_dispatch inputs parsed from improve-score.yml`);
  assert.ok(inputs.some((i) => i.required), "no required input parsed, so the required-input half of the guard would be vacuous");
});

test("THE EVALUATION CYCLE DISPATCHES ONLY INPUTS THE SCORER DECLARES, AND EVERY ONE IT REQUIRES", async () => {
  await withFetch(ROUTES, async (calls) => {
    const { env } = harness();
    await runEvaluationCycle(env, NOW);

    const dispatches = calls.filter((c) => c.method === "POST" && /\/dispatches$/.test(c.path));
    assert.equal(dispatches.length, 1, `expected one probe dispatch for one candidate skill, saw ${dispatches.length}`);

    const sent = Object.keys((dispatches[0].body as { inputs?: Record<string, string> }).inputs ?? {});
    const declared = declaredInputs(WORKFLOW);
    const names = new Set(declared.map((d) => d.name));

    const undeclared = sent.filter((s) => !names.has(s));
    const missingRequired = declared.filter((d) => d.required && !sent.includes(d.name)).map((d) => d.name);

    assert.deepEqual(
      { undeclared, missingRequired },
      { undeclared: [], missingRequired: [] },
      `the cycle sent ${JSON.stringify(sent)} to a workflow declaring ${JSON.stringify(declared)}. ` +
        "GitHub rejects a dispatch carrying an undeclared input or missing a required one, so no probe has ever run."
    );
  });
});

test("A COMPLETED EVALUATION RECORDS A skill_evaluations ROW", async () => {
  // Nothing produces this row today. evaluationStatement is the only writer and has no
  // production caller, so a probe that ran would still leave nothing behind for
  // dueTransitions to count.
  await withFetch(ROUTES, async () => {
    const { d1, env } = harness();
    await runEvaluationCycle(env, NOW);
    assert.ok(
      d1.rows.skill_evaluations.length > 0,
      "the cycle ran over a candidate skill and no skill_evaluations row exists, so its status can never change"
    );
  });
});
