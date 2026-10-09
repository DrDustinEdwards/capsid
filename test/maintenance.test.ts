import assert from "node:assert/strict";
import { test } from "node:test";
import { laterPassed, namesPullRequest, promisesFollowUps } from "../src/maintenance.ts";
import { gatherPrItems, greenAwaitingSeat, redTooLong, type OpenPr, type PrCheck, type PrReaders } from "../src/maintenance-prs.ts";
import { BRANCH_KEEP_KEY, gatherBranchItems, githubBranchReaders, PRUNE_AUDIT_ACTION, PRUNE_CAP, PRUNE_SWITCH_KEY, type BranchReaders } from "../src/maintenance-branches.ts";
import type { Env } from "../src/env.ts";
import { fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// The daily maintenance pass's pure rules (job_549550d73d4e). Each rule is seen firing on a
// planted case and staying quiet on a clean one. The queries that feed them run against a
// real D1 in test-integration/maintenance.test.ts.

test("a queued LATER job is listed once its date has passed, and not before", () => {
  const jobs = [
    { id: "job_a", namespace: "sample", title: "LATER 2026-10-01: move the cron" },
    { id: "job_b", namespace: "sample", title: "LATER (after 2026-12-01) rename the tool" },
    { id: "job_c", namespace: "sample", title: "Ordinary job with a date 2026-01-01 in it" },
  ];
  const items = laterPassed(jobs, "2026-10-08");
  assert.deepEqual(items.map((i) => i.job), ["job_a"]);
  assert.equal(items[0].rule, "later-passed");
  assert.match(items[0].line, /LATER 2026-10-01/);
  assert.deepEqual(laterPassed(jobs, "2026-09-30"), [], "nothing is stale before the earliest date");
});

test("a pull request URL matches as a whole number, never as the prefix of a longer one", () => {
  const url = "https://github.com/example-org/sample/pull/1";
  assert.equal(namesPullRequest(`see ${url} for the change`, url), true);
  assert.equal(namesPullRequest(`see ${url}`, url), true, "at the end of the text");
  assert.equal(namesPullRequest("see https://github.com/example-org/sample/pull/12", url), false);
  assert.equal(namesPullRequest("see https://github.com/example-org/sample/pull/12 and https://github.com/example-org/sample/pull/1.", url), true, "a later whole match still counts");
  assert.equal(namesPullRequest("no link here", url), false);
});

test("a promise of follow-up jobs is recognised in the ways drivers write it", () => {
  assert.equal(promisesFollowUps("Piece 1 done. The rest will follow as separate jobs."), true);
  assert.equal(promisesFollowUps("Follow-ups to be posted as separate job after the merge"), true);
  assert.equal(promisesFollowUps("Done. Nothing further."), false);
  assert.equal(promisesFollowUps("A separate job covers the audit."), false, "a separate job without a promise of follow-ups");
  assert.equal(promisesFollowUps(null), false);
});

// The pull request rules (piece 2). A fake reader stands in for GitHub; the real readers
// make the auto-merge tick's reads (src/maintenance-prs.ts).

const NOW = new Date("2026-10-08T12:00:00.000Z");
const check = (over: Partial<PrCheck> = {}): PrCheck => ({
  id: 1, name: "test", status: "completed", conclusion: "success", completed_at: "2026-10-08T10:00:00.000Z", actions: true, ...over,
});
const pr = (number: number, over: Partial<OpenPr> = {}): OpenPr => ({
  number, url: `https://github.com/example-org/sample/pull/${number}`, draft: false,
  created_at: "2026-10-05T12:00:00.000Z", job: "job_000000000001", checks: [check()], ...over,
});
const readers = (prs: OpenPr[], step: { step: string | null; problem: string | null } = { step: "Run unit tests", problem: null }): PrReaders => ({
  openPrs: async () => ({ repo: "example-org/sample", prs, problem: null }),
  failingStep: async () => step,
});

test("a green driver pull request is listed with its age, and a red, pending, draft or job-less one is not", () => {
  const prs = [
    pr(1),
    pr(2, { checks: [check({ conclusion: "failure" })] }),
    pr(3, { checks: [check({ status: "in_progress", conclusion: null })] }),
    pr(4, { draft: true }),
    pr(5, { job: null }),
    pr(6, { checks: [] }),
  ];
  const items = greenAwaitingSeat("sample", prs, NOW);
  assert.deepEqual(items.map((i) => i.pr), [prs[0].url]);
  assert.equal(items[0].rule, "pr-awaiting-seat");
  assert.equal(items[0].job, "job_000000000001");
  assert.match(items[0].line, /open 3\.0 days/);
  assert.deepEqual(greenAwaitingSeat("sample", prs.slice(1), NOW), [], "no green driver pull request, nothing listed");
});

test("a pull request red for more than 48 hours is listed from its first failure, and a newer red one is not", () => {
  const old = pr(7, { job: null, checks: [check({ name: "lint", conclusion: "failure", completed_at: "2026-10-06T08:00:00.000Z" }), check({ name: "test", conclusion: "failure", completed_at: "2026-10-05T08:00:00.000Z" })] });
  const fresh = pr(8, { checks: [check({ conclusion: "failure", completed_at: "2026-10-07T08:00:00.000Z" })] });
  const green = pr(9);
  const red = redTooLong([old, fresh, green], NOW);
  assert.deepEqual(red.map((r) => r.pr.number), [7]);
  assert.equal(red[0].check.name, "test", "the earliest failure is when it went red");
  assert.equal(red[0].since, "2026-10-05T08:00:00.000Z");
  assert.deepEqual(redTooLong([fresh, green], NOW), []);
});

test("the gathered list names the failing step, counts what it read, and stays quiet on a clean repo", async () => {
  const red = pr(7, { checks: [check({ conclusion: "failure", completed_at: "2026-10-05T08:00:00.000Z" })] });
  const got = await gatherPrItems(["sample"], readers([red, pr(9)]), NOW);
  assert.deepEqual(got.items.map((i) => i.rule).sort(), ["pr-awaiting-seat", "pr-red"]);
  assert.match(got.items.find((i) => i.rule === "pr-red")!.line, /red for 3\.2 days: "test" failed at step "Run unit tests"/);
  assert.deepEqual(got.read, { sample: 2 });

  const clean = await gatherPrItems(["sample"], readers([pr(9, { job: null })]), NOW);
  assert.deepEqual(clean.items, []);
  assert.deepEqual(clean.read, { sample: 1 }, "quiet with one pull request read, not quiet on nothing read");

  const unread = await gatherPrItems(["sample"], readers([red], { step: null, problem: "the job read returned 404" }), NOW);
  assert.match(unread.items[0].line, /its step was not read \(the job read returned 404\)/);
});

test("a GitHub read that fails is listed as not checked, never read as clean", async () => {
  const throwing: PrReaders = { openPrs: async () => { throw new Error("GitHub answered 502"); }, failingStep: async () => ({ step: null, problem: null }) };
  const failed = await gatherPrItems(["sample"], throwing, NOW);
  assert.deepEqual(failed.items.map((i) => i.rule), ["prs-not-checked"]);
  assert.match(failed.items[0].line, /GitHub answered 502/);
  assert.deepEqual(failed.read, {}, "a namespace not read has no count");

  const partial: PrReaders = { openPrs: async () => ({ repo: "example-org/sample", prs: [], problem: "#3 check runs: page 1 returned 500" }), failingStep: async () => ({ step: null, problem: null }) };
  const part = await gatherPrItems(["sample"], partial, NOW);
  assert.deepEqual(part.items.map((i) => i.rule), ["prs-not-checked"]);
  assert.match(part.items[0].line, /#3 check runs/);
});

// The branch rules (piece 3). GitHub is faked at fetch, so delete_branch merged's own plan
// and delete step (src/github/prune.ts) run unchanged: what the tool refuses, the pass
// refuses.

const ONE_REPO = [{ repo: "o/r", label: "primary" }];
const SAME_REPO = { full_name: "o/r" };
const ghPr = (number: number, ref: string, sha: string, state = "closed", merged = true) => ({
  number, state, merged_at: state === "closed" && merged ? "2026-09-01T00:00:00Z" : null, head: { ref, sha, repo: SAME_REPO },
});
const BRANCHES = [
  { name: "main", commit: { sha: "m1" } },
  { name: "feat/merged-clean", commit: { sha: "a1" } },
  { name: "review/grok", commit: { sha: "k1" } },
  { name: "review/colour-audit", commit: { sha: "k2" } },
  { name: "feat/reopened", commit: { sha: "z1" } },
  { name: "feat/open-old", commit: { sha: "o1" } },
  { name: "feat/old-orphan", commit: { sha: "n1" } },
  { name: "feat/new-orphan", commit: { sha: "n2" } },
];
// feat/reopened merged as #3 and was opened again as #4 from the same tip: its newest pull
// request is open, so it is not pruned even though a merged one names its tip.
const OPEN = [ghPr(4, "feat/reopened", "z1", "open"), ghPr(5, "feat/open-old", "o1", "open")];
const CLOSED = [ghPr(1, "feat/merged-clean", "a1"), ghPr(2, "review/grok", "k1"), ghPr(3, "feat/reopened", "z1")];
const COMMITTED: Record<string, string> = {
  m1: "2026-10-08T00:00:00Z", a1: "2026-08-01T00:00:00Z", k1: "2026-08-01T00:00:00Z", k2: "2026-08-01T00:00:00Z",
  z1: "2026-08-01T00:00:00Z", o1: "2026-08-01T00:00:00Z", n1: "2026-08-30T12:00:00Z", n2: "2026-10-01T00:00:00Z",
};
const KEEP = JSON.stringify({ sample: ["review/grok", "review/colour-audit"] });

function branchRoutes(branches = BRANCHES) {
  const r: Record<string, unknown> = {
    "GET /repos/o/r": { body: { default_branch: "main" } },
    "GET /repos/o/r/branches": { body: branches },
    "GET /repos/o/r/pulls": (_b: unknown, p: URLSearchParams) => ({ body: p.get("state") === "open" ? OPEN : CLOSED }),
  };
  for (const b of branches) {
    r[`GET /repos/o/r/git/ref/heads/${b.name}`] = { body: { object: { sha: b.commit.sha } } };
    r[`DELETE /repos/o/r/git/refs/heads/${b.name}`] = { status: 204, text: "" };
    r[`GET /repos/o/r/commits/${b.commit.sha}`] = { body: { commit: { committer: { date: COMMITTED[b.commit.sha] } } } };
  }
  return r as never;
}

function branchEnv(seed: Record<string, string>) {
  const audits: unknown[][] = [];
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => ({ repos: JSON.stringify(ONE_REPO) }),
        run: async () => {
          if (sql.includes("audit_log")) audits.push(args);
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
  return { env: fakeEnv({ DB, APP_KV: fakeKv({ seedToken: true, seed }).kv }) as Env, audits };
}

const deletes = (calls: Array<{ method: string; path: string }>) =>
  calls.filter((c) => c.method === "DELETE").map((c) => c.path.replace("/repos/o/r/git/refs/heads/", ""));
const lines = (items: Array<{ rule: string; line: string }>, rule: string) => items.filter((i) => i.rule === rule).map((i) => i.line);

test("with the auto-prune off, a merged branch is listed with a count and nothing is deleted", async () => {
  await withFetch(branchRoutes(), async (calls) => {
    const { env, audits } = branchEnv({ [BRANCH_KEEP_KEY]: KEEP });
    const got = await gatherBranchItems(env, ["sample"], githubBranchReaders(env), NOW);
    assert.deepEqual(deletes(calls), [], "the switch is off: nothing is deleted");
    assert.equal(audits.length, 0);
    const merged = lines(got.items, "branch-merged");
    assert.equal(merged.length, 2);
    assert.match(merged[0], /branch feat\/merged-clean is merged \(pull request #1, tip a1\)/);
    assert.match(merged[1], /^1 merged branch\(es\) in o\/r would be pruned; the auto-prune is off/);
    // Old, with no open pull request, not merged by the rule: listed with its age. A
    // keep-listed, open, merged or recent branch is not.
    const stale = lines(got.items, "branch-stale");
    assert.equal(stale.length, 1);
    assert.match(stale[0], /branch feat\/old-orphan has had no commit for 39 days \(no pull request\)/);
    assert.deepEqual(got.read, { sample: 8 });
    assert.equal(got.items.length, 3);
  });
});

test("with the auto-prune on, the merged branch is deleted and audit-logged, and a keep-listed or open one is not", async () => {
  await withFetch(branchRoutes(), async (calls) => {
    const { env, audits } = branchEnv({ [PRUNE_SWITCH_KEY]: "on", [BRANCH_KEEP_KEY]: KEEP });
    const got = await gatherBranchItems(env, ["sample"], githubBranchReaders(env), NOW);
    assert.deepEqual(deletes(calls), ["feat/merged-clean"], "never the default, a keep-listed branch, or one whose newest pull request is open");
    assert.equal(got.pruned, 1);
    assert.equal(audits.length, 1);
    assert.equal(audits[0][1], PRUNE_AUDIT_ACTION);
    assert.deepEqual(JSON.parse(audits[0][4] as string), { repo: "o/r", branch: "feat/merged-clean", sha: "a1", pr: 1 });
    assert.match(lines(got.items, "branch-pruned")[0], /git push origin a1:refs\/heads\/feat\/merged-clean/);
    assert.deepEqual(lines(got.items, "branch-merged"), []);
  });
});

test("the pass deletes at most 25 merged branches per repo per run and says how many wait", async () => {
  const caps: number[] = [];
  const many = Array.from({ length: 30 }, (_, i) => ({ branch: `feat/m${i}`, sha: `s${i}`, pr: i + 1 }));
  const plan = { owner: "o", name: "r", repo: "o/r", defaultBranch: "main", branchesRead: 31, listsComplete: true, openComplete: true, prune: many, kept: [] };
  const fake: BranchReaders = {
    plan: async () => plan,
    committedAt: async () => "2026-10-08T00:00:00Z",
    prune: async (p, cap, onDeleted) => {
      caps.push(cap);
      for (const c of p.prune.slice(0, cap)) await onDeleted(c);
      return { deleted: p.prune.slice(0, cap), skipped: [], remaining: p.prune.length - cap };
    },
  };
  const { env, audits } = branchEnv({ [PRUNE_SWITCH_KEY]: "on" });
  const got = await gatherBranchItems(env, ["sample"], fake, NOW);
  assert.deepEqual(caps, [PRUNE_CAP]);
  assert.equal(PRUNE_CAP, 25);
  assert.equal(audits.length, 25, "one audit row per delete");
  assert.match(lines(got.items, "branch-merged")[0], /^5 more merged branch\(es\) in o\/r wait for the next run/);
});

test("a failed branch read or an unreadable keep list is listed as not checked, and a clean repo stays quiet", async () => {
  await withFetch({ "GET /repos/o/r": { status: 502, text: "bad gateway" } } as never, async (calls) => {
    const { env } = branchEnv({ [PRUNE_SWITCH_KEY]: "on" });
    const got = await gatherBranchItems(env, ["sample"], githubBranchReaders(env), NOW);
    assert.deepEqual(got.items.map((i) => i.rule), ["branches-not-checked"]);
    assert.deepEqual(got.read, {}, "a namespace not read has no count");
    assert.deepEqual(deletes(calls), []);
  });

  await withFetch(branchRoutes(), async (calls) => {
    const { env } = branchEnv({ [PRUNE_SWITCH_KEY]: "on", [BRANCH_KEEP_KEY]: '["review/grok"]' });
    const got = await gatherBranchItems(env, ["sample"], githubBranchReaders(env), NOW);
    assert.deepEqual(got.items.map((i) => i.rule), ["branches-not-checked"]);
    assert.match(got.items[0].line, /keep list could not be read/);
    assert.deepEqual(deletes(calls), [], "no prune without a keep list that was read");
  });

  await withFetch(branchRoutes([BRANCHES[0], BRANCHES[7]]), async () => {
    const { env } = branchEnv({});
    const got = await gatherBranchItems(env, ["sample"], githubBranchReaders(env), NOW);
    assert.deepEqual(got.items, []);
    assert.deepEqual(got.read, { sample: 2 }, "quiet with two branches read, not quiet on nothing read");
  });
});
