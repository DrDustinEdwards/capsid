import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  OUTCOME_RESULT_KINDS,
  durationMinutes,
  outcomeFrom,
  resultKindOf,
  signalFor,
  verifyEvidence,
  type EvidenceVerdict,
} from "../src/job-outcomes.ts";
import { missingForRecord, parseMinRecord, serializeMinRecord, type JobRow } from "../src/jobs-schema.ts";
import { TABLES } from "../src/backup.ts";
import { fakeEnv, fakeKv, withFetch, type Route } from "./fakes.ts";
import { sourceFile } from "./source-files.ts";

// JOBS AS EVIDENCE: the recording half.
//
// The behavioural half is test-integration/jobs.test.ts, which drives a real
// complete against a real D1 and reads the row back: "written exactly once" is a
// property of a PRIMARY KEY and a fake would agree with whatever it was told. What is
// here is what node can check without a database: the verification rules, the
// null-not-zero rule, and the derivation of a row from a job.

const MIGRATION = readFileSync(join(import.meta.dirname, "..", "migrations", "0011_job_outcomes.sql"), "utf8");

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

// ---- the schema's own promises -------------------------------------------------

test("ONE ROW PER JOB IS THE SCHEMA'S PROMISE: the primary key is declared", () => {
  // The writer's half, ON CONFLICT DO NOTHING, is proven against SQLite in
  // test-integration/job-outcomes.test.ts: "a second insert for the same job cannot
  // overwrite the first record".
  assert.match(MIGRATION, /job_id TEXT PRIMARY KEY/, "job_id is no longer the primary key, so two rows could describe one job");
});

// That every column the writer binds exists is proven by the real insert in
// test-integration/job-outcomes.test.ts, which SQLite refuses on an unknown column.


test("the dump carries the new table, so the verified counts survive a restore", () => {
  // The pull requests these numbers were read from can be deleted on GitHub, so the
  // dump is the only copy of what was true when the job ended. test/backup.test.ts
  // derives TABLES from migrations/ in both directions; this names the one that
  // matters for this arc.
  assert.ok(TABLES.includes("job_outcomes"), "job_outcomes is not in the nightly dump");
});

// ---- what the row says about itself ---------------------------------------------

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
  // A clock that disagrees with itself is a fact about the clock. Reporting a
  // negative duration, or clamping it to 0, would both put it in the record as work.
  assert.equal(durationMinutes("2026-09-11T12:00:00.000Z", now), null);
});

test("the duration measures the final stretch, and the row says how many there were", () => {
  // `resume` resets claimed_at, so a job blocked for a day and resumed reports the
  // work after the gate rather than the wait. resumed_count is what tells a reader
  // this number omits earlier stretches, which is why both are on the row.
  const row = outcomeFrom(
    job({ claimed_at: "2026-09-11T11:00:00.000Z", blocked_count: 2, resumed_count: 2 }),
    empty(),
    new Date("2026-09-11T11:45:00.000Z")
  );
  assert.equal(row.duration_minutes, 45);
  assert.equal(row.blocked_count, 2);
  assert.equal(row.resumed_count, 2);
});

// ---- null is not zero ------------------------------------------------------------

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
  // The distinction the whole table is built on. A column that spelled "nobody
  // counted" and "the count was zero" the same way would make an average over it an
  // average over a lie.
  const verdict = await verifyEvidence(fakeEnv({}), "capsid", undefined);
  for (const field of ["prs_opened", "prs_merged", "commits", "files_changed", "tests_added", "ci_green"] as const) {
    assert.equal(verdict[field], null, `${field} came back as something other than null with no evidence`);
  }
  const row = outcomeFrom(job(), verdict, new Date("2026-09-11T11:00:00.000Z"));
  for (const field of ["prs_opened", "prs_merged", "commits", "files_changed", "tests_added", "ci_green"] as const) {
    assert.equal(row[field], null);
  }
  // And the counts the Worker knows first-hand are still there, because those it did
  // not have to be told.
  assert.equal(row.blocked_count, 0);
  assert.equal(row.agent, "agent:capsid-driver");
  assert.equal(row.namespace, "capsid");
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
  // The driver's numbers are kept. An unverified count is still better than nothing
  // on the row; what must never happen is it being PRESENTED as verified.
  assert.equal(verdict.commits, 9);
});

// ---- verification against GitHub --------------------------------------------------

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
  // The rule the arc exists for. The driver claims two commits and one file; GitHub
  // says three and five, and the row records GitHub's.
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

test("PLANT: a pull request GitHub will not answer for leaves EVERY count unverified", async () => {
  // PARTIAL VERIFICATION IS NOT VERIFICATION. One of two pull requests resolving
  // would give a merged count over a subset presented as a total, which is how a
  // count lies without anybody writing a wrong number.
  const second = "/repos/DrDustinEdwards/capsid-mcp/pulls/8";
  await withFetch(
    { [`GET ${PR_PATH}`]: prRoute(true), [`GET ${second}`]: { status: 404, text: "nope" } },
    async () => {
      const verdict = await verifyEvidence(envWithRepo(), "capsid", {
        prs: [PR_URL, "https://github.com/DrDustinEdwards/capsid-mcp/pull/8"],
        commits: 2,
      });
      assert.equal(verdict.verified.prs_opened, false);
      assert.equal(verdict.verified.prs_merged, false);
      assert.equal(verdict.verified.commits, false);
      assert.equal(verdict.commits, 2, "the driver's number survives; it is the FLAG that must not");
      assert.ok(
        verdict.notes.some((n) => /1 of 2/.test(n)),
        `the shortfall is not named in the notes: ${verdict.notes.join(" | ")}`
      );
    }
  );
});

test("a repo the namespace does not map is refused, not read", async () => {
  // The namespace-to-repos mapping is the authorization boundary. A driver that could
  // name any repo here would be using the outcome recorder as an unaudited read of
  // everything the App can reach.
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
  // Three answers, not two. Recording an in-progress run as red would libel the job,
  // and recording it as green would be worse.
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
    // The pull request counts still verified: one unanswerable question does not
    // withdraw the answers to the others.
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
  // A driver that finished its work must be able to close its job. Refusing the
  // complete would leave a lease on finished work, which is worse than an unverified
  // count, so the failure is recorded as notes and the transition goes through.
  await withFetch({}, async () => {
    const verdict = await verifyEvidence(envWithRepo(), "capsid", { prs: [PR_URL], commits: 2 });
    assert.equal(verdict.verified.commits, false);
    assert.equal(verdict.commits, 2);
    assert.ok(verdict.notes.length > 0, "an unreachable GitHub produced no note at all");
  });
});

// ---- the bar a job can set on a driver's history ---------------------------------

test("a min_record nobody set is no requirement", () => {
  assert.deepEqual(parseMinRecord(null), { ok: true, value: {} });
  assert.deepEqual(parseMinRecord(undefined), { ok: true, value: {} });
  assert.deepEqual(parseMinRecord("{}"), { ok: true, value: {} });
  assert.equal(missingForRecord({ prs_merged: 0 }, null), null);
});

test("a CORRUPT min_record refuses: it fails CLOSED", () => {
  // Reversed 2026-09-17 (AUDIT-2026-09-16.md). A garbled bar is not the same as no
  // bar; the claim marks such a job failed rather than leasing it to anyone.
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
  // And the same agent one merge later clears it, so the bar is a bar and not a wall.
  assert.equal(missingForRecord({ prs_merged: 3 }, bar), null);
  // Singular reads as English rather than as "1 merged pull requests".
  assert.match(missingForRecord({ prs_merged: 0 }, serializeMinRecord({ prs_merged: 1 }))!, /1 merged pull request\b/);
});

// scanner-rule: conventions-verification, enumerate every site: every path that hands out a lease checks the record bar
test("the claim and the resume both ask the record question", () => {
  // Enumerate every site: resume hands a caller a lease exactly as claim does, so a
  // driver that could not have claimed a job must not acquire it by resuming one.
  const source = sourceFile("jobs.ts");
  const calls = [...source.matchAll(/recordShortfall\(/g)];
  assert.ok(calls.length >= 3, `recordShortfall is called ${calls.length - 1} times; claim and resume both need it`);
  assert.match(source, /const shortfall = await recordShortfall/, "claim does not check the record bar");
  assert.match(source, /const resumeShortfall = await recordShortfall/, "resume does not check the record bar");
});

// That the record is read only when a job sets a bar is proven by counting the reads
// against SQLite in test-integration/job-outcomes.test.ts.


// ---- the skills a job was offered and used --------------------------------------
//
// REPRODUCTION, red before the fix. migration 0013 added skill_ids_offered and
// skill_ids_used to job_outcomes on 2026-09-12 and nothing has ever written them, so
// improve_status's offered-to-used rate sums NULL over every row and reports 0 of 0.
// The recommend step is judged on that gap, so the one number that says whether it
// works has never had an input.
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
  // improve_status sums json_array_length over these columns, and SUM skips NULL. A
  // job that never had a recommend step must contribute to neither total, which an
  // empty array would not do: it would count as "offered nothing", which is a
  // measurement, where NULL is the absence of one.
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

// ---- the signal is the Worker's, not the driver's -------------------------------
//
// Ruled 2026-09-16, amending 2026-09-12. A driver names which skills it was offered
// and used; the DIRECTION comes only from what this Worker verified on GitHub. These
// drive signalFor to each of its three answers, because a signal that has only been
// seen returning "win" is one nobody has verified.

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
  // The case the 2026-09-12 ruling already decided: charging a loss for a GitHub
  // outage would retire skills for being present during one.
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
