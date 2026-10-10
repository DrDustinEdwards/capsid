import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OVERNIGHT_DECISION_KEY,
  OVERNIGHT_MODE_KEY,
  SUBSCRIPTION_DECISION,
  decisionFor,
  overnightState,
  setOvernight,
} from "../src/overnight.ts";
import {
  DEFAULT_BUDGET_MINUTES,
  DEFAULT_ESTIMATE_MINUTES,
  FLOOR_ESTIMATE_MINUTES,
  MIN_SAMPLES,
  buildOvernightPlan,
  chooseUsage,
  digestSinceFrom,
  estimateFromDurations,
  ineligibleReason,
  parseOvernightPolicy,
  pullRequestsIn,
  readOvernightDigest,
  readOvernightPlan,
  DEFAULT_POLICY,
  type Estimate,
  type OvernightPolicy,
  type PlanJobRow,
  type RepoOf,
} from "../src/overnight-plan.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// The overnight run's switch, plan and digest (src/overnight.ts, src/overnight-plan.ts).
// What reads a real D1 (the json_extract and the joins) is in test-integration/overnight.test.ts.

const NOW = new Date("2026-10-04T22:00:00.000Z");
const ACTOR = "access:admin@example.com";

// the switch

function envWith(seed: Record<string, string> = {}) {
  const kv = fakeKv({ seed });
  const audits: unknown[][] = [];
  const DB = {
    batch: async (statements: Array<{ params?: unknown[] }>) => {
      for (const s of statements) audits.push(s.params ?? []);
      return [];
    },
    prepare: () => ({ bind: (...params: unknown[]) => ({ params }) }),
  };
  return { env: fakeEnv({ APP_KV: kv.kv, DB }), kv, audits };
}

const RECORD = JSON.stringify(decisionFor("subscription", ACTOR, NOW, "first supervised night"));

test("the switch is off when nothing is stored", async () => {
  assert.deepEqual(await overnightState(envWith().env), { mode: "off", decision: null });
});

test("api reads as api and carries no decision; subscription carries the recorded decision", async () => {
  assert.deepEqual(await overnightState(envWith({ [OVERNIGHT_MODE_KEY]: "api" }).env), { mode: "api", decision: null });
  const sub = await overnightState(envWith({ [OVERNIGHT_MODE_KEY]: "subscription", [OVERNIGHT_DECISION_KEY]: RECORD }).env);
  assert.equal(sub.mode, "subscription");
  assert.equal(sub.decision?.decided_on, SUBSCRIPTION_DECISION.decided_on);
  assert.equal(sub.decision?.set_by, ACTOR);
});

test("PLANT: the subscription with no readable decision record reads as OFF, never as subscription", async () => {
  // The scheduler refuses to run on the subscription without the record; the state says the same.
  const original = console.error;
  console.error = () => undefined;
  try {
    for (const record of [undefined, "not json", JSON.stringify({ decided_by: "someone" }), "null"]) {
      const seed: Record<string, string> = { [OVERNIGHT_MODE_KEY]: "subscription" };
      if (record !== undefined) seed[OVERNIGHT_DECISION_KEY] = record;
      assert.deepEqual(await overnightState(envWith(seed).env), { mode: "off", decision: null }, String(record));
    }
  } finally {
    console.error = original;
  }
});

test("an unexpected stored value is off, and an unreadable KV is off", async () => {
  for (const value of ["on", "ON", "maybe", "", "api "]) {
    assert.equal((await overnightState(envWith({ [OVERNIGHT_MODE_KEY]: value }).env)).mode, "off", value);
  }
  const broken = fakeEnv({ APP_KV: { get: async () => { throw new Error("KV is down"); } } });
  const logged: string[] = [];
  const original = console.error;
  console.error = (m: unknown) => void logged.push(String(m));
  try {
    assert.deepEqual(await overnightState(broken), { mode: "off", decision: null });
  } finally {
    console.error = original;
  }
  assert.ok(logged.some((l) => l.includes("OVERNIGHT_UNREADABLE")), "an unreadable switch was not reported");
});

test("setOvernight records the subscription decision with its date and reason, audits it, and reads it back", async () => {
  const { env, kv, audits } = envWith();
  const out = await setOvernight(env, ACTOR, NOW, { value: "subscription", reason: "first supervised night" });
  assert.equal(out.mode, "subscription");
  assert.equal(out.decision?.decided_by, "Dustin Edwards");
  assert.equal(out.decision?.decided_on, "2026-10-04");
  assert.equal(out.decision?.set_at, NOW.toISOString());
  assert.equal(out.decision?.reason, "first supervised night");
  assert.equal(await kv.kv.get(OVERNIGHT_MODE_KEY), "subscription");
  assert.equal(audits.length, 1);
  assert.match(JSON.stringify(audits[0]), /overnight-set/);
  assert.match(JSON.stringify(audits[0]), /Dustin Edwards/);
});

test("PLANT: choosing api or off after the subscription deletes the record, so a later subscription records its own date", async () => {
  const { env, kv } = envWith({ [OVERNIGHT_MODE_KEY]: "subscription", [OVERNIGHT_DECISION_KEY]: RECORD });
  assert.equal((await setOvernight(env, ACTOR, NOW, { value: "api", reason: "back to the key" })).decision, null);
  assert.equal(await kv.kv.get(OVERNIGHT_DECISION_KEY), null);
  const later = new Date("2026-11-01T00:00:00.000Z");
  const again = await setOvernight(env, ACTOR, later, { value: "subscription", reason: "second look" });
  assert.equal(again.decision?.set_at, later.toISOString());
  assert.equal(again.decision?.reason, "second look");
});

test("PLANT: setOvernight refuses a bad value or a missing reason and writes nothing", async () => {
  for (const opts of [{ value: "on", reason: "x" }, { value: undefined, reason: "x" }, { value: "api", reason: "  " }, { value: "api", reason: undefined }]) {
    const { env, kv, audits } = envWith();
    await assert.rejects(setOvernight(env, ACTOR, NOW, opts), /Nothing was changed/);
    assert.equal(await kv.kv.get(OVERNIGHT_MODE_KEY), null);
    assert.deepEqual(audits, []);
  }
});

// the policy document

test("parseOvernightPolicy reads heavy, budget-minutes and estimate lines and ignores prose", () => {
  const parsed = parseOvernightPolicy(["# Overnight", "A paragraph about heavy suites.", "- heavy capsid", "- heavy foxing", "- budget-minutes 420", "- estimate capsid 45", "- an ordinary bullet"].join("\n"));
  assert.ok("policy" in parsed);
  assert.equal(parsed.policy.budget_minutes, 420);
  assert.deepEqual([...(parsed.policy.heavy as Set<string>)].sort(), ["capsid", "foxing"]);
  assert.equal(parsed.policy.estimates.get("capsid"), 45);
});

test("PLANT: a rule line that does not parse refuses the whole document, naming the line", () => {
  for (const line of ["- heavy", "- heavy a b", "- heavy Capsid", "- budget-minutes 30", "- budget-minutes 2000", "- budget-minutes abc", "- estimate capsid", "- estimate capsid 2", "- estimate capsid 9999"]) {
    const parsed = parseOvernightPolicy(`- heavy capsid\n${line}`);
    assert.ok("error" in parsed, `accepted: ${line}`);
    assert.match(parsed.error, /line 2/);
  }
});

test("a document that names no heavy repo means every repo is heavy", () => {
  const parsed = parseOvernightPolicy("- budget-minutes 300");
  assert.ok("policy" in parsed);
  assert.equal(parsed.policy.heavy, "all");
});

// the plan

const job = (id: string, namespace: string, over: Partial<PlanJobRow> = {}): PlanJobRow => ({
  id,
  namespace,
  title: `Job ${id}`,
  priority: 50,
  gate_required: 0,
  required_scopes: null,
  min_record: null,
  blocked_count: 0,
  created_at: "2026-10-04T00:00:00.000Z",
  ...over,
});
const repos = (map: Record<string, string | { problem: string }>): ReadonlyMap<string, RepoOf> =>
  new Map(Object.entries(map).map(([ns, v]) => [ns, typeof v === "string" ? { repo: v } : v]));
const flat = (minutes: number, source: Estimate["source"] = "default") => () => ({ minutes, source }) as Estimate;
const LIGHT: OvernightPolicy = { budget_minutes: 480, heavy: new Set(), estimates: new Map() };
const plan = (jobs: PlanJobRow[], over: Partial<Parameters<typeof buildOvernightPlan>[0]> = {}) =>
  buildOvernightPlan({
    jobs,
    repoOf: repos({ a: "o/a", b: "o/b" }),
    estimateOf: flat(60),
    policy: LIGHT,
    policyState: { source: "document", note: null },
    now: NOW,
    ...over,
  });

test("the plan takes gate-free jobs in priority order, then oldest first, in one lane per repo", () => {
  const out = plan([job("j1", "a", { priority: 10 }), job("j2", "a", { priority: 90 }), job("j3", "a", { priority: 90, created_at: "2026-10-03T00:00:00.000Z" })]);
  assert.equal(out.lanes.length, 1);
  assert.deepEqual(out.lanes[0].jobs.map((j) => j.id), ["j3", "j2", "j1"]);
  assert.equal(out.lanes[0].planned_minutes, 180);
  assert.equal(out.queued_read, 3);
});

test("PLANT: a job that needs a flag or a track record, or is deferred by its title, is skipped with its reason, never planned", () => {
  const out = plan([
    job("flags", "a", { required_scopes: '{"flags":["can_merge"]}' }),
    job("record", "a", { min_record: '{"prs_merged":3}' }),
    job("later", "a", { title: "LATER (after 10/6 reset): mods" }),
    job("ok", "a"),
  ]);
  assert.deepEqual(out.lanes[0].jobs.map((j) => j.id), ["ok"]);
  const why = Object.fromEntries(out.skipped.map((s) => [s.id, s.reason]));
  assert.match(why.flags, /flags a driver does not hold/);
  assert.match(why.record, /track record/);
  assert.match(why.later, /LATER/);
  assert.equal(out.skipped.length, 3);
  // The empty-object forms of the two scope columns are no requirement at all.
  assert.equal(ineligibleReason(job("x", "a", { required_scopes: "{}", min_record: "" }), repos({ a: "o/a" })), null);
});

test("PLANT: a gated job is planned and marked gated, in its priority place, and an ungated one is not marked", () => {
  // Conventions 2.3 (Dustin 2026-10-07): gates apply to risky steps, not whole jobs.
  const out = plan([job("gate", "a", { gate_required: 1, priority: 90 }), job("plain", "a", { priority: 10 })]);
  assert.deepEqual(out.lanes[0].jobs.map((j) => [j.id, j.gated]), [["gate", true], ["plain", false]]);
  assert.deepEqual(out.skipped, []);
  assert.equal(ineligibleReason(job("gate", "a", { gate_required: 1 }), repos({ a: "o/a" })), null);
});

test("a namespace with no usable repo skips its jobs and says why, corrupt mapping included", () => {
  const out = plan([job("j1", "a"), job("j2", "b")], { repoOf: repos({ a: "o/a", b: { problem: "namespace b has a CORRUPT repos mapping" } }) });
  assert.deepEqual(out.lanes.map((l) => l.repo), ["o/a"]);
  assert.match(out.skipped[0].reason, /CORRUPT repos mapping/);
});

test("jobs fill the budget in priority order; one that does not fit is skipped and a smaller later one can still go in", () => {
  const sizes: Record<string, number> = { big: 300, huge: 400, small: 60 };
  const out = plan([job("big", "a", { priority: 90 }), job("huge", "a", { priority: 80 }), job("small", "a", { priority: 70 })], {
    estimateOf: () => ({ minutes: 0, source: "default" }),
  });
  assert.equal(out.lanes[0].jobs.length, 3, "zero estimates fit trivially, as a baseline");
  const sized = buildOvernightPlan({
    jobs: [job("big", "a", { priority: 90 }), job("huge", "a", { priority: 80 }), job("small", "a", { priority: 70 })],
    repoOf: repos({ a: "o/a" }),
    estimateOf: () => ({ minutes: 0, source: "default" }),
    policy: LIGHT,
    policyState: { source: "document", note: null },
    now: NOW,
  });
  assert.ok(sized);
  const real = plan([job("big", "a", { priority: 90 }), job("huge", "a", { priority: 80 }), job("small", "a", { priority: 70 })], {
    estimateOf: (() => {
      let i = 0;
      const order = ["big", "huge", "small"];
      return () => ({ minutes: sizes[order[i++ % 3]], source: "default" }) as Estimate;
    })(),
  });
  assert.deepEqual(real.lanes[0].jobs.map((j) => j.id), ["big", "small"]);
  assert.match(real.skipped[0].reason, /does not fit: 400 minutes on top of 300 already planned/);
});

test("PLANT: two namespaces that map to one repo share one lane, so there is never a second session on that repo", () => {
  const out = plan([job("j1", "a"), job("j2", "b")], { repoOf: repos({ a: "o/shared", b: "o/shared" }) });
  assert.equal(out.lanes.length, 1);
  assert.deepEqual(out.lanes[0].namespaces.sort(), ["a", "b"]);
  assert.equal(out.lanes[0].jobs.length, 2);
});

test("light repos each get the whole night; heavy repos share one budget so their sessions can run one at a time", () => {
  const eight = (n: number) => Array.from({ length: n }, (_, i) => job(`a${i}`, "a", { priority: 100 - i }));
  const light = plan([...eight(8), ...Array.from({ length: 8 }, (_, i) => job(`b${i}`, "b", { priority: 100 - i }))]);
  assert.deepEqual(light.lanes.map((l) => l.planned_minutes), [480, 480], "two light repos, 8 hours each");
  assert.equal(light.heavy_planned_minutes, 0);
  const heavy = plan([...eight(8), ...Array.from({ length: 8 }, (_, i) => job(`b${i}`, "b", { priority: 100 - i }))], {
    policy: { budget_minutes: 480, heavy: new Set(["a", "b"]), estimates: new Map() },
  });
  assert.equal(heavy.heavy_planned_minutes, 480, "8 hours across both heavy repos, not 16");
  assert.equal(heavy.lanes.reduce((n, l) => n + l.planned_minutes, 0), 480);
  assert.ok(heavy.lanes.every((l) => l.heavy));
});

test("PLANT: with no policy every repo is treated as heavy, so the default fails toward one session at a time", () => {
  const jobs = [...Array.from({ length: 8 }, (_, i) => job(`a${i}`, "a")), ...Array.from({ length: 8 }, (_, i) => job(`b${i}`, "b"))];
  const out = plan(jobs, { policy: DEFAULT_POLICY, policyState: { source: "default", note: "no document" } });
  assert.equal(out.budget_minutes, DEFAULT_BUDGET_MINUTES);
  assert.equal(out.heavy_planned_minutes, 480);
  assert.equal(out.lanes.reduce((n, l) => n + l.planned_minutes, 0), 480);
  assert.equal(out.policy, "default");
});

test("estimateFromDurations: the p75 of unblocked jobs, floored, and null until there are enough samples", () => {
  assert.equal(estimateFromDurations([30, 40, 50, 60]), null);
  assert.equal(MIN_SAMPLES, 5);
  assert.equal(estimateFromDurations([10, 20, 30, 40, 100]), 40);
  assert.equal(estimateFromDurations([1, 2, 3, 4, 5, 6, 7, 8]), FLOOR_ESTIMATE_MINUTES);
});

// reading the plan through a stubbed D1

function planDb(opts: { jobs: PlanJobRow[]; doc: string | null; repos: Record<string, string>; durations?: Array<{ namespace: string; duration_minutes: number }> }) {
  const answer = (sql: string, params: unknown[]) => {
    if (/FROM jobs WHERE status = 'queued'/.test(sql)) return { all: opts.jobs };
    if (/FROM documents WHERE namespace/.test(sql)) return { first: opts.doc === null ? null : { body: opts.doc } };
    if (/SELECT repos FROM namespaces/.test(sql)) {
      const repo = opts.repos[String(params[0])];
      return { first: repo ? { repos: JSON.stringify([{ repo, label: "primary" }]) } : null };
    }
    if (/FROM job_outcomes WHERE blocked_count = 0/.test(sql)) return { all: opts.durations ?? [] };
    throw new Error(`stub D1 has no answer for: ${sql.slice(0, 70)}`);
  };
  return {
    prepare: (sql: string) => {
      const flat = sql.replace(/\s+/g, " ").trim();
      return {
        bind: (...params: unknown[]) => {
          const a = answer(flat, params);
          return { all: async () => ({ results: a.all ?? [] }), first: async () => a.first ?? null };
        },
      };
    },
  };
}

test("readOvernightPlan: no document is the default and says so; a bad document is ignored and says why; a good one applies", async () => {
  const jobs = [job("j1", "a")];
  const none = await readOvernightPlan(fakeEnv({ DB: planDb({ jobs, doc: null, repos: { a: "o/a" } }) }), {}, NOW);
  assert.equal(none.policy, "default");
  assert.match(none.policy_note ?? "", /every repo treated as heavy/);
  const bad = await readOvernightPlan(fakeEnv({ DB: planDb({ jobs, doc: "- heavy", repos: { a: "o/a" } }) }), {}, NOW);
  assert.equal(bad.policy, "invalid");
  assert.match(bad.policy_note ?? "", /was ignored: line 1/);
  const good = await readOvernightPlan(fakeEnv({ DB: planDb({ jobs, doc: "- heavy capsid\n- budget-minutes 300", repos: { a: "o/a" } }) }), {}, NOW);
  assert.equal(good.policy, "document");
  assert.equal(good.budget_minutes, 300);
});

test("readOvernightPlan: estimates come from the policy, then the namespace's own record, then the default; an unmapped namespace is skipped with its reason", async () => {
  const jobs = [job("j1", "a"), job("j2", "b"), job("j3", "c"), job("j4", "d")];
  const durations = [10, 20, 30, 40, 100].map((duration_minutes) => ({ namespace: "b", duration_minutes }));
  const out = await readOvernightPlan(
    fakeEnv({ DB: planDb({ jobs, doc: "- estimate a 45\n- heavy x", repos: { a: "o/a", b: "o/b", c: "o/c" }, durations }) }),
    {},
    NOW
  );
  const byId = Object.fromEntries(out.lanes.flatMap((l) => l.jobs).map((j) => [j.id, j]));
  assert.deepEqual([byId.j1.estimate_minutes, byId.j1.estimate_source], [45, "policy"]);
  assert.deepEqual([byId.j2.estimate_minutes, byId.j2.estimate_source], [40, "record"]);
  assert.deepEqual([byId.j3.estimate_minutes, byId.j3.estimate_source], [DEFAULT_ESTIMATE_MINUTES, "default"]);
  assert.match(out.skipped.find((s) => s.id === "j4")?.reason ?? "", /unknown namespace: d/);
});

test("readOvernightPlan: a named namespace sees only its own lane and skips, though the heavy budget was shared across all", async () => {
  const jobs = [job("j1", "a"), job("j2", "b")];
  const out = await readOvernightPlan(fakeEnv({ DB: planDb({ jobs, doc: "- heavy a\n- heavy b", repos: { a: "o/a", b: "o/b" } }) }), { namespace: "a" }, NOW);
  assert.equal(out.for_namespace, "a");
  assert.deepEqual(out.lanes.map((l) => l.repo), ["o/a"]);
  assert.deepEqual(out.lanes[0].jobs.map((j) => j.id), ["j1"]);
  assert.equal(out.heavy_planned_minutes, 120, "the shared budget still counted both repos");
});

// the digest

test("pullRequestsIn finds pull request URLs and nothing else, once each", () => {
  assert.deepEqual(pullRequestsIn("opened https://github.com/example/sample/pull/12 and https://github.com/example/sample/pull/12, see https://github.com/example/sample/issues/3"), ["https://github.com/example/sample/pull/12"]);
  assert.deepEqual(pullRequestsIn(null), []);
});

test("chooseUsage prefers telemetry, else the agent's report, else none; the two are never added", () => {
  const some = { cost_usd: 1, active_seconds: null, tokens_input: null, tokens_output: null, tokens_cache_read: null, tokens_cache_creation: null };
  const none = { ...some, cost_usd: null };
  assert.equal(chooseUsage(some, { ...some, cost_usd: 9 }).usage.cost_usd, 1);
  assert.equal(chooseUsage(some, undefined).source, "telemetry");
  assert.equal(chooseUsage(none, { ...some, cost_usd: 9 }).source, "reported");
  assert.equal(chooseUsage(none, undefined).source, "none");
  assert.equal(chooseUsage(none, none).source, "none");
});

test("digestSinceFrom defaults to the last 24 hours and refuses a time that is not ISO", () => {
  const d = digestSinceFrom(undefined, NOW);
  assert.ok(d.ok && d.since === "2026-10-03T22:00:00.000Z");
  const given = digestSinceFrom("2026-10-04", NOW);
  assert.ok(given.ok && given.since === "2026-10-04T00:00:00.000Z");
  for (const bad of ["yesterday", "10/04/2026", "2026-13-45"]) assert.equal(digestSinceFrom(bad, NOW).ok, false, bad);
});

function digestDb(rows: { outcomes?: object[]; blocked?: object[]; prs?: object[]; reported?: object[] }) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    db: {
      prepare: (sql: string) => {
        const flat = sql.replace(/\s+/g, " ").trim();
        return {
          bind: (...params: unknown[]) => {
            calls.push({ sql: flat, params });
            // job_claims first: the reported-usage read names blocked jobs in a subquery.
            const results = /FROM job_claims/.test(flat)
              ? rows.reported
              : /FROM job_outcomes o LEFT JOIN jobs/.test(flat)
                ? rows.outcomes
                : /FROM jobs WHERE status = 'blocked'/.test(flat)
                  ? rows.blocked
                  : /FROM job_outcome_prs/.test(flat)
                    ? rows.prs
                    : undefined;
            if (results === undefined) throw new Error(`stub D1 has no answer for: ${flat.slice(0, 70)}`);
            return { all: async () => ({ results }) };
          },
        };
      },
    },
  };
}

const outcome = (id: string, over: object = {}) => ({
  job_id: id,
  namespace: "a",
  title: `Job ${id}`,
  status: "done",
  result_kind: "pr",
  duration_minutes: 12,
  blocked_count: 0,
  cost_usd: null,
  tokens_input: null,
  tokens_output: null,
  tokens_cache_read: null,
  tokens_cache_creation: null,
  active_seconds: null,
  ...over,
});
const reportedRow = (id: string, cost: number) => ({ job_id: id, cost_usd: cost, active_seconds: 60, tokens_input: null, tokens_output: null, tokens_cache_read: null, tokens_cache_creation: null });

test("the digest lists finished jobs with usage from telemetry or the agent's report, never both, and totals each source apart", async () => {
  const { db, calls } = digestDb({
    outcomes: [outcome("t", { cost_usd: 2, active_seconds: 100 }), outcome("r"), outcome("both", { cost_usd: 5 }), outcome("n")],
    blocked: [],
    prs: [],
    reported: [reportedRow("r", 1.5), reportedRow("both", 99)],
  });
  const out = await readOvernightDigest(fakeEnv({ DB: db }), { since: "2026-10-04T00:00:00.000Z" }, NOW);
  const by = Object.fromEntries(out.finished.map((j) => [j.id, j]));
  assert.deepEqual([by.t.usage_source, by.t.usage.cost_usd], ["telemetry", 2]);
  assert.deepEqual([by.r.usage_source, by.r.usage.cost_usd], ["reported", 1.5]);
  assert.deepEqual([by.both.usage_source, by.both.usage.cost_usd], ["telemetry", 5], "the report of a job with telemetry is not added");
  assert.equal(by.n.usage_source, "none");
  assert.equal(by.n.usage.cost_usd, null, "no usage is null, not 0");
  assert.deepEqual([out.totals.telemetry.jobs, out.totals.telemetry.cost_usd], [2, 7]);
  assert.deepEqual([out.totals.reported.jobs, out.totals.reported.cost_usd], [1, 1.5]);
  assert.equal(out.totals.jobs_without_usage, 1);
  // Every read is bounded, binds its filter and does not write.
  for (const c of calls) {
    assert.ok(/LIMIT \?3/.test(c.sql), c.sql);
    assert.doesNotMatch(c.sql, /\b(INSERT|UPDATE|DELETE)\b/i);
    assert.equal(c.params[0], "2026-10-04T00:00:00.000Z");
  }
});

test("the digest names what blocked and why, with the pull requests in its summary, and ready pull requests exclude merged ones", async () => {
  const { db } = digestDb({
    outcomes: [outcome("done1")],
    blocked: [{ id: "blk", namespace: "a", title: "A blocked job", result_summary: "Opened https://github.com/example/sample/pull/7.\n\nRun this: merge it", updated_at: "2026-10-04T23:00:00.000Z" }],
    prs: [
      { job_id: "done1", namespace: "a", pr_url: "https://github.com/example/sample/pull/5", merged: 1 },
      { job_id: "done1", namespace: "a", pr_url: "https://github.com/example/sample/pull/6", merged: 0 },
      { job_id: "done1", namespace: "a", pr_url: "https://github.com/example/sample/pull/8", merged: null },
    ],
    reported: [],
  });
  const out = await readOvernightDigest(fakeEnv({ DB: db }), { since: "2026-10-04T00:00:00.000Z" }, NOW);
  assert.equal(out.blocked.length, 1);
  assert.match(out.blocked[0].summary, /Run this: merge it/);
  assert.deepEqual(out.blocked[0].pull_requests, ["https://github.com/example/sample/pull/7"]);
  assert.equal(out.pull_requests_merged, 1);
  assert.deepEqual(
    out.pull_requests_ready.map((p) => [p.url.split("/").pop(), p.state, p.source]),
    [["6", "open", "outcome"], ["8", "unchecked", "outcome"], ["7", "unchecked", "blocked summary"]]
  );
});

test("a digest read that hits its bound says so by name instead of passing as whole", async () => {
  const many = Array.from({ length: 201 }, (_, i) => outcome(`j${i}`));
  const { db } = digestDb({ outcomes: many, blocked: [], prs: [], reported: [] });
  const out = await readOvernightDigest(fakeEnv({ DB: db }), { since: "2026-10-04T00:00:00.000Z" }, NOW);
  assert.deepEqual(out.truncated, ["finished"]);
  assert.equal(out.finished.length, 200);
});
