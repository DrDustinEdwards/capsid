import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_DAY_UTC,
  discoverModels,
  guideKey,
  readSchedule,
  SCHEDULE_KEY,
  SKILLS_NAMESPACE,
  SKILLS_REFRESH_ACTOR,
  skillsRefreshAgent,
} from "../src/skills-refresh.ts";
import { SCOPE_FLAGS } from "../src/agents-schema.ts";
import { sourceFile } from "./source-files.ts";

// A KV that answers from a map, and one that throws, so both branches of the
// schedule read are driven rather than reasoned about.
function fakeKv(store: Record<string, string>): KVNamespace {
  return { get: async (k: string) => (k in store ? store[k] : null) } as unknown as KVNamespace;
}
const throwingKv = { get: async () => { throw new Error("KV is down"); } } as unknown as KVNamespace;

// The overview's shape since October 2026 (models/overview.md): frontmatter, MDX chips,
// a comparison table with a "Model page" row of links and the IDs further down, and
// links to retired models' pages elsewhere. Model names are neutral placeholders.
const OVERVIEW = [
  "---",
  "title: Models overview",
  "url: https://platform.claude.com/docs/en/models/overview",
  "---",
  "",
  '<HomeQuickChip icon="Signpost" href="https://platform.claude.com/docs/en/about-claude/models/choosing-a-model">',
  "  Choosing a model",
  "</HomeQuickChip>",
  "",
  "| Feature | Claude Fable 9.1 | Claude Haiku 9.5 |",
  "| :------ | :--------------- | :--------------- |",
  "| Model page | [Claude Fable 9.1](https://platform.claude.com/docs/en/models/fable-9-1/overview) | [Claude Haiku 9.5](https://platform.claude.com/docs/en/models/haiku-9-5/overview) |",
  "| Claude API ID | `claude-fable-9-1` | `claude-haiku-9-5-20990101` |",
  "| Amazon Bedrock ID | `anthropic.claude-fable-9-1` | `anthropic.claude-haiku-9-5` |",
  "",
  "Older models: [Claude Opus 8](https://platform.claude.com/docs/en/models/opus-8/overview).",
].join("\n");

test("discovers the current models from the overview and collapses dated snapshots", () => {
  assert.deepEqual(discoverModels(OVERVIEW), ["fable-9-1", "haiku-9-5"]);
  // The "Model page" row alone still finds them, so a table that drops the ID rows
  // does not read as zero models; a retired model linked elsewhere is not one.
  const linksOnly = OVERVIEW.split("\n").filter((line) => !line.includes("`")).join("\n");
  assert.deepEqual(discoverModels(linksOnly), ["fable-9-1", "haiku-9-5"]);
});

// The MODEL_ID regex from DrDustinEdwards/claude-skills scripts/model-guides.mjs,
// vendored so the comparison runs in CI. When the claude-skills copy changes, update
// this line and src/skills-refresh.ts together.
const CLAUDE_SKILLS_MODEL_ID = String.raw`/\bclaude-(fable|mythos|opus|sonnet|haiku)-\d[a-z0-9-]*/g`;

// scanner-rule: conventions-verification, a list spelled in two places is derived and compared. The other copy is vendored above from the claude-skills repo
test("THE WORKER AND THE REPO SCRIPT AGREE ON WHAT A MODEL ID LOOKS LIKE", () => {
  // The same discovery runs here and in claude-skills' scripts/model-guides.mjs, so
  // the two patterns must not drift.
  const mine = /const MODEL_ID = (\/.+\/g);/.exec(sourceFile("skills-refresh.ts"));
  assert.ok(mine, "src/skills-refresh.ts no longer declares MODEL_ID");
  assert.equal(mine[1], CLAUDE_SKILLS_MODEL_ID, "the Worker and the claude-skills script disagree about what a model id looks like");
  // And the Worker finds every family that pattern names.
  const families = ["fable", "mythos", "opus", "sonnet", "haiku"];
  const overview = families.map((f) => `| x | \`claude-${f}-9-9\` |`).join("\n");
  assert.deepEqual(discoverModels(overview), families.map((f) => `${f}-9-9`).sort());
});

test("an unset key takes the documented default and runs", async () => {
  const schedule = await readSchedule(fakeKv({}));
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.dayUtc, DEFAULT_DAY_UTC);
  assert.equal(DEFAULT_DAY_UTC, 1, "the default day is Monday");
});

test("A KV THAT THREW DISABLES THE RUN", async () => {
  // An unset key is a configuration never written; a throw is a fault, and a fault
  // does not start work.
  const schedule = await readSchedule(throwingKv);
  assert.equal(schedule.enabled, false);
  assert.match(schedule.reason ?? "", /KV is down/);
});

test("an explicit disable is honored", async () => {
  const schedule = await readSchedule(fakeKv({ [SCHEDULE_KEY]: '{"enabled":false}' }));
  assert.equal(schedule.enabled, false);
});

test("a configured day overrides the default", async () => {
  const schedule = await readSchedule(fakeKv({ [SCHEDULE_KEY]: '{"dayUtc":4}' }));
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.dayUtc, 4);
});

test("garbage in the key disables rather than guessing", async () => {
  for (const raw of ["not json", "[]", '"a string"', '{"dayUtc":9}', '{"dayUtc":"monday"}', '{"dayUtc":1.5}']) {
    const schedule = await readSchedule(fakeKv({ [SCHEDULE_KEY]: raw }));
    assert.equal(schedule.enabled, false, `${raw} should have disabled the run`);
  }
});

test("the cron agent may reach exactly one namespace and holds no blast-radius flag", () => {
  const agent = skillsRefreshAgent();
  assert.equal(agent.actor, SKILLS_REFRESH_ACTOR);
  assert.match(agent.actor, /^agent:/, "the actor shape jobs.ts checks for");
  assert.equal(agent.kind, "cron");
  assert.equal(agent.admin, false);
  assert.deepEqual(agent.scopes.namespaces, [SKILLS_NAMESPACE]);
  assert.deepEqual(agent.scopes.repos, [], "the refresh cron reaches no repo directly");
  assert.deepEqual(agent.scopes.grants, ["write"]);
  // Derived from the flag list rather than spelled out, so a flag added to
  // SCOPE_FLAGS is asserted false here by the act of existing.
  for (const flag of SCOPE_FLAGS) {
    assert.equal(agent.scopes.flags[flag], false, `the refresh cron must not hold ${flag}`);
  }
  assert.ok(SCOPE_FLAGS.length > 0, "no flags were checked");
});

test("the guide key is namespaced per model", () => {
  assert.equal(guideKey("fable-5-1"), "skills:guides:fable-5-1");
  assert.notEqual(guideKey("opus-5"), guideKey("sonnet-5"));
});
