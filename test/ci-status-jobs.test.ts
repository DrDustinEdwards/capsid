import assert from "node:assert/strict";
import { test } from "node:test";
import { CI_JOBS_MAX, CI_LOG_BUDGET, ciStatus } from "../src/github.ts";
import { fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// ci_status's drill-in for any run (jobs, job, step) and the redaction of every log it
// returns (src/redact.ts). Driven through the real ciStatus against a stubbed GitHub,
// as test/repo-fallthrough.test.ts drives the failed-run tail.
//
// Secret-shaped fixtures are assembled at run time so this public repo holds no string
// a scanner reads as a credential. They are fake.

const ONE_REPO = [{ repo: "o/r", label: "primary" }];

function makeEnv() {
  return fakeEnv({
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ repos: JSON.stringify(ONE_REPO) }) }) }) },
    APP_KV: fakeKv({ seedToken: true }).kv,
  });
}

const FAKE_TOKEN = "gh" + "s_" + "Sample0Fake1Token2Not3Real4Value5Xy";

const RUN = (over: Record<string, unknown> = {}) => ({
  id: 42,
  name: "CI",
  head_sha: "3bcf8583a59659c255843ab5b8cecd2f56761da6",
  status: "completed",
  conclusion: "success",
  event: "push",
  created_at: "2026-09-06T00:57:00Z",
  html_url: "https://github.com/o/r/actions/runs/42",
  ...over,
});

const STEPS = [
  { number: 1, name: "Set up job", status: "completed", conclusion: "success", started_at: "2026-09-06T00:57:20Z", completed_at: "2026-09-06T00:57:24Z" },
  { number: 2, name: "Checkout", status: "completed", conclusion: "success", started_at: "2026-09-06T00:57:25Z", completed_at: "2026-09-06T00:57:27Z" },
  { number: 3, name: "Deploy", status: "completed", conclusion: "success", started_at: "2026-09-06T00:58:30Z", completed_at: "2026-09-06T01:01:53Z" },
];
const JOB = (over: Record<string, unknown> = {}) => ({
  id: 9,
  name: "deploy",
  status: "completed",
  conclusion: "success",
  started_at: "2026-09-06T00:57:20Z",
  completed_at: "2026-09-06T01:02:00Z",
  html_url: "https://github.com/o/r/actions/runs/42/job/9",
  steps: STEPS,
  ...over,
});

const JOB_LOG = [
  "2026-09-06T00:57:25.0Z ##[group]Run actions/checkout@abc",
  "2026-09-06T00:57:26.0Z checkout noise",
  "2026-09-06T00:58:31.0Z ##[group]Run npx wrangler deploy",
  `2026-09-06T00:58:40.0Z debug: GITHUB_TOKEN=${FAKE_TOKEN}`,
  `2026-09-06T00:58:41.0Z curl -H "Authorization: Bearer ${FAKE_TOKEN}"`,
  "2026-09-06T01:00:00.0Z Deployed sample-worker (1.2 sec)",
  "2026-09-06T01:01:54.5Z git config --unset-all http.extraheader",
].join("\n");

const routes = (log: string | { status: number; text: string } = JOB_LOG, jobs = [JOB()], total?: number) => ({
  "GET /repos/o/r/actions/runs/42": { body: RUN() },
  "GET /repos/o/r/actions/runs/42/jobs": { body: { total_count: total ?? jobs.length, jobs } },
  "GET /repos/o/r/actions/jobs/9/logs": typeof log === "string" ? { text: log } : log,
});

type Out = Record<string, unknown> & {
  jobs?: Array<{ id: number; name: string; steps: Array<{ number: number; name: string }> }>;
  job?: { id: number; name: string };
  step?: { number: number; name: string };
  log?: string;
  log_region?: string;
  log_redactions?: Record<string, number>;
  log_withheld?: string;
  log_unavailable?: string;
};

test("jobs: true lists every job of any run, with steps, for the latest attempt, capped", async () => {
  await withFetch(routes(), async (calls) => {
    const out = (await ciStatus(makeEnv(), "ns", undefined, { runId: 42, jobs: true })) as Out;
    assert.equal(out.jobs?.length, 1);
    assert.equal(out.jobs?.[0].steps.length, 3);
    assert.deepEqual(out.jobs?.[0].steps.map((s) => s.name), ["Set up job", "Checkout", "Deploy"]);
    assert.equal(out.jobs_total, 1);
    assert.equal(out.jobs_truncated, undefined);
    assert.equal((out.run as { conclusion: string }).conclusion, "success", "a successful run was not drilled into");
    const jobsCall = calls.find((c) => c.path === "/repos/o/r/actions/runs/42/jobs");
    assert.match(jobsCall?.search ?? "", /filter=latest/);
    assert.match(jobsCall?.search ?? "", new RegExp(`per_page=${CI_JOBS_MAX}`));
    assert.equal(calls.some((c) => c.path.includes("/logs")), false, "listing jobs fetched a log");
  });
});

test("a run with more jobs than one page says so instead of claiming the page is all of it", async () => {
  await withFetch(routes(JOB_LOG, [JOB()], CI_JOBS_MAX + 5), async () => {
    const out = (await ciStatus(makeEnv(), "ns", undefined, { runId: 42, jobs: true })) as Out;
    assert.equal(out.jobs_total, CI_JOBS_MAX + 5);
    assert.match(String(out.jobs_truncated), /only the first 1 were read/);
  });
});

test("job picks one job by name or by id; step returns that step's log cut by timestamp", async () => {
  await withFetch(routes(), async () => {
    const byName = (await ciStatus(makeEnv(), "ns", undefined, { runId: 42, job: "deploy" })) as Out;
    assert.equal(byName.job?.id, 9);
    assert.equal(byName.log, undefined, "job without step returned a log");
    const byId = (await ciStatus(makeEnv(), "ns", undefined, { runId: 42, job: "9", step: "3", logTail: true })) as Out;
    assert.equal(byId.step?.name, "Deploy");
    const log = byId.log ?? "";
    assert.match(log, /Deployed sample-worker/);
    assert.equal(/checkout noise/.test(log), false, "the previous step leaked in");
    assert.equal(/unset-all/.test(log), false, "post-run cleanup leaked in");
    assert.match(byId.log_region ?? "", /^step "Deploy" by timestamp window/);
  });
});

test("PLANT: a token in a step log never reaches the caller", async () => {
  await withFetch(routes(), async () => {
    const out = (await ciStatus(makeEnv(), "ns", undefined, { runId: 42, job: "deploy", step: "Deploy", logTail: true })) as Out;
    const text = JSON.stringify(out);
    assert.equal(text.includes(FAKE_TOKEN), false, "the planted token reached the caller");
    assert.equal(text.includes("Sample0Fake1Token"), false, "part of the planted token reached the caller");
    assert.match(out.log ?? "", /GITHUB_TOKEN=\[REDACTED:github-token\]/);
    assert.match(out.log ?? "", /Authorization: Bearer \[REDACTED:/);
    assert.equal(out.log_redactions?.["github-token"], 2);
  });
});

test("PLANT: a token in the failed-run tail never reaches the caller either", async () => {
  const failedStep = { ...STEPS[2], conclusion: "failure" };
  await withFetch(
    {
      "GET /repos/o/r/actions/runs": { body: { workflow_runs: [RUN({ conclusion: "failure" })] } },
      "GET /repos/o/r/actions/runs/42/jobs": { body: { jobs: [JOB({ conclusion: "failure", steps: [failedStep] })] } },
      "GET /repos/o/r/actions/jobs/9/logs": { text: JOB_LOG },
    },
    async () => {
      const out = await ciStatus(makeEnv(), "ns", undefined, { logTail: true });
      const failed = out.failed_run as { log?: string; log_redactions?: Record<string, number> };
      assert.equal(JSON.stringify(out).includes(FAKE_TOKEN), false, "the planted token reached the caller");
      assert.match(failed.log ?? "", /\[REDACTED:github-token\]/);
      assert.deepEqual(failed.log_redactions, { "github-token": 2 });
    }
  );
});

test("PLANT: a token in the fallback region (no usable window) is redacted too", async () => {
  const noWindow = STEPS.map((s) => (s.number === 3 ? { number: 3, name: "Deploy", status: "in_progress", conclusion: null } : s));
  await withFetch(routes(JOB_LOG, [JOB({ steps: noWindow })]), async () => {
    const out = (await ciStatus(makeEnv(), "ns", undefined, { runId: 42, job: "deploy", step: "Deploy", logTail: true })) as Out;
    assert.match(out.log_region ?? "", /no usable timestamp window/);
    assert.equal((out.log ?? "").includes(FAKE_TOKEN), false);
  });
});

test("PLANT: a secret split by the budget cut is still redacted, because redaction runs first", async () => {
  // The token sits right at the cut: cut first, its tail would no longer match a pattern.
  const filler = Array.from({ length: 8000 }, () => "2026-09-06T01:00:00.0Z filler line").join("\n");
  const tail = `2026-09-06T01:01:50.0Z ${"z".repeat(CI_LOG_BUDGET - 60)}`;
  const log = `2026-09-06T00:58:31.0Z start\n${filler}\n2026-09-06T01:00:59.0Z token ${FAKE_TOKEN}\n${tail}`;
  await withFetch(routes(log), async () => {
    const out = (await ciStatus(makeEnv(), "ns", undefined, { runId: 42, job: "deploy", step: "Deploy", logTail: true })) as Out;
    const body = out.log ?? "";
    assert.ok(body.length <= CI_LOG_BUDGET, `log was ${body.length} bytes, over the budget`);
    assert.equal(body.includes("Value5Xy"), false, "the token's tail survived the cut");
  });
});

test("a read-only caller gets step metadata and no log, and the log is never fetched", async () => {
  await withFetch(routes(), async (calls) => {
    const out = (await ciStatus(makeEnv(), "ns", undefined, { runId: 42, job: "deploy", step: "Deploy", logTail: false })) as Out;
    assert.equal(out.step?.name, "Deploy");
    assert.equal(out.log, undefined);
    assert.match(out.log_withheld ?? "", /read-only key/);
    assert.equal(calls.some((c) => c.path.includes("/logs")), false, "the log was fetched for a read-only caller");
  });
});

test("an unavailable step log is named, and its error body is redacted", async () => {
  await withFetch(routes({ status: 410, text: `gone, token=${FAKE_TOKEN}` }), async () => {
    const out = (await ciStatus(makeEnv(), "ns", undefined, { runId: 42, job: "deploy", step: "Deploy", logTail: true })) as Out;
    assert.match(out.log_unavailable ?? "", /^410: gone/);
    assert.equal((out.log_unavailable ?? "").includes(FAKE_TOKEN), false);
  });
});

test("REFUSES step without job, job or jobs without run_id, and jobs with job, before any call", async () => {
  await withFetch({}, async (calls) => {
    const env = makeEnv();
    await assert.rejects(() => ciStatus(env, "ns", undefined, { runId: 42, step: "Deploy" }), /step needs job/);
    await assert.rejects(() => ciStatus(env, "ns", undefined, { job: "deploy" }), /job needs run_id/);
    await assert.rejects(() => ciStatus(env, "ns", undefined, { job: "deploy", step: "Deploy" }), /job needs run_id/);
    await assert.rejects(() => ciStatus(env, "ns", undefined, { jobs: true }), /jobs needs run_id/);
    await assert.rejects(() => ciStatus(env, "ns", undefined, { runId: 42, jobs: true, job: "deploy" }), /not both/);
    assert.equal(calls.length, 0, "a refused call reached GitHub");
  });
});

test("REFUSES a missing job or step by naming what exists, and a shared name by naming the ids", async () => {
  const twins = [JOB(), JOB({ id: 10, html_url: "https://github.com/o/r/actions/runs/42/job/10" })];
  await withFetch(routes(JOB_LOG, twins), async () => {
    await assert.rejects(() => ciStatus(makeEnv(), "ns", undefined, { runId: 42, job: "deploy" }), /2 jobs in run 42 are named "deploy".*9, 10/);
    await assert.rejects(() => ciStatus(makeEnv(), "ns", undefined, { runId: 42, job: "build" }), /no job "build" in run 42. It has: "deploy" \(9\)/);
    await assert.rejects(
      () => ciStatus(makeEnv(), "ns", undefined, { runId: 42, job: "9", step: "Test" }),
      /no step "Test" in job "deploy". It has: "Set up job" \(1\), "Checkout" \(2\), "Deploy" \(3\)/
    );
  });
});

test("without the new arguments the output is unchanged: no jobs, job or step fields", async () => {
  await withFetch(routes(), async (calls) => {
    const out = (await ciStatus(makeEnv(), "ns", undefined, { runId: 42 })) as Record<string, unknown>;
    assert.deepEqual(Object.keys(out).sort(), ["filter", "repo", "runs"]);
    assert.deepEqual(out.filter, { run_id: 42 });
    assert.equal(calls.some((c) => c.path.endsWith("/jobs")), false, "a successful run was drilled into");
  });
});
