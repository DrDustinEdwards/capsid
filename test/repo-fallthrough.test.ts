import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CI_LOG_BUDGET,
  REPO_BATCH_MAX_FILES,
  REPO_FILE_BUDGET,
  REPO_HISTORY_MAX_LIMIT,
  ciStatus,
  deleteBranch,
  readRepoFiles,
  repoHistory,
  repoRefs,
} from "../src/github.ts";
import { fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// The repo fallthrough tools, which reach private repos through this Worker's App
// token. These drive the real handlers against a stubbed GitHub, because the
// refusals matter most: a tool that deletes the default branch or bills a rerun it
// did not start is worse than one that is missing.

const ONE_REPO = [{ repo: "o/r", label: "primary" }];

function makeEnv(repos: unknown[] | null = ONE_REPO) {
  return fakeEnv({
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => (repos === null ? null : { repos: JSON.stringify(repos) }) }),
      }),
    },
    APP_KV: fakeKv({ seedToken: true }).kv,
  });
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const fileBody = (content: string, sha = "s") => ({ type: "file", encoding: "base64", content: b64(content), size: content.length, sha });
const REPO_META = { body: { default_branch: "main" } };

// repo_refs

const BRANCHES = [
  { name: "main", commit: { sha: "m1" } },
  { name: "review/blog-convergence", commit: { sha: "b1" } },
  { name: "stale/no-pr", commit: { sha: "b2" } },
];
const TAGS = [{ name: "v1.0.0", commit: { sha: "t1" } }];
const PULLS = [
  {
    number: 7,
    title: "Blog convergence",
    head: { ref: "review/blog-convergence" },
    base: { ref: "main" },
    updated_at: "2026-09-05T00:00:00Z",
    html_url: "https://github.com/o/r/pull/7",
  },
];

test("repo_refs returns branches, tags and open PRs in one call", async () => {
  await withFetch(
    {
      "GET /repos/o/r": REPO_META,
      "GET /repos/o/r/branches": { body: BRANCHES },
      "GET /repos/o/r/tags": { body: TAGS },
      "GET /repos/o/r/pulls": { body: PULLS },
      "GET /repos/o/r/compare/main...review%2Fblog-convergence": { body: { ahead_by: 3, behind_by: 1, commits: [{ commit: { committer: { date: "2026-09-05T12:00:00Z" } } }] } },
      "GET /repos/o/r/compare/main...stale%2Fno-pr": { body: { ahead_by: 0, behind_by: 9, commits: [] } },
    },
    async () => {
      const out = await repoRefs(makeEnv(), "ns");
      assert.equal(out.repo, "o/r");
      assert.equal(out.default_branch, "main");
      assert.equal(out.branches.length, 3);
      assert.equal(out.tags.length, 1);
      assert.equal(out.pull_requests.length, 1);
      assert.equal(out.truncated, false);
    }
  );
});

test("repo_refs reports ahead/behind, and zero for the default branch itself", async () => {
  await withFetch(
    {
      "GET /repos/o/r": REPO_META,
      "GET /repos/o/r/branches": { body: BRANCHES },
      "GET /repos/o/r/tags": { body: TAGS },
      "GET /repos/o/r/pulls": { body: PULLS },
      "GET /repos/o/r/compare/main...review%2Fblog-convergence": { body: { ahead_by: 3, behind_by: 1, commits: [{ commit: { committer: { date: "2026-09-05T12:00:00Z" } } }] } },
      "GET /repos/o/r/compare/main...stale%2Fno-pr": { body: { ahead_by: 0, behind_by: 9, commits: [] } },
    },
    async () => {
      const out = await repoRefs(makeEnv(), "ns");
      const main = out.branches.find((b) => b.name === "main");
      const review = out.branches.find((b) => b.name === "review/blog-convergence");
      // Comparing the default branch with itself is always 0/0, so it is not fetched.
      assert.equal(main?.is_default, true);
      assert.equal(main?.ahead_by, 0);
      assert.equal(main?.behind_by, 0);
      assert.equal(review?.ahead_by, 3);
      assert.equal(review?.behind_by, 1);
      assert.equal(review?.committed_date, "2026-09-05T12:00:00Z");
    }
  );
});

test("repo_refs links a branch to its open PR, and leaves branches without one null", async () => {
  await withFetch(
    {
      "GET /repos/o/r": REPO_META,
      "GET /repos/o/r/branches": { body: BRANCHES },
      "GET /repos/o/r/tags": { body: TAGS },
      "GET /repos/o/r/pulls": { body: PULLS },
      "GET /repos/o/r/compare/main...review%2Fblog-convergence": { body: { ahead_by: 3, behind_by: 1, commits: [] } },
      "GET /repos/o/r/compare/main...stale%2Fno-pr": { body: { ahead_by: 0, behind_by: 9, commits: [] } },
    },
    async () => {
      const out = await repoRefs(makeEnv(), "ns");
      assert.equal(out.branches.find((b) => b.name === "review/blog-convergence")?.open_pr, 7);
      assert.equal(out.branches.find((b) => b.name === "stale/no-pr")?.open_pr, null, "a branch with no PR reported one");
      assert.equal(out.branches.find((b) => b.name === "main")?.open_pr, null);
    }
  );
});

// repo_history, every mode

const COMMIT_ROWS = [
  { sha: "c1", commit: { message: "first line\n\nand a body paragraph", author: { name: "Dustin", date: "2026-09-05T00:00:00Z" } } },
  { sha: "c2", commit: { message: "second", author: { name: "Dustin", date: "2026-09-04T00:00:00Z" } } },
];

test("repo_history ref mode lists commits, subject only", async () => {
  await withFetch({ "GET /repos/o/r/commits": { body: COMMIT_ROWS } }, async () => {
    const out = (await repoHistory(makeEnv(), "ns", { ref: "main" })) as { mode: string; commits: Array<{ subject: string; sha: string }> };
    assert.equal(out.mode, "commits");
    assert.equal(out.commits.length, 2);
    assert.equal(out.commits[0].subject, "first line", "the body leaked into the listing");
    assert.equal(out.commits[0].subject.includes("body paragraph"), false);
  });
});

test("repo_history ref mode clamps limit to the maximum", async () => {
  await withFetch({ "GET /repos/o/r/commits": { body: COMMIT_ROWS } }, async () => {
    const out = (await repoHistory(makeEnv(), "ns", { ref: "main", limit: 9999 })) as { limit: number };
    assert.equal(out.limit, REPO_HISTORY_MAX_LIMIT);
    const low = (await repoHistory(makeEnv(), "ns", { ref: "main", limit: 0 })) as { limit: number };
    assert.ok(low.limit >= 1, "limit 0 was not clamped up");
  });
});

test("repo_history compare mode reports ahead/behind and changed files", async () => {
  await withFetch(
    {
      "GET /repos/o/r/compare/main...topic": {
        body: {
          status: "ahead",
          ahead_by: 2,
          behind_by: 0,
          total_commits: 2,
          commits: COMMIT_ROWS,
          files: [{ filename: "src/a.ts", status: "modified", additions: 10, deletions: 2, patch: "@@ hunk @@" }],
        },
      },
    },
    async () => {
      const out = (await repoHistory(makeEnv(), "ns", { base: "main", head: "topic" })) as {
        mode: string;
        ahead_by: number;
        files: { count: number; entries: Array<{ path: string; additions: number; patch?: string }> };
      };
      assert.equal(out.mode, "compare");
      assert.equal(out.ahead_by, 2);
      assert.equal(out.files.count, 1);
      assert.equal(out.files.entries[0].path, "src/a.ts");
      assert.equal(out.files.entries[0].additions, 10);
      // Patch bodies are OFF unless asked for.
      assert.equal(out.files.entries[0].patch, undefined, "a patch body was returned without patch:true");
    }
  );
});

test("repo_history returns patch bodies only with patch:true, and budgets them", async () => {
  const huge = "x".repeat(150 * 1024);
  await withFetch(
    {
      "GET /repos/o/r/compare/main...topic": {
        body: {
          status: "ahead",
          ahead_by: 1,
          behind_by: 0,
          total_commits: 1,
          commits: COMMIT_ROWS.slice(0, 1),
          files: [
            { filename: "big-one.ts", status: "modified", additions: 1, deletions: 0, patch: huge },
            { filename: "big-two.ts", status: "modified", additions: 1, deletions: 0, patch: huge },
          ],
        },
      },
    },
    async () => {
      const out = (await repoHistory(makeEnv(), "ns", { base: "main", head: "topic", patch: true })) as {
        files: { patch_truncated: boolean; patch_bytes: number; entries: Array<{ patch?: string }> };
      };
      // Two 150KB patches cannot both fit in a 200KB budget, so the second is dropped
      // and the caller is told.
      assert.equal(out.files.patch_truncated, true, "the budget did not trip");
      assert.ok(out.files.patch_bytes <= 200 * 1024, `spent ${out.files.patch_bytes}`);
      assert.equal(typeof out.files.entries[0].patch, "string");
      assert.equal(out.files.entries[1].patch, undefined);
    }
  );
});

test("repo_history sha mode returns the full message and parents", async () => {
  await withFetch(
    {
      "GET /repos/o/r/commits/c1": {
        body: {
          sha: "c1",
          commit: { message: "first line\n\nand a body paragraph", author: { name: "Dustin", date: "2026-09-05T00:00:00Z" } },
          parents: [{ sha: "c0" }],
          files: [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 1 }],
        },
      },
    },
    async () => {
      const out = (await repoHistory(makeEnv(), "ns", { sha: "c1" })) as {
        mode: string;
        commit: { message: string; parents: string[] };
        files: { count: number };
      };
      assert.equal(out.mode, "commit");
      // Unlike the listing, one commit read by sha carries its whole message.
      assert.match(out.commit.message, /body paragraph/);
      assert.deepEqual(out.commit.parents, ["c0"]);
      assert.equal(out.files.count, 1);
    }
  );
});

test("repo_history REFUSES an ambiguous combination rather than picking one", async () => {
  const env = makeEnv();
  await withFetch({}, async () => {
    await assert.rejects(() => repoHistory(env, "ns", { sha: "c1", ref: "main" }), /different questions/);
    await assert.rejects(() => repoHistory(env, "ns", { sha: "c1", base: "a", head: "b" }), /different questions/);
    await assert.rejects(() => repoHistory(env, "ns", { base: "a" }), /base was given without head/);
    await assert.rejects(() => repoHistory(env, "ns", { head: "b" }), /head was given without base/);
    await assert.rejects(() => repoHistory(env, "ns", {}), /pass ref for commits/);
  });
});

// delete_branch, all three refusals

test("delete_branch REFUSES the default branch, and force does not lift it", async () => {
  await withFetch({ "GET /repos/o/r": REPO_META }, async () => {
    await assert.rejects(() => deleteBranch(makeEnv(), "ns", "main"), /is the default branch/);
    await assert.rejects(() => deleteBranch(makeEnv(), "ns", "main", { force: true }), /force does not lift/);
  });
});

test("delete_branch REFUSES a branch with an open PR unless forced, and names the PR", async () => {
  await withFetch(
    {
      "GET /repos/o/r": REPO_META,
      "GET /repos/o/r/pulls": { body: [{ number: 7, html_url: "https://github.com/o/r/pull/7" }] },
    },
    async () => {
      await assert.rejects(() => deleteBranch(makeEnv(), "ns", "topic"), /open pull request #7/);
    }
  );
});

test("delete_branch deletes a plain branch with no PR", async () => {
  await withFetch(
    {
      "GET /repos/o/r": REPO_META,
      "GET /repos/o/r/pulls": { body: [] },
      "DELETE /repos/o/r/git/refs/heads/topic": { status: 204, text: "" },
    },
    async (calls) => {
      const out = await deleteBranch(makeEnv(), "ns", "topic");
      assert.equal(out.deleted, true);
      assert.equal(out.forced, false);
      assert.ok(calls.some((c) => c.method === "DELETE"), "no DELETE was issued");
    }
  );
});

test("delete_branch REFUSES a branch that does not exist rather than reporting success", async () => {
  await withFetch(
    {
      "GET /repos/o/r": REPO_META,
      "GET /repos/o/r/pulls": { body: [] },
      "DELETE /repos/o/r/git/refs/heads/gone": { status: 422, text: "Reference does not exist" },
    },
    async () => {
      await assert.rejects(() => deleteBranch(makeEnv(), "ns", "gone"), /does not exist/);
    }
  );
});

// ci_status: ref and run_id filters, and the log budget

const RUN_ROW = (over: Record<string, unknown> = {}) => ({
  id: 42,
  name: "CI",
  head_sha: "3bcf858aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  status: "completed",
  conclusion: "failure",
  event: "push",
  created_at: "2026-09-05T00:00:00Z",
  html_url: "https://github.com/o/r/actions/runs/42",
  ...over,
});

const FULL_SHA = "3bcf8583a59659c255843ab5b8cecd2f56761da6";

test("ci_status filters by branch or by sha, choosing the right query parameter", async () => {
  await withFetch(
    {
      "GET /repos/o/r/actions/runs": { body: { workflow_runs: [] } },
      "GET /repos/o/r/commits/3bcf858": { body: { sha: FULL_SHA } },
    },
    async (calls) => {
      await ciStatus(makeEnv(), "ns", undefined, { ref: "review/blog-convergence" });
      await ciStatus(makeEnv(), "ns", undefined, { ref: "3bcf858" });
      const [byBranch, bySha] = calls.filter((c) => c.path === "/repos/o/r/actions/runs").map((c) => c.search);
    // GitHub has separate branch and sha parameters, so the tool decides from the
    // shape of the ref. Backwards, a valid sha returns an empty run list.
      assert.match(byBranch, /branch=review%2Fblog-convergence/, `branch query missing: ${byBranch}`);
      assert.match(bySha, /head_sha=3bcf858/, `sha query missing: ${bySha}`);
      assert.equal(/[?&]branch=3bcf858/.test(bySha), false, "a sha was filtered as a branch");
    }
  );
});

test("ci_status EXPANDS an abbreviated sha before filtering, because GitHub matches exactly", async () => {
  // GitHub's head_sha filter returns nothing for an abbreviated sha, silently.
  await withFetch(
    {
      "GET /repos/o/r/commits/3bcf858": { body: { sha: FULL_SHA } },
      "GET /repos/o/r/actions/runs": { body: { workflow_runs: [] } },
    },
    async (calls) => {
      await ciStatus(makeEnv(), "ns", undefined, { ref: "3bcf858" });
      const runsCall = calls.find((c) => c.path === "/repos/o/r/actions/runs");
      assert.match(runsCall?.search ?? "", new RegExp(`head_sha=${FULL_SHA}`), `not expanded: ${runsCall?.search}`);
      assert.ok(
        calls.some((c) => c.path === "/repos/o/r/commits/3bcf858"),
        "it did not resolve the abbreviation"
      );
    }
  );
  // A full sha costs no extra call.
  await withFetch({ "GET /repos/o/r/actions/runs": { body: { workflow_runs: [] } } }, async (calls) => {
    await ciStatus(makeEnv(), "ns", undefined, { ref: FULL_SHA });
    assert.equal(calls.some((c) => c.path.startsWith("/repos/o/r/commits/")), false, "a full sha was resolved anyway");
  });
  // A ref that resolves to nothing is a named refusal, not an empty run list.
  await withFetch({ "GET /repos/o/r/commits/deadbee": { status: 404, text: "Not Found" } }, async () => {
    await assert.rejects(() => ciStatus(makeEnv(), "ns", undefined, { ref: "deadbee" }), /does not resolve to a commit/);
  });
});

test("ci_status run_id returns just that run, and refuses one that does not exist", async () => {
  await withFetch(
    { "GET /repos/o/r/actions/runs/42": { body: RUN_ROW({ conclusion: "success" }) } },
    async () => {
      const out = (await ciStatus(makeEnv(), "ns", undefined, { runId: 42 })) as {
        runs: unknown[];
        filter?: { run_id?: number };
      };
      assert.equal(out.runs.length, 1);
      assert.equal(out.filter?.run_id, 42);
    }
  );
  await withFetch({ "GET /repos/o/r/actions/runs/99": { status: 404, text: "Not Found" } }, async () => {
    await assert.rejects(() => ciStatus(makeEnv(), "ns", undefined, { runId: 99 }), /run 99 does not exist/);
  });
});

// A realistic job log: every line timestamped, groups labeled "Run <command>"
// rather than by step name, and post-run cleanup at the end. The step name appears
// nowhere in it.
const JOB_LOG = [
  "2026-09-06T00:57:25.0Z ##[group]Run actions/checkout@abc",
  "2026-09-06T00:57:26.0Z setup noise nobody asked for",
  "2026-09-06T00:57:27.0Z ##[endgroup]",
  "2026-09-06T00:58:31.0Z ##[group]Run npm run check:ci",
  "2026-09-06T00:58:40.0Z check:types ... ok",
  "2026-09-06T01:00:00.0Z check:floors ... FAILED",
  "2026-09-06T01:01:52.0Z ##[error]Process completed with exit code 1.",
  "2026-09-06T01:01:54.0Z ##[group]Post Run actions/checkout@abc",
  "2026-09-06T01:01:54.5Z git config --unset-all http.extraheader",
  "2026-09-06T01:01:54.9Z Cleaning up orphan processes",
].join("\n");

const FAILED_STEP = {
  name: "Gates",
  conclusion: "failure",
  started_at: "2026-09-06T00:58:30Z",
  completed_at: "2026-09-06T01:01:53Z",
};

test("ci_status finds the failing step BY TIMESTAMP, since its name is not in the log", async () => {
  await withFetch(
    {
      "GET /repos/o/r/actions/runs": { body: { workflow_runs: [RUN_ROW()] } },
      "GET /repos/o/r/actions/runs/42/jobs": {
        body: { jobs: [{ id: 9, name: "Gates, clean checkout", conclusion: "failure", steps: [FAILED_STEP] }] },
      },
      "GET /repos/o/r/actions/jobs/9/logs": { text: JOB_LOG },
    },
    async () => {
      const out = (await ciStatus(makeEnv(), "ns", undefined, { logTail: true })) as {
        failed_run: { log?: string; log_region?: string; failing_step?: string | null; failing_job?: string };
      };
      const failed = out.failed_run;
      const body = failed.log ?? "";
      assert.equal(failed.failing_job, "Gates, clean checkout");
      assert.equal(failed.failing_step, "Gates");
      assert.match(body, /check:floors \.\.\. FAILED/, "the actual failure was not returned");
      // Neither the setup before the step NOR the cleanup after it.
      assert.equal(/setup noise/.test(body), false, "output from before the step leaked in");
      assert.equal(/orphan processes/.test(body), false, "post-run cleanup leaked in, which is the whole defect");
      assert.equal(/git config --unset-all/.test(body), false, "post-run git plumbing leaked in");
      assert.match(failed.log_region ?? "", /timestamp window/);
    }
  );
});

// The two clocks have different precision: the jobs API truncates completed_at to
// the second, while log lines carry sub-second stamps. An upper bound of `at <= to`
// cuts the failure output stamped within that last second.
const SUBSECOND_LOG = [
  "2026-09-18T02:43:45.1000000Z setup noise nobody asked for",
  "2026-09-18T02:43:46.8697156Z ##[group]Run npm run verify:live",
  "2026-09-18T02:43:47.4117562Z PASS  1 health + provenance",
  "2026-09-18T02:43:47.6486773Z PASS  1c backup freshness",
  // Everything below here lands after the truncated second.
  "2026-09-18T02:43:48.2975644Z PASS  2b canary client record",
  "2026-09-18T02:43:48.7756331Z PASS  2 register (fresh client)",
  "2026-09-18T02:43:48.8080189Z [TypeError: fetch failed] { [cause]: Error: read ECONNRESET }",
  "2026-09-18T02:43:48.8184600Z ##[error]Process completed with exit code 1.",
  // The next step, which must still be excluded: widening by one second must not reach it.
  "2026-09-18T02:43:50.3555580Z ##[group]Run node scripts/reap-probe-clients.mjs",
  "2026-09-18T02:43:50.8815118Z reap: deleted client but it still reads back",
  "2026-09-18T02:43:51.9000000Z Cleaning up orphan processes",
].join("\n");

const SUBSECOND_STEP = {
  name: "verify:live",
  conclusion: "failure",
  started_at: "2026-09-18T02:43:46Z",
  completed_at: "2026-09-18T02:43:48Z",
};

test("ci_status keeps the failure that lands AFTER the step's truncated completed_at", async () => {
  await withFetch(
    {
      "GET /repos/o/r/actions/runs": { body: { workflow_runs: [RUN_ROW()] } },
      "GET /repos/o/r/actions/runs/42/jobs": {
        body: { jobs: [{ id: 9, name: "live gate", conclusion: "failure", steps: [SUBSECOND_STEP] }] },
      },
      "GET /repos/o/r/actions/jobs/9/logs": { text: SUBSECOND_LOG },
    },
    async () => {
      const out = (await ciStatus(makeEnv(), "ns", undefined, { logTail: true })) as {
        failed_run: { log?: string; log_region?: string };
      };
      const body = out.failed_run.log ?? "";
      // The error is in the sub-second tail.
      assert.match(body, /ECONNRESET/, "the uncaught exception was cut off by the truncated upper bound");
      assert.match(body, /exit code 1/, "the step's own failure marker was cut off");
      assert.match(body, /PASS {2}2b canary/, "output between the truncated second and the real end was dropped");
      // Still bounded on both sides.
      assert.equal(/setup noise/.test(body), false, "output from before the step leaked in");
      assert.equal(/reap: deleted client/.test(body), false, "the NEXT step leaked in; the widening overshot");
      assert.equal(/orphan processes/.test(body), false, "post-run cleanup leaked in");
      assert.match(out.failed_run.log_region ?? "", /timestamp window/);
    }
  );
});

test("ci_status NAMES the fallback when the step has no usable window", async () => {
  // Failing to locate the step is allowed; claiming to have located it is not.
  await withFetch(
    {
      "GET /repos/o/r/actions/runs": { body: { workflow_runs: [RUN_ROW()] } },
      "GET /repos/o/r/actions/runs/42/jobs": {
        body: { jobs: [{ id: 9, name: "verify", conclusion: "failure", steps: [{ name: "Gates", conclusion: "failure" }] }] },
      },
      "GET /repos/o/r/actions/jobs/9/logs": { text: JOB_LOG },
    },
    async () => {
      const out = (await ciStatus(makeEnv(), "ns", undefined, { logTail: true })) as {
        failed_run: { log?: string; log_region?: string };
      };
      assert.match(out.failed_run.log_region ?? "", /no usable timestamp window/);
      assert.match(out.failed_run.log_region ?? "", /cleanup included/, "the fallback did not admit what it returned");
      // And it really is the whole job, cleanup and all, as it says.
      assert.match(out.failed_run.log ?? "", /orphan processes/);
    }
  );
});

test("ci_status caps the failing step's log at the budget, keeping the END", async () => {
  const marker = "DIAGNOSIS AT THE VERY END";
  const filler = Array.from({ length: 20_000 }, () => "2026-09-06T01:00:00.0Z filler").join("\n");
  const log = `2026-09-06T00:58:31.0Z start\n${filler}\n2026-09-06T01:01:52.0Z ${marker}`;
  assert.ok(log.length > CI_LOG_BUDGET, "the fixture is not larger than the budget");
  await withFetch(
    {
      "GET /repos/o/r/actions/runs": { body: { workflow_runs: [RUN_ROW()] } },
      "GET /repos/o/r/actions/runs/42/jobs": {
        body: { jobs: [{ id: 9, name: "verify", conclusion: "failure", steps: [FAILED_STEP] }] },
      },
      "GET /repos/o/r/actions/jobs/9/logs": { text: log },
    },
    async () => {
      const out = (await ciStatus(makeEnv(), "ns", undefined, { logTail: true })) as { failed_run: { log?: string; log_region?: string } };
      const body = out.failed_run.log ?? "";
      assert.ok(body.length <= CI_LOG_BUDGET, `log was ${body.length} bytes, over the ${CI_LOG_BUDGET} budget`);
      // From the END, because CI failures print their diagnosis last.
      assert.match(body, new RegExp(marker), "the budget kept the start and dropped the diagnosis");
      assert.match(out.failed_run.log_region ?? "", /last \d+ bytes/);
      assert.match(out.failed_run.log_region ?? "", /timestamp window/);
    }
  );
});

// read_repo_file batch

test("read_repo_file batch returns each file's error INDEPENDENTLY", async () => {
  await withFetch(
    {
      "GET /repos/o/r/contents/a.md": { body: fileBody("alpha") },
      "GET /repos/o/r/contents/gone.md": { status: 404, text: "Not Found" },
      "GET /repos/o/r/contents/c.md": { body: fileBody("gamma") },
    },
    async () => {
      const out = await readRepoFiles(makeEnv(), "ns", ["a.md", "gone.md", "c.md"]);
      // One missing path must not fail the batch, or the caller has to bisect.
      assert.equal(out.requested, 3);
      assert.equal(out.ok, 2);
      assert.equal(out.failed, 1);
      const byPath = new Map(out.files.map((f) => [f.path, f]));
      assert.equal((byPath.get("a.md") as { content?: string }).content, "alpha");
      assert.equal((byPath.get("c.md") as { content?: string }).content, "gamma");
      assert.match((byPath.get("gone.md") as { error?: string }).error ?? "", /404/);
    }
  );
});

test("read_repo_file batch refuses an empty or oversized paths array", async () => {
  const env = makeEnv();
  await withFetch({}, async () => {
    await assert.rejects(() => readRepoFiles(env, "ns", []), /paths was empty/);
    const tooMany = Array.from({ length: REPO_BATCH_MAX_FILES + 1 }, (_, i) => `f${i}.md`);
    await assert.rejects(() => readRepoFiles(env, "ns", tooMany), /exceeds the batch maximum/);
  });
});

test("read_repo_file batch rejects a bad path per file without a network call", async () => {
  await withFetch({ "GET /repos/o/r/contents/ok.md": { body: fileBody("fine") } }, async () => {
    const out = await readRepoFiles(makeEnv(), "ns", ["ok.md", "../escape.md", "a//b.md"]);
    assert.equal(out.ok, 1);
    assert.equal(out.failed, 2);
    const errs = out.files.filter((f) => "error" in f).map((f) => (f as { error: string }).error);
    assert.ok(errs.some((e) => /\.\./.test(e)), `no dotdot refusal in ${JSON.stringify(errs)}`);
    assert.ok(errs.some((e) => /empty segment/.test(e)), `no empty-segment refusal in ${JSON.stringify(errs)}`);
  });
});

test("read_repo_file batch truncates a file over the per-file budget and says so", async () => {
  const huge = "y".repeat(REPO_FILE_BUDGET + 5_000);
  await withFetch({ "GET /repos/o/r/contents/big.md": { body: fileBody(huge) } }, async () => {
    const out = await readRepoFiles(makeEnv(), "ns", ["big.md"]);
    const file = out.files[0] as { truncated?: boolean; content?: string };
    assert.equal(file.truncated, true, "an oversized file was not marked truncated");
    assert.equal(file.content?.length, REPO_FILE_BUDGET);
    assert.ok(out.bytes <= REPO_BATCH_MAX_FILES * REPO_FILE_BUDGET);
  });
});
