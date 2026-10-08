import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STALE_PRS_KEY,
  STALE_RESUMED_MS,
  STALE_UNCHANGED_MS,
  classifyStale,
  nextStaleCache,
  parseStaleCache,
  prsSettled,
  readStaleCache,
  tallyPrStates,
  type StalePrEntry,
} from "../src/stale-jobs.ts";
import { fakeKv } from "./fakes.ts";

// The stale view's rules (stale jobs D5) and the shape of the cache the merge-resume
// step writes for it. Each rule is driven to a row and to no row, so no rule is only
// ever seen passing. The view against a real D1 is test-integration/stale-jobs.test.ts.

const NOW = new Date("2026-10-08T06:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 60 * 60 * 1000;

function entry(over: Partial<StalePrEntry> = {}): StalePrEntry {
  return { merged: 0, closed: 0, open: 0, unread: 0, at: ago(5 * 60 * 1000), ...over };
}

test("unchanged: a blocked or claimed job untouched for 3 days is stale, and a day short of it is not", () => {
  for (const status of ["blocked", "claimed"]) {
    const old = classifyStale({ status, updated_at: ago(STALE_UNCHANGED_MS), auto_resumed_at: null }, undefined, NOW);
    assert.equal(old?.rule, "unchanged", status);
    assert.match(old?.reason ?? "", new RegExp(`^${status} and unchanged since .* \\(3 days\\)$`));
    assert.equal(classifyStale({ status, updated_at: ago(2 * 24 * HOUR), auto_resumed_at: null }, undefined, NOW), null, `${status}, 2 days`);
  }
});

test("unchanged: a queued or finished job is never stale for its age", () => {
  for (const status of ["queued", "done", "failed", "superseded"]) {
    assert.equal(classifyStale({ status, updated_at: ago(30 * 24 * HOUR), auto_resumed_at: null }, undefined, NOW), null, status);
  }
});

test("resumed-not-completed: an auto-resume 24 hours old on an unfinished job is stale; younger, or finished, is not", () => {
  for (const status of ["blocked", "claimed", "queued"]) {
    const row = classifyStale({ status, updated_at: ago(STALE_RESUMED_MS), auto_resumed_at: ago(STALE_RESUMED_MS) }, undefined, NOW);
    assert.equal(row?.rule, "resumed-not-completed", status);
    assert.match(row?.reason ?? "", /system:merge-resume .* 24 hours later$/);
  }
  assert.equal(classifyStale({ status: "claimed", updated_at: ago(23 * HOUR), auto_resumed_at: ago(23 * HOUR) }, undefined, NOW), null);
  for (const status of ["done", "failed", "superseded"]) {
    assert.equal(classifyStale({ status, updated_at: ago(48 * HOUR), auto_resumed_at: ago(48 * HOUR) }, undefined, NOW), null, status);
  }
});

test("prs-settled: a blocked job whose pull requests are all merged or closed is stale", () => {
  const job = { status: "blocked", updated_at: ago(HOUR), auto_resumed_at: null };
  const row = classifyStale(job, entry({ merged: 1, closed: 1 }), NOW);
  assert.equal(row?.rule, "prs-settled");
  assert.match(row?.reason ?? "", /1 merged, 1 closed without merging/);
  assert.equal(classifyStale(job, entry({ closed: 2 }), NOW)?.rule, "prs-settled", "all closed is settled too");
});

test("prs-settled: one open or unread pull request, no pull request at all, or a job not blocked, is not settled", () => {
  const job = { status: "blocked", updated_at: ago(HOUR), auto_resumed_at: null };
  assert.equal(classifyStale(job, entry({ merged: 1, open: 1 }), NOW), null, "one still open");
  assert.equal(classifyStale(job, entry({ merged: 1, unread: 1 }), NOW), null, "one unread");
  assert.equal(classifyStale(job, entry(), NOW), null, "all zero");
  assert.equal(classifyStale(job, undefined, NOW), null, "no entry");
  assert.equal(classifyStale({ ...job, status: "claimed" }, entry({ merged: 1 }), NOW), null, "claimed, not blocked");
});

test("prs-settled: an entry read before the job last changed is ignored", () => {
  const job = { status: "blocked", updated_at: ago(HOUR), auto_resumed_at: null };
  assert.equal(classifyStale(job, entry({ merged: 1, at: ago(2 * HOUR) }), NOW), null);
});

test("a job matching several rules is listed once, under the most actionable rule", () => {
  const job = { status: "blocked", updated_at: ago(STALE_UNCHANGED_MS), auto_resumed_at: ago(STALE_UNCHANGED_MS) };
  assert.equal(classifyStale(job, entry({ merged: 1 }), NOW)?.rule, "prs-settled");
  assert.equal(classifyStale(job, undefined, NOW)?.rule, "resumed-not-completed");
});

test("prsSettled needs nothing open, nothing unread and at least one settled", () => {
  assert.equal(prsSettled(entry({ merged: 2 })), true);
  assert.equal(prsSettled(entry({ merged: 2, open: 1 })), false);
  assert.equal(prsSettled(entry({ merged: 2, unread: 1 })), false);
  assert.equal(prsSettled(entry()), false);
  assert.equal(prsSettled(undefined), false);
});

test("the cache entry counts each state the merge-resume step read", () => {
  const at = NOW.toISOString();
  assert.deepEqual(tallyPrStates(["merged", "merged", "closed", "open", "unread"], at), { merged: 2, closed: 1, open: 1, unread: 1, at });
  assert.deepEqual(tallyPrStates([], at), { merged: 0, closed: 0, open: 0, unread: 0, at });
});

test("the next cache replaces a read job's entry and drops every job no longer blocked", () => {
  const prior = { job_a: entry({ open: 1 }), job_b: entry({ merged: 1 }), job_gone: entry({ merged: 1 }) };
  const reads = { job_a: entry({ merged: 1, at: NOW.toISOString() }), job_new: entry({ closed: 1 }) };
  const next = nextStaleCache(prior, reads, new Set(["job_a", "job_b", "job_new"]));
  assert.deepEqual(Object.keys(next).sort(), ["job_a", "job_b", "job_new"]);
  assert.deepEqual(next.job_a, reads.job_a, "this tick's read replaced the old entry");
  assert.deepEqual(next.job_b, prior.job_b, "a blocked job not read this tick keeps its entry");
  assert.equal(nextStaleCache(prior, reads, new Set()).job_a, undefined, "nothing blocked, nothing kept");
});

test("the stored cache is read back as written, and a damaged one is reported, never thrown", async () => {
  const good = { job_a: entry({ merged: 1 }) };
  assert.deepEqual(await readStaleCache(fakeKv({ seed: { [STALE_PRS_KEY]: JSON.stringify(good) } }).kv), { cache: good, problem: null });
  assert.deepEqual(await readStaleCache(fakeKv().kv), { cache: {}, problem: null }, "never written is empty");
  const notJson = await readStaleCache(fakeKv({ seed: { [STALE_PRS_KEY]: "{not json" } }).kv);
  assert.deepEqual(notJson.cache, {});
  assert.match(notJson.problem ?? "", /not JSON/);
  const mixed = parseStaleCache({ job_a: entry({ merged: 1 }), job_bad: { merged: "1" } });
  assert.deepEqual(Object.keys(mixed.cache), ["job_a"]);
  assert.match(mixed.problem ?? "", /1 entry of the wrong shape/);
  assert.match(parseStaleCache([1, 2]).problem ?? "", /not a JSON object/);
});
