import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OUTCOME_RESULT_KINDS,
  durationMinutes,
  outcomeFrom,
  resultKindOf,
  signalFor,
  signalForRow,
  usageFromTotals,
  verifyEvidence,
  type EvidenceVerdict,
} from "../src/job-outcomes.ts";
import { missingForRecord, parseMinRecord, serializeMinRecord, type JobRow } from "../src/jobs-schema.ts";
import { reverifyPr } from "../src/outcome-prs.ts";
import { fakeEnv, fakeKv, withFetch, type Route } from "./fakes.ts";

// Job outcomes: what node can check without a database (the verification rules, the
// null-not-zero rule, and the derivation of a row from a job). "Written exactly once"
// is a PRIMARY KEY property, so test-integration/jobs.test.ts checks it on a real D1.

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "job_abc123abc123",
    namespace: "capsid",
    title: "a job",
    body: "do the thing",
    priority: 0,
    status: "done",
    posted_by: "github:DrDustinEdwards",
    claimed_by: "agent:capsid-driver",
    claimed_at: "2026-09-11T10:00:00.000Z",
    lease_expires: null,
    result_ref: null,
    result_summary: "did the thing",
    gate_required: 0,
    required_scopes: null,
    min_record: null,
    blocked_count: 0,
    corrections_count: 0,
    review_required: 0,
    resumed_count: 0,
    created_at: "2026-09-11T09:00:00.000Z",
    updated_at: "2026-09-11T11:00:00.000Z",
    ...overrides,
  };
}

// what the row says about itself

test("result_kind is derived from the result ref, not declared by the caller", () => {
  assert.equal(resultKindOf("https://github.com/o/r/pull/7"), "pr");
  assert.equal(resultKindOf("capsid/decisions.md"), "doc");
  assert.equal(resultKindOf(null), "none");
  assert.equal(resultKindOf(undefined), "none");
  assert.equal(resultKindOf(""), "none");
  for (const kind of [resultKindOf("https://x/y"), resultKindOf("a/b.md"), resultKindOf(null)]) {
    assert.ok((OUTCOME_RESULT_KINDS as readonly string[]).includes(kind));
  }
});

test("a duration that cannot be measured is null, and one that ran backwards is too", () => {
  const now = new Date("2026-09-11T11:30:00.000Z");
  assert.equal(durationMinutes("2026-09-11T10:00:00.000Z", now), 90);
  assert.equal(durationMinutes(null, now), null, "no claim timestamp is not a duration of zero");
  assert.equal(durationMinutes("not a date", now), null);
  // A negative duration, or one clamped to 0, would put a clock fault in the record as work.
  assert.equal(durationMinutes("2026-09-11T12:00:00.000Z", now), null);
});

test("the duration measures the final stretch, and the row says how many there were", () => {
  // `resume` resets claimed_at, so the duration is the work after the gate.
  // resumed_count tells a reader this number omits earlier stretches.
  const row = outcomeFrom(
    job({ claimed_at: "2026-09-11T11:00:00.000Z", blocked_count: 2, resumed_count: 2 }),
    empty(),
    new Date("2026-09-11T11:45:00.000Z")
  );
  assert.equal(row.duration_minutes, 45);
  assert.equal(row.blocked_count, 2);
  assert.equal(row.resumed_count, 2);
});

// null is not zero

function empty(): EvidenceVerdict {
  return {
    prs_opened: null,
    prs_merged: null,
    commits: null,
    files_changed: null,
    tests_added: null,
    ci_green: null,
    verified: { prs_opened: false, prs_merged: false, commits: false, files_changed: false, ci_green: false },
    notes: [],
  };
}

test("a job that reported nothing records NULL everywhere, never zero", async () => {
  // A column that spelled "nobody counted" and "the count was zero" the same way
  // would make any average over it wrong.
  const verdict = await verifyEvidence(fakeEnv({}), "capsid", undefined);
  for (const field of ["prs_opened", "prs_merged", "commits", "files_changed", "tests_added", "ci_green"] as const) {
    assert.equal(verdict[field], null, `${field} came back as something other than null with no evidence`);
  }
  const row = outcomeFrom(job(), verdict, new Date("2026-09-11T11:00:00.000Z"));
  for (const field of ["prs_opened", "prs_merged", "commits", "files_changed", "tests_added", "ci_green"] as const) {
    assert.equal(row[field], null);
  }
  // The counts the Worker knows first-hand are still there.
  assert.equal(row.blocked_count, 0);
  assert.equal(row.agent, "agent:capsid-driver");
  assert.equal(row.namespace, "capsid");
});

test("PLANT: a job with no telemetry records NULL cost, tokens and active time, never 0", () => {
  // Both ways in: no usage argument, and a session_usage read that found no row.
  for (const row of [outcomeFrom(job(), empty(), new Date("2026-09-11T11:00:00.000Z")), outcomeFrom(job(), empty(), new Date(), undefined, usageFromTotals([]))]) {
    for (const field of ["cost_usd", "tokens_input", "tokens_output", "tokens_cache_read", "tokens_cache_creation", "active_seconds"] as const) {
      assert.equal(row[field], null, `${field} is ${row[field]} for a job no telemetry reached`);
    }
  }
});

test("a job's telemetry totals land on its outcome row: summed per column, a family seen is 0 where a type is missing", () => {
  const usage = usageFromTotals([
    { metric: "claude_code.cost.usage", kind: "", total: 0.5 },
    { metric: "claude_code.cost.usage", kind: "", total: 0.25 },
    { metric: "claude_code.token.usage", kind: "input", total: 1200 },
    { metric: "claude_code.token.usage", kind: "output", total: 300.4 },
    { metric: "claude_code.token.usage", kind: "cacheRead", total: 5000 },
  ]);
  const row = outcomeFrom(job(), empty(), new Date("2026-09-11T11:00:00.000Z"), undefined, usage);
  assert.equal(row.cost_usd, 0.75);
  assert.equal(row.tokens_input, 1200);
  assert.equal(row.tokens_output, 300, "token columns are INTEGER");
  assert.equal(row.tokens_cache_read, 5000);
  // Tokens were reported, and no cacheCreation point: nothing was created.
  assert.equal(row.tokens_cache_creation, 0);
  // active_time was never reported: unknown, not zero.
  assert.equal(row.active_seconds, null);
});

test("a reported zero is stored as zero, which is a different fact", async () => {
  const verdict = await verifyEvidence(fakeEnv({}), "capsid", { tests_added: 0, commits: 0 });
  assert.equal(verdict.tests_added, 0, "a driver that counted and found none must not be recorded as silent");
  assert.equal(verdict.commits, 0);
  assert.equal(verdict.files_changed, null, "a field nobody mentioned is still null");
});

test("nothing is marked verified when nothing was checked", async () => {
  const verdict = await verifyEvidence(fakeEnv({}), "capsid", { commits: 9, files_changed: 9, tests_added: 9 });
  assert.deepEqual(verdict.verified, {
    prs_opened: false,
    prs_merged: false,
    commits: false,
    files_changed: false,
    ci_green: false,
  });
  // The driver's numbers are kept, but never presented as verified.
  assert.equal(verdict.commits, 9);
});

// verification against GitHub

const REPOS = [{ repo: "DrDustinEdwards/capsid-mcp", label: "primary" }];

function envWithRepo() {
  return fakeEnv({
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => ({ repos: JSON.stringify(REPOS) }) }) }),
    },
    APP_KV: fakeKv({ seedToken: true }).kv,
  });
}

const PR_PATH = "/repos/DrDustinEdwards/capsid-mcp/pulls/7";
const RUNS_PATH = "/repos/DrDustinEdwards/capsid-mcp/actions/runs";
const PR_URL = "https://github.com/DrDustinEdwards/capsid-mcp/pull/7";
const HEAD = "a".repeat(40);

function prRoute(merged: boolean, commits = 3, changed = 5): Route {
  return { body: { merged, commits, changed_files: changed, head: { sha: HEAD } } };
}

const greenRuns: Route = {
  body: { workflow_runs: [{ id: 1, name: "ci", head_sha: HEAD, status: "completed", conclusion: "success", event: "push", created_at: "x", html_url: "u" }] },
};

test("GITHUB'S NUMBERS REPLACE THE DRIVER'S, and only then are they marked verified", async () => {
  // The driver claims two commits and one file; GitHub says three and five, and the
  // row records GitHub's.
  await withFetch({ [`GET ${PR_PATH}`]: prRoute(true), [`GET ${RUNS_PATH}`]: greenRuns }, async () => {
    const verdict = await verifyEvidence(envWithRepo(), "capsid", { prs: [PR_URL], commits: 2, files_changed: 1, tests_added: 4 });
    assert.equal(verdict.commits, 3, "the driver's commit count was kept over GitHub's");
    assert.equal(verdict.files_changed, 5);
    assert.equal(verdict.prs_opened, 1);
    assert.equal(verdict.prs_merged, 1);
    assert.equal(verdict.ci_green, 1);
    assert.deepEqual(verdict.verified, {
      prs_opened: true,
      prs_merged: true,
      commits: true,
      files_changed: true,
      ci_green: true,
    });
    // tests_added is the one field GitHub cannot answer, so it stays the driver's
    // claim and stays unverified.
    assert.equal(verdict.tests_added, 4);
  });
});

test("an unmerged pull request is counted as opened and not as merged", async () => {
  await withFetch({ [`GET ${PR_PATH}`]: prRoute(false), [`GET ${RUNS_PATH}`]: greenRuns }, async () => {
    const verdict = await verifyEvidence(envWithRepo(), "capsid", { prs: [PR_URL] });
    assert.equal(verdict.prs_opened, 1);
    assert.equal(verdict.prs_merged, 0, "an open pull request must count as zero merged, not as unknown");
    assert.equal(verdict.verified.prs_merged, true);
  });
});

test("a pull request GitHub will not answer for leaves prs_opened, commits and files unverified", async () => {
  // A merged count over the subset read is kept and verified; the total named stays
  // unverified, so the merged count is never read as a total.
  const second = "/repos/DrDustinEdwards/capsid-mcp/pulls/8";
  await withFetch(
    { [`GET ${PR_PATH}`]: prRoute(true), [`GET ${second}`]: { status: 404, text: "nope" } },
    async () => {
      const verdict = await verifyEvidence(envWithRepo(), "capsid", {
        prs: [PR_URL, "https://github.com/DrDustinEdwards/capsid-mcp/pull/8"],
        commits: 2,
      });
      assert.equal(verdict.prs_opened, 2);
      assert.equal(verdict.verified.prs_opened, false);
      assert.equal(verdict.prs_merged, 1);
      assert.equal(verdict.verified.prs_merged, true);
      assert.equal(verdict.verified.commits, false);
      assert.equal(verdict.commits, 2, "the driver's number survives; it is the FLAG that must not");
      // The last named pull request was not read, so CI was not looked up.
      assert.equal(verdict.ci_green, null);
      assert.equal(signalFor(verdict), "environment-failure");
      assert.ok(verdict.notes.some((n) => /1 of 2/.test(n)), `the shortfall is not named in the notes: ${verdict.notes.join(" | ")}`);
    }
  );
});

test("a repo the namespace does not map is refused, not read", async () => {
  // The namespace-to-repos mapping is the authorization boundary, or the outcome
  // recorder becomes an unaudited read of everything the App can reach.
  await withFetch({}, async (calls) => {
    const verdict = await verifyEvidence(envWithRepo(), "capsid", {
      prs: ["https://github.com/someone/else/pull/1"],
    });
    assert.equal(verdict.verified.prs_opened, false);
    assert.equal(calls.length, 0, "a pull request outside the namespace's repos was fetched anyway");
    assert.ok(verdict.notes.some((n) => /not mapped to namespace/.test(n)), verdict.notes.join(" | "));
  });
});

test("CI THAT HAS NOT FINISHED IS NOT CI THAT FAILED", async () => {
  // Three answers, not two: an in-progress run is neither red nor green.
  const running: Route = {
    body: { workflow_runs: [{ id: 1, name: "ci", head_sha: HEAD, status: "in_progress", conclusion: null, event: "push", created_at: "x", html_url: "u" }] },
  };
  await withFetch({ [`GET ${PR_PATH}`]: prRoute(true), [`GET ${RUNS_PATH}`]: running }, async () => {
    const verdict = await verifyEvidence(envWithRepo(), "capsid", { prs: [PR_URL] });
    assert.equal(verdict.ci_green, null);
    assert.equal(verdict.verified.ci_green, false);
    assert.ok(verdict.notes.some((n) => /has not finished/.test(n)), verdict.notes.join(" | "));
  });
});

test("a sha with no runs is not green and not red", async () => {
  await withFetch({ [`GET ${PR_PATH}`]: prRoute(true), [`GET ${RUNS_PATH}`]: { body: { workflow_runs: [] } } }, async () => {
    const verdict = await verifyEvidence(envWithRepo(), "capsid", { prs: [PR_URL] });
    assert.equal(verdict.ci_green, null);
    assert.equal(verdict.verified.ci_green, false);
    // The pull request counts still verified.
    assert.equal(verdict.verified.prs_merged, true);
  });
});

test("a failed run is recorded as red, which is a verified fact", async () => {
  const red: Route = {
    body: { workflow_runs: [{ id: 1, name: "ci", head_sha: HEAD, status: "completed", conclusion: "failure", event: "push", created_at: "x", html_url: "u" }] },
  };
  await withFetch(
    {
      [`GET ${PR_PATH}`]: prRoute(true),
      [`GET ${RUNS_PATH}`]: red,
      [`GET ${RUNS_PATH}/1/jobs`]: { body: { jobs: [] } },
    },
    async () => {
      const verdict = await verifyEvidence(envWithRepo(), "capsid", { prs: [PR_URL] });
      assert.equal(verdict.ci_green, 0);
      assert.equal(verdict.verified.ci_green, true);
    }
  );
});

test("GITHUB BEING UNREACHABLE NEVER FAILS THE JOB", async () => {
  // Refusing the complete would leave a lease on finished work, so the failure is
  // recorded as notes and the transition goes through.
  await withFetch({}, async () => {
    const verdict = await verifyEvidence(envWithRepo(), "capsid", { prs: [PR_URL], commits: 2 });
    assert.equal(verdict.verified.commits, false);
    assert.equal(verdict.commits, 2);
    assert.ok(verdict.notes.length > 0, "an unreachable GitHub produced no note at all");
  });
});

test("PLANT: an installation token that cannot be minted is a note, not a throw (audit 2026-09-25, F1-1)", async () => {
  // No cached token and no App key, so ghFetch throws before any request. A throw here
  // would land after the job row committed and skip the outcome, audit and mirror.
  const env = fakeEnv({
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ repos: JSON.stringify(REPOS) }) }) }) },
    APP_KV: fakeKv().kv,
  });
  await withFetch({}, async () => {
    const verdict = await verifyEvidence(env, "capsid", { prs: [PR_URL], commits: 2 });
    assert.equal(verdict.verified.prs_opened, false);
    assert.equal(verdict.commits, 2);
    assert.ok(verdict.notes.some((n) => /GitHub App not configured/.test(n)), verdict.notes.join(" | "));
  });
});

test("PLANT: the re-verify sweep survives a token that cannot be minted (audit 2026-09-25, F3-11)", async () => {
  // A throw here would end the daily sweep before its stamp is written.
  const env = fakeEnv({
    DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => ({ repos: JSON.stringify(REPOS) }),
          all: async () => (/FROM job_outcome_prs/.test(sql) ? { results: [{ job_id: "job_x", merged: null }] } : { results: [] }),
        }),
      }),
      batch: async () => assert.fail("a failed read must leave every row as it was"),
    },
    APP_KV: fakeKv().kv,
  });
  await withFetch({}, async () => {
    assert.deepEqual(await reverifyPr(env, "capsid", PR_URL, new Date("2026-09-25T00:00:00Z")), []);
  });
});

// A pull request's identity (job_6092edef11e1). A URL names a number, and a recreated or
// transferred repo hands its numbers out again, so a later read by URL can land on a
// different pull request. The row pins the one it named and refuses any other.

const REPO_PATH = "/repos/DrDustinEdwards/capsid-mcp";

// A D1 stand-in for reverifyPr: the repo mapping, the join rows it selects, and every
// statement it writes, kept as SQL with its bound values.
function reverifyEnv(rows: Array<Record<string, unknown>>) {
  const written: Array<{ sql: string; args: unknown[] }> = [];
  const env = fakeEnv({
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          sql,
          args,
          first: async () => ({ repos: JSON.stringify(REPOS) }),
          all: async () => (/FROM job_outcome_prs/.test(sql) ? { results: rows } : { results: [] }),
        }),
      }),
      batch: async (statements: Array<{ sql: string; args: unknown[] }>) => {
        written.push(...statements.map((s) => ({ sql: s.sql, args: s.args })));
        return [];
      },
    },
    APP_KV: fakeKv({ seedToken: true }).kv,
  });
  return { env, written };
}

const setsMerged = (w: { sql: string }) => /SET merged/.test(w.sql);
const setsUnverifiable = (w: { sql: string }) => /SET unverifiable/.test(w.sql);

test("REPRODUCED: a pull request number now held by a different pull request does not verify", async () => {
  // Pinned to PR_old when the outcome was recorded; the number now answers as PR_new,
  // merged. Before the fix the row took the new pull request's merge state.
  const { env, written } = reverifyEnv([{ job_id: "job_x", merged: null, pr_node_id: "PR_old", named_at: "2026-09-10T00:00:00.000Z" }]);
  await withFetch({ [`GET ${PR_PATH}`]: { body: { merged: true, node_id: "PR_new", created_at: "2026-09-29T20:00:00Z" } } }, async () => {
    const out = await reverifyPr(env, "capsid", PR_URL, new Date("2026-09-30T00:00:00Z"));
    assert.deepEqual(out, [], "a pull request that is not the one the row named was reported as re-verified");
  });
  assert.equal(written.filter(setsMerged).length, 0, "the merge state of a different pull request was written");
  const marked = written.filter(setsUnverifiable);
  assert.equal(marked.length, 1);
  assert.ok(marked[0].args.includes("identity-changed"), JSON.stringify(marked[0].args));
});

test("the pull request the row pinned is re-verified as before", async () => {
  const { env, written } = reverifyEnv([{ job_id: "job_x", merged: null, pr_node_id: "PR_same", named_at: "2026-09-10T00:00:00.000Z" }]);
  await withFetch({ [`GET ${PR_PATH}`]: { body: { merged: true, node_id: "PR_same", created_at: "2026-09-09T00:00:00Z" } } }, async () => {
    const out = await reverifyPr(env, "capsid", PR_URL, new Date("2026-09-30T00:00:00Z"));
    assert.deepEqual(out, [{ job_id: "job_x", pr_url: PR_URL, merged: true, changed: true }]);
  });
  assert.equal(written.filter(setsMerged).length, 1);
  assert.equal(written.filter(setsUnverifiable).length, 0);
});

test("BACKFILL: a row with no pinned id whose repo was created after the outcome is marked recreated and not read by number", async () => {
  // The claude-skills case: recorded 2026-09-17, repo recreated 2026-09-29.
  const { env, written } = reverifyEnv([{ job_id: "job_x", merged: null, pr_node_id: null, named_at: "2026-09-17 10:00:00" }]);
  await withFetch(
    {
      [`GET ${PR_PATH}`]: { body: { merged: true, node_id: "PR_new", created_at: "2026-09-29T20:00:00Z" } },
      [`GET ${REPO_PATH}`]: { body: { created_at: "2026-09-29T19:13:35Z" } },
    },
    async () => {
      assert.deepEqual(await reverifyPr(env, "capsid", PR_URL, new Date("2026-09-30T00:00:00Z")), []);
    }
  );
  assert.equal(written.filter(setsMerged).length, 0);
  const marked = written.filter(setsUnverifiable);
  assert.equal(marked.length, 1);
  assert.ok(marked[0].args.includes("repo-recreated"), JSON.stringify(marked[0].args));
});

test("BACKFILL: a recreated repo that has not reached the number yet still marks the row, from the repo alone", async () => {
  // claude-skills today: recreated at #1, so pull/8 answers 404.
  const { env, written } = reverifyEnv([{ job_id: "job_x", merged: null, pr_node_id: null, named_at: "2026-09-17 10:00:00" }]);
  await withFetch(
    {
      [`GET ${PR_PATH}`]: { status: 404, body: { message: "Not Found" } },
      [`GET ${REPO_PATH}`]: { body: { created_at: "2026-09-29T19:13:35Z" } },
    },
    async () => {
      assert.deepEqual(await reverifyPr(env, "capsid", PR_URL, new Date("2026-09-30T00:00:00Z")), []);
    }
  );
  assert.equal(written.filter(setsMerged).length, 0);
  assert.ok(written.filter(setsUnverifiable)[0]?.args.includes("repo-recreated"), JSON.stringify(written));
});

test("a pull request that cannot be read, in a repo older than the outcome, leaves the row for the next sweep", async () => {
  const { env, written } = reverifyEnv([
    { job_id: "job_x", merged: null, pr_node_id: null, named_at: "2026-09-17T10:00:00.000Z" },
    { job_id: "job_y", merged: null, pr_node_id: "PR_pinned", named_at: "2026-09-17T10:00:00.000Z" },
  ]);
  await withFetch(
    {
      [`GET ${PR_PATH}`]: { status: 502, body: {} },
      [`GET ${REPO_PATH}`]: { body: { created_at: "2024-01-01T00:00:00Z" } },
    },
    async () => {
      assert.deepEqual(await reverifyPr(env, "capsid", PR_URL, new Date("2026-09-30T00:00:00Z")), []);
    }
  );
  assert.deepEqual(written, []);
});

test("BACKFILL: a row with no pinned id, in a repo older than the outcome, whose pull request was opened after it, is not that pull request", async () => {
  const { env, written } = reverifyEnv([{ job_id: "job_x", merged: null, pr_node_id: null, named_at: "2026-09-17T10:00:00.000Z" }]);
  await withFetch(
    {
      [`GET ${PR_PATH}`]: { body: { merged: false, node_id: "PR_later", created_at: "2026-09-20T00:00:00Z" } },
      [`GET ${REPO_PATH}`]: { body: { created_at: "2024-01-01T00:00:00Z" } },
    },
    async () => {
      assert.deepEqual(await reverifyPr(env, "capsid", PR_URL, new Date("2026-09-30T00:00:00Z")), []);
    }
  );
  assert.equal(written.filter(setsMerged).length, 0);
  assert.ok(written.filter(setsUnverifiable)[0]?.args.includes("identity-changed"));
});

test("BACKFILL: a row with no pinned id, in an unchanged repo, is pinned on this read and re-verified", async () => {
  const { env, written } = reverifyEnv([{ job_id: "job_x", merged: null, pr_node_id: null, named_at: "2026-09-17T10:00:00.000Z" }]);
  await withFetch(
    {
      [`GET ${PR_PATH}`]: { body: { merged: true, node_id: "PR_same", created_at: "2026-09-16T00:00:00Z" } },
      [`GET ${REPO_PATH}`]: { body: { created_at: "2024-01-01T00:00:00Z" } },
    },
    async () => {
      const out = await reverifyPr(env, "capsid", PR_URL, new Date("2026-09-30T00:00:00Z"));
      assert.equal(out.length, 1);
    }
  );
  const merged = written.filter(setsMerged);
  assert.equal(merged.length, 1);
  assert.ok(merged[0].args.includes("PR_same"), "the row was not pinned to the pull request it was checked against");
});

test("BACKFILL fails closed: a repo that cannot be read leaves the unpinned row as it was", async () => {
  const { env, written } = reverifyEnv([{ job_id: "job_x", merged: null, pr_node_id: null, named_at: "2026-09-17T10:00:00.000Z" }]);
  await withFetch({ [`GET ${PR_PATH}`]: { body: { merged: true, node_id: "PR_x", created_at: "2026-09-16T00:00:00Z" } } }, async () => {
    assert.deepEqual(await reverifyPr(env, "capsid", PR_URL, new Date("2026-09-30T00:00:00Z")), []);
  });
  assert.deepEqual(written, []);
});

// the bar a job can set on a driver's history

test("a min_record nobody set is no requirement", () => {
  assert.deepEqual(parseMinRecord(null), { ok: true, value: {} });
  assert.deepEqual(parseMinRecord(undefined), { ok: true, value: {} });
  assert.deepEqual(parseMinRecord("{}"), { ok: true, value: {} });
  assert.equal(missingForRecord({ prs_merged: 0 }, null), null);
});

test("a CORRUPT min_record refuses: it fails CLOSED", () => {
  // A garbled bar is not the same as no bar; the claim marks such a job failed rather
  // than leasing it to anyone.
  for (const bad of ["{", "[]", "null", '{"prs_merged":"lots"}', '{"prs_merged":-1}', '{"prs_merged":1.5}']) {
    assert.equal(parseMinRecord(bad).ok, false, `${bad} parsed as a requirement`);
    const refusal = missingForRecord({ prs_merged: 99 }, bad);
    assert.ok(refusal, `${bad} was treated as no bar`);
    assert.match(refusal, /min_record/);
  }
});

test("PLANT: an agent below the bar is refused, and the refusal names both numbers", () => {
  const bar = serializeMinRecord({ prs_merged: 3 });
  const refusal = missingForRecord({ prs_merged: 1 }, bar);
  assert.ok(refusal, "an agent with one merged pull request cleared a bar of three");
  assert.match(refusal, /at least 3 merged pull requests/);
  assert.match(refusal, /has 1/, "the refusal does not say what the agent actually has");
  // The same agent at the bar clears it.
  assert.equal(missingForRecord({ prs_merged: 3 }, bar), null);
  // Singular reads as English rather than as "1 merged pull requests".
  assert.match(missingForRecord({ prs_merged: 0 }, serializeMinRecord({ prs_merged: 1 }))!, /1 merged pull request\b/);
});

// That the claim and a resume with take both ask the record question is driven against
// a real D1 in test-integration/job-outcomes.test.ts, one plant per path.

// the skills a job was offered and used
//
// improve_status's offered-to-used rate reads skill_ids_offered and skill_ids_used, so
// the outcome row must carry them.
test("REPRO: the outcome row carries the skills the job was offered and used", () => {
  const verdict: EvidenceVerdict = {
    prs_opened: 1,
    prs_merged: 1,
    commits: 2,
    files_changed: 3,
    tests_added: null,
    ci_green: 1,
    verified: { prs_opened: true, prs_merged: true, commits: true, files_changed: true, ci_green: true },
    notes: [],
  };
  const row = outcomeFrom(job(), verdict, new Date("2026-09-11T11:00:00.000Z"), {
    offered: ["sk-a", "sk-b"],
    used: ["sk-a"],
  });
  assert.equal(row.skill_ids_offered, JSON.stringify(["sk-a", "sk-b"]));
  assert.equal(row.skill_ids_used, JSON.stringify(["sk-a"]));
});

test("NULL IS NOT AN EMPTY LIST: a job that named no skills stores null, not []", () => {
  // improve_status sums json_array_length over these columns, and SUM skips NULL. An
  // empty array would count as "offered nothing", a measurement; NULL is the absence
  // of one.
  const verdict: EvidenceVerdict = {
    prs_opened: null, prs_merged: null, commits: null, files_changed: null,
    tests_added: null, ci_green: null,
    verified: { prs_opened: false, prs_merged: false, commits: false, files_changed: false, ci_green: false },
    notes: [],
  };
  const row = outcomeFrom(job(), verdict, new Date("2026-09-11T11:00:00.000Z"));
  assert.equal(row.skill_ids_offered, null);
  assert.equal(row.skill_ids_used, null);
});

// the signal is the Worker's, not the driver's
//
// A driver names which skills it was offered and used; the direction comes only from
// what this Worker verified on GitHub. These drive signalFor to each of its three answers.

const verdictWith = (over: Partial<EvidenceVerdict>): EvidenceVerdict => ({
  prs_opened: 1,
  prs_merged: 1,
  commits: 1,
  files_changed: 1,
  tests_added: null,
  ci_green: 1,
  verified: { prs_opened: true, prs_merged: true, commits: true, files_changed: true, ci_green: true },
  notes: [],
  ...over,
});

test("A WIN NEEDS EVERY NAMED PR MERGED AND CI GREEN, both verified", () => {
  assert.equal(signalFor(verdictWith({})), "verified-success");
});

test("a named PR that did not merge is a loss, and so is red CI", () => {
  assert.equal(signalFor(verdictWith({ prs_opened: 2, prs_merged: 1 })), "verified-failure");
  assert.equal(signalFor(verdictWith({ ci_green: 0 })), "verified-failure");
});

test("UNVERIFIED EARNS NOTHING IN EITHER DIRECTION, and that is not a loss", () => {
  // Charging a loss for a GitHub outage would retire skills for being present during one.
  const unread = verdictWith({ verified: { prs_opened: false, prs_merged: false, commits: false, files_changed: false, ci_green: false } });
  assert.equal(signalFor(unread), "environment-failure");
  // CI could not be read, merge state could.
  assert.equal(
    signalFor(verdictWith({ ci_green: null, verified: { prs_opened: true, prs_merged: true, commits: true, files_changed: true, ci_green: false } })),
    "environment-failure"
  );
});

test("a job that named no pull request earns nothing, rather than a loss", () => {
  // Most jobs in this queue are research or docs and name no PR. If those counted as
  // losses, every skill would retire on the ordinary work of the portfolio.
  assert.equal(signalFor(verdictWith({ prs_opened: null, prs_merged: null, ci_green: null })), "environment-failure");
  assert.equal(signalFor(verdictWith({ prs_opened: 0, prs_merged: 0 })), "environment-failure");
});

test("signalForRow gives a stored row the answer signalFor gave its verdict", () => {
  // The evaluation cycle judges stored rows; a row and the verdict it came from must
  // never disagree.
  const cases: Array<Partial<EvidenceVerdict>> = [
    {},
    { prs_opened: 2, prs_merged: 1 },
    { ci_green: 0 },
    { prs_opened: 0 },
    { verified: { prs_opened: false, prs_merged: false, commits: false, files_changed: false, ci_green: false } },
    { ci_green: null, verified: { prs_opened: true, prs_merged: true, commits: true, files_changed: true, ci_green: false } },
  ];
  for (const over of cases) {
    const v = verdictWith(over);
    const row = { prs_opened: v.prs_opened, prs_merged: v.prs_merged, ci_green: v.ci_green, verified: JSON.stringify(v.verified) };
    assert.equal(signalForRow(row), signalFor(v), JSON.stringify(over));
  }
  // A verified column that does not parse verified nothing.
  assert.equal(signalForRow({ prs_opened: 1, prs_merged: 1, ci_green: 1, verified: "not json" }), "environment-failure");
});

// REPRODUCTION of the observed error: two readable pull requests and one in a repo
// the namespace does not map (a claude-skills PR on a capsid job). Before the fix the
// row recorded prs_merged null, ci_green null and every field unverified.
test("one unreadable pull request does not erase what the readable ones verified", async () => {
  const nine = "/repos/DrDustinEdwards/capsid-mcp/pulls/9";
  await withFetch(
    { [`GET ${PR_PATH}`]: prRoute(true, 2, 4), [`GET ${nine}`]: prRoute(true, 1, 2), [`GET ${RUNS_PATH}`]: greenRuns },
    async () => {
      const unreadable = "https://github.com/DrDustinEdwards/claude-skills/pull/17";
      const ninth = "https://github.com/DrDustinEdwards/capsid-mcp/pull/9";
      const verdict = await verifyEvidence(envWithRepo(), "capsid", { prs: [PR_URL, unreadable, ninth], commits: 7 });
      assert.equal(verdict.prs_opened, 3);
      assert.equal(verdict.verified.prs_opened, false, "a total with an unread pull request in it was marked verified");
      assert.equal(verdict.prs_merged, 2);
      assert.equal(verdict.verified.prs_merged, true);
      assert.equal(verdict.commits, 7, "a sum over some of the pull requests replaced the driver's total");
      assert.equal(verdict.verified.commits, false);
      assert.equal(verdict.ci_green, 1, "CI on the last named pull request, which was read");
      assert.equal(verdict.verified.ci_green, true);
      // Which pull requests were verified: the unread one is absent, never false.
      assert.deepEqual(verdict.pr_states, { [PR_URL]: true, [ninth]: true });
      // Partly read is not judged: neither a win nor a loss.
      assert.equal(signalFor(verdict), "environment-failure");
    }
  );
});
