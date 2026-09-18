import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runEvaluationCycle } from "../src/skills-evaluate.ts";
import { tickRuns } from "../src/improve/tick.ts";
import { anchorChecksum, parseScoresDoc } from "../src/improve-scores.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2, withFetch } from "./fakes.ts";
import { seedScoresDoc } from "./seed-scores.ts";

// WHY NO SKILL'S STATUS COULD EVER CHANGE, AND WHAT WAS DONE ABOUT IT.
//
// job_513843de1e96 found that no skill can leave `candidate`, with the improve loop on
// or off. Status moves only through commitTransition, which needs two skill_evaluations
// rows at the skill's current version, and two things stopped those rows existing:
//
//   1. The evaluation cycle dispatched improve-score.yml with `mode`, `skill_id` and
//      `skill_version`. That workflow declares none of them and REQUIRES `branch`,
//      `run_id` and `attempt_id`, which the cycle never sent. GitHub rejects such a
//      dispatch outright; the cycle caught the error and logged it.
//   2. Nothing wrote skill_evaluations. evaluationStatement is the only writer and had
//      no production caller.
//
// The reproduction for both is preserved below, re-pointed at the answer Dustin ruled
// on 2026-09-16 (option C, capsid/decisions.md): SCHEDULED PROBING IS DROPPED. The
// broken dispatch is gone rather than repaired, because a working probe needs the
// loop's attempt path, model spend and a probe set that has never been defined.
// Evidence now comes from verified job outcomes and scored attempts.

const WORKFLOW = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "improve-score.yml"), "utf8");
const SCORES = seedScoresDoc("capsid");

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

/** Every complaint GitHub would make about one dispatch body. */
function inputProblems(sent: string[]): { undeclared: string[]; missingRequired: string[] } {
  const declared = declaredInputs(WORKFLOW);
  const names = new Set(declared.map((d) => d.name));
  return {
    undeclared: sent.filter((s) => !names.has(s)),
    missingRequired: declared.filter((d) => d.required && !sent.includes(d.name)).map((d) => d.name),
  };
}

const dispatchesIn = (calls: Array<{ method: string; path: string; body: unknown }>) =>
  calls.filter((c) => c.method === "POST" && /improve-score\.yml\/dispatches$/.test(c.path));

// ---- the cycle's own harness ----------------------------------------------------

const SKILL = {
  id: "sk-probe",
  status: "candidate",
  version: 1,
  source_namespace: "capsid",
  title: "a probe skill",
};

function cycleHarness() {
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

const CYCLE_ROUTES = {
  "GET /repos/DrDustinEdwards/capsid-mcp": { body: { default_branch: "master" } },
  "POST /repos/DrDustinEdwards/capsid-mcp/actions/workflows/improve-score.yml/dispatches": { status: 204 },
};

const NOW = new Date("2026-09-17T01:00:00Z");

test("the workflow's declared inputs are read at all, so the guards below cannot pass on nothing", () => {
  const inputs = declaredInputs(WORKFLOW);
  assert.ok(inputs.length >= 3, `only ${inputs.length} workflow_dispatch inputs parsed from improve-score.yml`);
  assert.ok(inputs.some((i) => i.required), "no required input parsed, so the required-input half of the guard would be vacuous");
});

// The guard is real only if it can fail. This drives it with the exact body the cycle
// used to send, so the check below is known to catch that shape rather than assumed to.
test("the input guard CATCHES the dispatch the cycle used to send", () => {
  const problems = inputProblems(["mode", "skill_id", "skill_version"]);
  assert.deepEqual(problems.undeclared, ["mode", "skill_id", "skill_version"]);
  assert.deepEqual(problems.missingRequired, ["branch", "run_id", "attempt_id"]);
});

test("THE EVALUATION CYCLE DISPATCHES NOTHING AT ALL", async () => {
  // Was: "dispatches only inputs the scorer declares". Option C dropped the probe, so
  // the stronger property now holds and is the one worth guarding. The cycle still runs
  // over this candidate skill; it just has nothing to send.
  await withFetch(CYCLE_ROUTES, async (calls) => {
    const { env } = cycleHarness();
    const report = await runEvaluationCycle(env, NOW);
    assert.equal(report.ran, true, "the cycle did not run, so this proves nothing about what it dispatches");
    assert.equal(
      dispatchesIn(calls).length,
      0,
      "the evaluation cycle dispatched the scorer. Scheduled probing was dropped on 2026-09-16; " +
        "a dispatch from here is the dead probe returning, and GitHub rejects it."
    );
  });
});

test("the cycle writes NO skill_evaluations row, and that is now the documented state", async () => {
  // Was: "a completed evaluation records a skill_evaluations row", red because nothing
  // probed. Nothing probes by design now, so the row does not come from here at all.
  // evaluationStatement is still the only writer and its caller is job_6464e6d62063,
  // which turns a verified job outcome into one of these rows. Until that lands, no
  // status moves, and this test is what says so out loud rather than leaving it to be
  // rediscovered.
  await withFetch(CYCLE_ROUTES, async () => {
    const { d1, env } = cycleHarness();
    await runEvaluationCycle(env, NOW);
    assert.equal(
      d1.rows.skill_evaluations.length,
      0,
      "the cycle wrote an evaluation. It measures nothing now; the writer is job_6464e6d62063."
    );
  });
});

// ---- no tick path may dispatch a body the workflow refuses ----------------------

async function tickHarness(runs: Array<Record<string, unknown>>) {
  const d1 = fakeD1({
    documents: [{ namespace: "capsid", path: "improve/scores.md", title: "scores", body: SCORES, type: "reference" }],
    namespaces: [{ namespace: "capsid", repos: JSON.stringify([{ repo: "owner/capsid-mcp", label: "primary" }]) }],
    improveRuns: runs,
    improveSkills: [SKILL],
  });
  const kv = fakeKv({
    seed: { "improve:anchor:capsid": await anchorChecksum(parseScoresDoc("capsid", SCORES)) },
    seedToken: true,
  });
  const env = fakeEnv({
    DB: d1.db,
    APP_KV: kv.kv,
    HOLDOUT: fakeR2({}).bucket,
    MEDIA: fakeR2({}).bucket,
    ANTHROPIC_API_KEY: "sk-test",
    GITHUB_APP_CLIENT_ID: "x",
    GITHUB_APP_PRIVATE_KEY: "x",
  });
  return { d1, env };
}

test("NO TICK PATH DISPATCHES improve-score.yml WITH A BODY THE WORKFLOW REFUSES", async () => {
  // The whole tick, not one function: the evaluation cycle rides it, and the point of
  // this guard is that a dispatch reintroduced anywhere on the tick is caught. A run at
  // 'opening' makes the tick dispatch the baseline, which is a real, correct dispatch,
  // so the guard is exercised against traffic rather than against silence.
  await withFetch(
    {
      "GET /repos/owner/capsid-mcp": { body: { default_branch: "main" } },
      "POST /repos/owner/capsid-mcp/git/refs": { status: 201, body: {} },
      "POST /repos/owner/capsid-mcp/actions/workflows/improve-score.yml/dispatches": { status: 204 },
    },
    async (calls) => {
      const { env } = await tickHarness([
        {
          id: "capsid-r9",
          namespace: "capsid",
          mode: "api",
          started: "2026-09-01 08:00:00",
          status: "opening",
          base_sha: "base000",
          advanced_at: "2026-09-01 08:04:00",
        },
      ]);
      await tickRuns(env, new Date("2026-09-01T08:05:00Z"));

      const dispatches = dispatchesIn(calls);
      assert.ok(dispatches.length > 0, "the tick dispatched the scorer not once, so this guard ran against nothing");
      for (const dispatch of dispatches) {
        const sent = Object.keys((dispatch.body as { inputs?: Record<string, string> }).inputs ?? {});
        assert.deepEqual(
          inputProblems(sent),
          { undeclared: [], missingRequired: [] },
          `a tick path sent ${JSON.stringify(sent)} to improve-score.yml, which declares ` +
            `${JSON.stringify(declaredInputs(WORKFLOW))}. GitHub rejects a dispatch carrying an undeclared ` +
            "input or missing a required one, which is how the skill probe failed silently for weeks."
        );
      }
    }
  );
});
