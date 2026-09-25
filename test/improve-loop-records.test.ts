import assert from "node:assert/strict";
import { test } from "node:test";
import { tickRuns } from "../src/improve/tick.ts";
import { finalizeRun, PR_RETRY_WINDOW_MS } from "../src/improve/finalize.ts";
import { runMetaLoop } from "../src/improve-meta.ts";
import { candidateSkills } from "../src/improve-skills.ts";
import { anchorChecksum, parseScoresDoc } from "../src/improve-scores.ts";
import { BUDGET_KEY, META_LAST_KEY } from "../src/improve-schema.ts";
import type { RunRow } from "../src/improve-state.ts";
import { runEvaluationCycle } from "../src/skills-evaluate.ts";
import { WATCHER_ACTOR } from "../src/watcher.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2, withFetch, type FakeD1Options } from "./fakes.ts";
import { IMPROVE_ATTEMPT_DEFAULTS, IMPROVE_RUN_DEFAULTS, sseChange } from "./improve-fakes.ts";
import { seedScoresDoc } from "./seed-scores.ts";

// THE IMPROVE LOOP'S RECORDS SAY WHAT HAPPENED (audit 2026-09-25, E2 items 12 to 18).
// Each test drives the public function and reads the rows, the KV keys or the
// documents it left, because every defect here was a record that said something
// other than what happened.

const SCORES = seedScoresDoc("capsid");
// One minute after the improve fake's pinned datetime('now') ("2026-09-01 08:05:00"),
// so a row the fake just stamped reads as fresh.
const NOW = new Date("2026-09-01T08:06:00Z");

async function harness(opts: Partial<FakeD1Options> = {}, kvSeed: Record<string, string> = {}) {
  const d1 = fakeD1({
    documents: [{ namespace: "capsid", path: "improve/scores.md", title: "scores", body: SCORES, type: "reference" }],
    namespaces: [{ namespace: "capsid", repos: JSON.stringify([{ repo: "owner/capsid-mcp", label: "primary" }]) }],
    ...opts,
  });
  const kv = fakeKv({
    seed: { improve_mode: "api", "improve:anchor:capsid": await anchorChecksum(parseScoresDoc("capsid", SCORES)), ...kvSeed },
    seedToken: true,
  });
  const env = fakeEnv({
    DB: d1.db,
    APP_KV: kv.kv,
    HOLDOUT: fakeR2({}).bucket,
    MEDIA: fakeR2({}).bucket,
    ANTHROPIC_API_KEY: "sk-test",
    // Jobs are signed when posted; without a secret postJob refuses.
    IMPROVE_SCORE_SECRET: "lorem-test-secret",
    GITHUB_APP_CLIENT_ID: "x",
    GITHUB_APP_PRIVATE_KEY: "x",
  });
  return { d1, kv, env };
}

// ---- E2-12: a pull request that failed to open -------------------------------

const KEPT = { ...IMPROVE_ATTEMPT_DEFAULTS, id: "run-1-a01", run_id: "run-1", status: "kept", kept: 1, branch: "improve/run-1-a01", change_summary: "a kept change" };

async function finalizeWithFailingPr(advancedAt: string, passes = 1) {
  const { d1, env } = await harness(
    { improveRuns: [{ ...IMPROVE_RUN_DEFAULTS, status: "finalizing", attempts: 1, kept: 1, started: "2026-09-01 07:00:00", advanced_at: advancedAt }], improveAttempts: [KEPT] },
    // The meta-loop is not under test here.
    { [META_LAST_KEY]: NOW.toISOString() }
  );
  let outcome: Awaited<ReturnType<typeof finalizeRun>> | undefined;
  // No GitHub route, so openPr fails.
  await withFetch({}, async () => {
    for (let i = 0; i < passes; i++) {
      // A later pass over the same run finds it in finalizing again, as a pass that
      // raced the one that advanced it would.
      d1.rows.improve_runs[0].status = "finalizing";
      outcome = await finalizeRun(env, { ...d1.rows.improve_runs[0], advanced_at: advancedAt } as unknown as RunRow, NOW);
    }
  });
  return { d1, outcome: outcome! };
}

const PAST_WINDOW = () => new Date(NOW.getTime() - PR_RETRY_WINDOW_MS - 60_000).toISOString().replace("T", " ").slice(0, 19);

test("a failed pull request is retried while the run is inside the retry window", async () => {
  const { d1, outcome } = await finalizeWithFailingPr("2026-09-01 08:05:00");
  assert.equal(outcome.to, "finalizing");
  assert.match(outcome.note, /could not be opened.*retrying/);
  assert.equal(d1.rows.improve_runs[0].status, "finalizing", "the run went terminal with its kept work unpublished");
  assert.equal(d1.rows.improve_runs[0].advanced_at, "2026-09-01 08:05:00", "the retry moved the window's start");
});

test("the retry window is short: fifteen minutes", () => {
  assert.equal(PR_RETRY_WINDOW_MS, 15 * 60 * 1000);
});

test("inside the retry window no job is posted", async () => {
  const { d1 } = await finalizeWithFailingPr("2026-09-01 08:05:00");
  assert.equal(d1.rows.jobs.length, 0, "a job was posted while the loop was still retrying the open itself");
});

test("past the retry window the run finishes with the failure recorded and ONE job posted to open the PR", async () => {
  const { d1 } = await finalizeWithFailingPr(PAST_WINDOW());
  const run = d1.rows.improve_runs[0];
  assert.equal(run.status, "done");
  assert.match(String(run.note), /the pull request for branch improve\/run-1-a01 could not be opened/);
  const summary = d1.recorded.find((r) => r.sql.includes("INSERT INTO documents") && String(r.params[1]).endsWith("run-summary.md"));
  assert.ok(summary, "no run summary was written");
  assert.match(String(summary.params[3]), /^- PR: FAILED, the pull request for branch improve\/run-1-a01/m);
  assert.doesNotMatch(String(summary.params[3]), /nothing was kept/, "a run with kept work said nothing was kept");

  // The job: in the run's namespace, posted as the watcher through the queue's post
  // path, naming the branch and what failed.
  assert.equal(d1.rows.jobs.length, 1, "the failed open was not handed to anyone");
  const job = d1.rows.jobs[0];
  assert.equal(job.namespace, "capsid");
  assert.equal(job.posted_by, WATCHER_ACTOR);
  assert.equal(job.status, "queued");
  assert.match(String(job.title), /improve\/run-1-a01/);
  assert.match(String(job.body), /improve\/run-1-a01/);
  assert.match(String(job.body), /could not be opened/);
  // A title ending in [fingerprint] would be read as a watcher finding, and the
  // watcher clears a finding no check owns on its next pass.
  assert.doesNotMatch(String(job.title), /\[[^\]]+\]\s*$/);
  assert.match(String(run.note), new RegExp(`posted ${String(job.id)} to open it`), "the run does not say a job was posted");
});

test("a second pass over the same run does not post a duplicate job", async () => {
  const { d1 } = await finalizeWithFailingPr(PAST_WINDOW(), 2);
  assert.equal(d1.rows.jobs.length, 1, "the second pass posted a second job for the same branch");
  assert.equal(d1.rows.improve_runs[0].status, "done");
  assert.match(String(d1.rows.improve_runs[0].note), /already has an open job titled/);
});

// ---- E2-15: which skills an attempt is offered ---------------------------------

test("candidateSkills offers only candidate or live skills that claim this namespace or none", async () => {
  const skill = (id: string, status: string, namespaces: string | null) => ({
    id, status, namespaces, source_namespace: "foxing", title: id, body_ref: `improve/skills/${id}.md`, wins: 0, losses: 0, source_attempt: null, ts: "2026-09-01 08:00:00",
  });
  const { d1 } = await harness({
    improveSkills: [
      skill("retired", "retired", null),
      skill("foxing-only", "live", JSON.stringify(["foxing"])),
      skill("anywhere", "candidate", null),
      skill("capsid-too", "live", JSON.stringify(["capsid", "foxing"])),
    ],
  });
  const offered = await candidateSkills(d1.db, "capsid", 10);
  assert.deepEqual(offered.map((s) => s.id).sort(), ["anywhere", "capsid-too"]);
});

// ---- E2-16: a skill transition and its audit row -------------------------------

const negative = (day: string) => ({
  skill: "fading", version: 1, namespace: "capsid", probe_set_version: "p1", delta: -0.1, runs: 5, verdict: "negative", evaluated_at: `2026-09-${day}`,
});

test("a skill transition whose audit row fails does not move the status, and the next pass records both", async () => {
  const opts: FakeD1Options = { failBatchMatching: /INSERT INTO audit_log/ };
  const d1 = fakeD1(opts);
  d1.rows.improve_skills.push({ id: "fading", status: "live", version: 1, source_namespace: "capsid" });
  d1.rows.skill_evaluations.push(negative("01"), negative("02"));
  const env = fakeEnv({ DB: d1.db, APP_KV: fakeKv({ seedToken: true }).kv });

  await assert.rejects(() => runEvaluationCycle(env, NOW), /database is locked/);
  assert.equal(d1.rows.improve_skills[0].status, "live", "the status moved although its audit row was never written");

  opts.failBatchMatching = undefined;
  const report = await runEvaluationCycle(env, NOW);
  assert.deepEqual(report.transitions.map((t) => [t.skill, t.to]), [["fading", "retired"]]);
  const audits = d1.rows.audit_log as unknown as Array<{ action?: string; params?: string }>;
  const moved = audits.filter((a) => a.action === "skill-status-changed");
  assert.equal(moved.length, 1, "the transition has no audit row");
  assert.equal(JSON.parse(String(moved[0].params)).to, "retired");
});

// ---- E2-18 (E2-L1): the budget refuses a dispatch after the push ---------------

// The tick's own budget check passes and the dispatch-time check refuses: the budget
// key reads as the default caps until the branch is pushed, and after that as a cap
// the run's recorded minutes already exceed.
function capOncePushed(env: { APP_KV: unknown }) {
  const state = { pushed: false };
  const kv = env.APP_KV as unknown as { get: (key: string, ...rest: unknown[]) => Promise<string | null> };
  const get = kv.get.bind(kv);
  kv.get = async (key: string, ...rest: unknown[]) => {
    if (key === BUDGET_KEY) return state.pushed ? JSON.stringify({ actions_minutes_month: 1 }) : null;
    return get(key, ...rest);
  };
  return {
    route: () => {
      state.pushed = true;
      return { status: 201, body: {} };
    },
  };
}
const cap = { route: () => ({ status: 201, body: {} }) };

test("a baseline refused at dispatch ends the run with the refusal, not as a baseline that never reported", async () => {
  await withFetch(
    {
      "POST /repos/owner/capsid-mcp/git/refs": () => cap.route(),
      "GET /repos/owner/capsid-mcp": { body: { default_branch: "main" } },
    },
    async (calls) => {
      const { d1, env } = await harness({
        improveRuns: [{ ...IMPROVE_RUN_DEFAULTS, status: "opening", ci_minutes: 5, started: "2026-09-01 08:00:00", advanced_at: "2026-09-01 08:04:00" }],
      });
      cap.route = capOncePushed(env).route;
      const outcomes = await tickRuns(env, NOW);
      assert.equal(calls.filter((c) => /\/dispatches$/.test(c.path)).length, 0, "the scorer was dispatched over the cap");
      assert.equal(outcomes[0].to, "finalizing");
      assert.equal(d1.rows.improve_runs[0].status, "finalizing");
      assert.match(String(d1.rows.improve_runs[0].note), /budget exceeded/);
    }
  );
});

test("an attempt refused at dispatch is marked refused-budget and the run ends", async () => {
  await withFetch(
    {
      "POST /v1/messages": { contentType: "text/event-stream", text: sseChange([{ path: "src/x.ts", content: "y" }]) },
      "POST /repos/owner/capsid-mcp/git/refs": () => cap.route(),
      "GET /repos/owner/capsid-mcp": { body: { default_branch: "main" } },
      "GET /repos/owner/capsid-mcp/contents/src/x.ts": { status: 404, body: { message: "Not Found" } },
      "PUT /repos/owner/capsid-mcp/contents/src/x.ts": { status: 201, body: { content: { sha: "f".repeat(40) }, commit: { sha: "c".repeat(40) } } },
    },
    async (calls) => {
      const { d1, env } = await harness({
        improveRuns: [{ ...IMPROVE_RUN_DEFAULTS, status: "attempting", ci_minutes: 5, started: "2026-09-01 08:00:00", advanced_at: "2026-09-01 08:04:00" }],
      });
      cap.route = capOncePushed(env).route;
      const outcomes = await tickRuns(env, NOW);
      assert.ok(calls.some((c) => c.method === "PUT"), "the attempt was never pushed, so this proves nothing");
      assert.equal(calls.filter((c) => /\/dispatches$/.test(c.path)).length, 0, "the scorer was dispatched over the cap");
      assert.equal(outcomes[0].to, "finalizing");
      const attempt = d1.rows.improve_attempts[0];
      assert.equal(attempt.status, "refused-budget", "a budget stop was left for the stale guard to call an environment failure");
      assert.match(String(attempt.reason), /budget exceeded/);
      const run = d1.rows.improve_runs[0];
      assert.equal(run.status, "finalizing");
      assert.equal(run.attempts, 1);
      assert.equal(run.current_attempt, null);
    }
  );
});

// ---- E2-18 (E2-L3): the meta-loop's weekly marker -------------------------------

test("the meta-loop does not stamp its weekly marker on an unusable answer", async () => {
  const answer = (text: string) => ({
    body: {
      id: "msg_1", type: "message", role: "assistant", model: "claude-opus", content: [{ type: "text", text }],
      stop_reason: "end_turn", stop_details: null, usage: { input_tokens: 10, output_tokens: 10 },
    },
  });
  const runs = [{ ...IMPROVE_RUN_DEFAULTS, status: "done", attempts: 3, kept: 1, reverts: 2 }];

  const unusable = await harness({ improveRuns: runs });
  await withFetch({ "POST /v1/messages": answer("not json") }, async () => {
    const result = await runMetaLoop(unusable.env, NOW);
    assert.match(result.note, /no usable answer/, "the model answer parsed, so this proves nothing");
  });
  assert.equal(unusable.kv.store.has(META_LAST_KEY), false, "an unusable answer silenced the meta-loop for a week");

  const usable = await harness({ improveRuns: runs });
  await withFetch({ "POST /v1/messages": answer(JSON.stringify({ propose: false, rationale: "nothing to change", revised_prompt: "" })) }, async () => {
    await runMetaLoop(usable.env, NOW);
  });
  assert.equal(usable.kv.store.get(META_LAST_KEY), NOW.toISOString(), "a usable answer must stamp the marker");
});
