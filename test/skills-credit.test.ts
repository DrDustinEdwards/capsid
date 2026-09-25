import assert from "node:assert/strict";
import { test } from "node:test";
import { tickRuns } from "../src/improve/tick.ts";
import { IMPROVE_RUN_DEFAULTS, sseMessage } from "./improve-fakes.ts";
import { anchorChecksum, parseScoresDoc, seedScoresDoc } from "../src/improve-scores.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2, withFetch } from "./fakes.ts";

// ONE CREDIT SYSTEM, AND THE LOOP WAS NOT ON IT.
//
// capsid/decisions.md, 2026-09-12, ruled what one run does to one offered skill:
// a skill moves only when it was USED and a verifier reported on the work itself.
// attribute() in src/skills-lifecycle.ts implements that ruling, and
// attributionStatements() in src/skills-records.ts applies it.
//
// The loop never called either. It called recordSkillOutcome(db, id, kept), which
// knows only "kept" and charges a LOSS for everything else. The case that makes the
// difference visible is the one below: the model is offered a skill and declines to
// propose anything at all. The skill was never used, so under the ruling it earns
// nothing in either direction. Under recordSkillOutcome it takes a loss, and enough
// of those retire a skill for having been present while a model said no.

const SCORES = seedScoresDoc("capsid");
const NOW = new Date("2026-09-05T08:05:00Z");
const FRESH = { started: "2026-09-05 08:00:00", advanced_at: "2026-09-05 08:00:00" };

// Offered to a capsid run, so it must come from another namespace: candidateSkills
// excludes a skill whose source_namespace is the run's own.
const SKILL = {
  id: "sk-transfer",
  status: "candidate",
  version: 1,
  source_namespace: "foxhound",
  title: "a transferred skill",
  body_ref: "improve/skills/sk-transfer.md",
  wins: 0,
  losses: 0,
  ts: "2026-09-01 00:00:00",
};

async function harness() {
  const d1 = fakeD1({
    documents: [
      { namespace: "capsid", path: "improve/scores.md", title: "s", body: SCORES, type: "reference" },
      { namespace: "capsid", path: SKILL.body_ref, title: "a transferred skill", body: "do the thing", type: "reference" },
    ],
    namespaces: [{ namespace: "capsid", repos: JSON.stringify([{ repo: "o/r", label: "primary" }]) }],
    improveSkills: [SKILL],
  });
  const kv = fakeKv({
    seed: {
      improve_mode: "api",
      "improve:anchor:capsid": await anchorChecksum(parseScoresDoc("capsid", SCORES)),
    },
    seedToken: true,
  });
  const env = fakeEnv({
    DB: d1.db,
    APP_KV: kv.kv,
    HOLDOUT: fakeR2().bucket,
    MEDIA: fakeR2().bucket,
    ANTHROPIC_API_KEY: "sk-test",
  });
  return { d1, env };
}

/** One attempt where the model is offered the skill and proposes nothing. */
async function attemptWhereModelDeclines() {
  const route = {
    "POST /v1/messages": {
      contentType: "text/event-stream",
      text: sseMessage(JSON.stringify({ summary: "s", reasoning: "r", files: [] })),
    },
  };
  let result: { d1: ReturnType<typeof fakeD1>; note: string } | null = null;
  await withFetch(route, async () => {
    const { d1, env } = await harness();
    d1.rows.improve_runs.push({ ...IMPROVE_RUN_DEFAULTS, status: "attempting", condition: "full", ...FRESH });
    const outcomes = await tickRuns(env, NOW);
    result = { d1, note: outcomes[0]?.note ?? "" };
  });
  assert.ok(result, "the tick did not run");
  return result as unknown as { d1: ReturnType<typeof fakeD1>; note: string };
}

// The guard that keeps the test below from passing on an attempt that never happened.
test("the declining attempt really is offered the skill and really does propose nothing", async () => {
  const { d1, note } = await attemptWhereModelDeclines();
  assert.match(note, /proposed no file changes/, "the attempt did not reach the declining path");
  const attempt = d1.rows.improve_attempts.at(-1);
  assert.ok(attempt, "no attempt row was written");
  assert.equal(attempt.skill_id, SKILL.id, "the attempt was not offered the skill, so a credit test proves nothing");
});

test("A SKILL THE MODEL DECLINED TO USE IS NOT CHARGED A LOSS", async () => {
  const { d1 } = await attemptWhereModelDeclines();

  const credits = d1.recorded.filter(
    (r) => /UPDATE improve_skills SET (wins|losses)/i.test(r.sql) && r.params[0] === SKILL.id
  );
  assert.deepEqual(
    credits.map((r) => (/losses/i.test(r.sql) ? "loss" : "win")),
    [],
    "the model was offered this skill and declined to propose anything, so the skill was never used. " +
      "Under the 2026-09-12 attribution ruling an unused skill earns nothing in either direction, " +
      "but the loop charged it through recordSkillOutcome, which knows only 'kept'."
  );
});
