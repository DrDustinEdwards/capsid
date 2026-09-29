import assert from "node:assert/strict";
import { test } from "node:test";
import { ROLES } from "../scripts/mint-agents.mjs";
import { allowsToolAction } from "../src/agents-schema.ts";
import { checkScope } from "../src/scope.ts";
import { anchorDriftVerdict, driftVerdict } from "../src/improve-gates.ts";
import { loopPauseReason } from "../src/improve-schema.ts";
import type { RunRow } from "../src/improve-state.ts";
import { fakeFindingMemory } from "./fakes.ts";
import { MAX_EVIDENCE, REOPEN_QUIET_MS, appendEvidence, onSighting, type EvidenceEntry, type FindingRow } from "../src/watcher-findings.ts";
import {
  BUDGET_WARN_FRACTION,
  CI_RED_HOURS,
  DEFAULT_CADENCE_MINUTES,
  MAX_FINDINGS_PER_PASS,
  WATCHER_ACTOR,
  WATCHER_CHECKS,
  cadenceMinutes,
  ciFindings,
  newestMigration,
  owningCheck,
  healthFindings,
  passDue,
  runPass,
  statusFindings,
  identityFindings,
  mirrorFindings,
  watcherAgent,
  type Finding,
  type WatcherCheck,
} from "../src/watcher.ts";

// A watcher that cannot fix anything.
//
// The checks are pure functions of what a surface said, so each is driven here
// without a Worker, a database or GitHub. The most important property is the negative
// one: a healthy surface posts nothing, or the watcher gets muted while the queue
// still looks watched.

const NOW = new Date("2026-09-12T12:00:00Z");
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();

const HEALTHY = {
  status: "ok" as const,
  sha: "1d6912efc2225d3725bfdc8ad5e6e5cae8dec63d",
  dirty: false,
  builtAt: null,
  schema_version: "0016_jobs_retry_cap.sql",
  store: { d1: "ok", fts: "ok" },
  bindings: { media: "ok", app_kv: "ok" },
  backup: { last_ok: hoursAgo(2), age_hours: 2 },
};

// the identity

test("the in-Worker watcher is the SAME authority as the mintable role, not a convenient one", () => {
  // The role a person mints and the identity the tick uses must not drift.
  const role = ROLES.find((r: (typeof ROLES)[number]) => r.name === "watcher");
  assert.ok(role);
  const agent = watcherAgent();
  assert.deepEqual(agent.scopes.tools, role.tools);
  assert.deepEqual(Object.entries(agent.scopes.flags).filter(([, on]) => on), [], "the watcher must hold no flag");
  assert.equal(agent.actor, WATCHER_ACTOR);
});

test("the watcher can post a job and cannot claim, complete or resume one", () => {
  const agent = watcherAgent();
  assert.equal(checkScope(agent, { tool: "jobs", action: "post", namespace: "capsid", grant: "write" }), null);
  for (const action of ["claim", "complete", "fail", "block", "resume", "heartbeat"]) {
    assert.match(
      String(checkScope(agent, { tool: "jobs", action, namespace: "capsid", grant: "write" })),
      new RegExp(`jobs\\.${action}`),
      `the watcher was allowed to ${action} a job`
    );
  }
  // And nothing outside the queue at all.
  assert.match(String(checkScope(agent, { tool: "write", namespace: "capsid", grant: "write" })), /not scoped to the 'write' tool/);
  assert.match(String(checkScope(agent, { tool: "manage_pr", namespace: "capsid", grant: "write" })), /not scoped to the 'manage_pr' tool/);
});

// the cadence

test("a pass is due on the first run, not due inside the cadence, and due after it", () => {
  assert.equal(passDue(null, 30, NOW).due, true);
  assert.equal(passDue(hoursAgo(0.25), 30, NOW).due, false, "15 minutes into a 30 minute cadence is not due");
  assert.equal(passDue(hoursAgo(1), 30, NOW).due, true);
});

test("a corrupt stamp RUNS the pass rather than blocking it forever", () => {
  const verdict = passDue("not a date", 30, NOW);
  assert.equal(verdict.due, true);
  assert.match(verdict.reason, /does not parse/);
});

// a healthy surface posts nothing

test("A HEALTHY SURFACE PRODUCES NO FINDING AT ALL", () => {
  // The innocent case first: every assertion below depends on it.
  assert.deepEqual(healthFindings(HEALTHY, HEALTHY.sha, HEALTHY.schema_version, "capsid"), []);
  assert.deepEqual(ciFindings("capsid", [{ head_sha: "abc1234", status: "completed", conclusion: "success", created_at: hoursAgo(9) }], NOW), []);
  assert.deepEqual(
    statusFindings(
      {
        budget: { month: "2026-09", caps: { actions_minutes_month: 300, model_usd_month: 50 }, spend: { ci_minutes: 10, cost_usd: 1 }, exceeded: false, reason: null },
        namespaces: [{ namespace: "capsid", paused: null }],
      } as never
    ),
    []
  );
});

// each check, once

test("a degraded store is a finding", () => {
  const found = healthFindings({ ...HEALTHY, status: "degraded", store: { d1: "error", fts: "ok" } }, HEALTHY.sha, HEALTHY.schema_version, "capsid");
  assert.equal(found.length, 1);
  assert.equal(found[0].fingerprint, "health-degraded");
  assert.match(found[0].body, /d1 error/, "a finding with no evidence is a rumour");
});

test("a deployed sha that is not master head is a finding", () => {
  const found = healthFindings(HEALTHY, "0360787aaaabbbbccccddddeeeeffff0011223344", HEALTHY.schema_version, "capsid");
  assert.equal(found.length, 1);
  assert.match(found[0].fingerprint, /^deploy-drift-0360787$/);
  assert.match(found[0].body, /deployed: 1d6912e/);
});

test("an UNKNOWN master sha is not drift, because that is a finding about the watcher", () => {
  assert.deepEqual(healthFindings(HEALTHY, null, HEALTHY.schema_version, "capsid"), []);
  assert.deepEqual(healthFindings({ ...HEALTHY, sha: "unknown" }, "0360787", HEALTHY.schema_version, "capsid"), []);
});

test("a backup older than the window, and one that never ran, are different findings", () => {
  const stale = healthFindings({ ...HEALTHY, backup: { last_ok: hoursAgo(30), age_hours: 30 } }, HEALTHY.sha, HEALTHY.schema_version, "capsid");
  assert.deepEqual(stale.map((f) => f.fingerprint), ["backup-stale"]);
  const never = healthFindings({ ...HEALTHY, backup: { last_ok: null, age_hours: null } }, HEALTHY.sha, HEALTHY.schema_version, "capsid");
  assert.deepEqual(never.map((f) => f.fingerprint), ["backup-never"]);
});

test("a live schema behind the newest migration is a finding", () => {
  const found = healthFindings(HEALTHY, HEALTHY.sha, "0017_something_new.sql", "capsid");
  assert.deepEqual(found.map((f) => f.fingerprint), ["schema-behind-0017_something_new.sql"]);
});

test("a PAUSE A HUMAN SET is not a finding, and one the loop set is", () => {
  // A human pausing a namespace is the system working; reporting it would teach the
  // reader to ignore the watcher.
  const report = (paused: string | null) =>
    statusFindings(
      {
        budget: { month: "2026-09", caps: { actions_minutes_month: 300, model_usd_month: 50 }, spend: { ci_minutes: 0, cost_usd: 0 }, exceeded: false, reason: null },
        namespaces: [{ namespace: "foxing", paused }],
      } as never
    );
  assert.deepEqual(report("Dustin is rewriting the scorer"), []);
  assert.deepEqual(report(null), []);
  // A human reason that happens to mention budget or drift is still a human pause.
  assert.deepEqual(report("waiting on the budget review"), []);
  assert.deepEqual(report(loopPauseReason("budget")).map((f) => f.fingerprint), ["paused-foxing"]);
  // The bare value written before the prefix existed, which may still be in KV.
  assert.deepEqual(report("budget").map((f) => f.fingerprint), ["paused-foxing"]);
});

// Derived from the gates' own reasons, not a hand-written one: neither gate's reason
// contains the word "drift".
test("a pause set by either drift gate is a finding", () => {
  const run = (attempts: number, reverts: number) => ({ ...({} as RunRow), attempts, reverts });
  const drift = driftVerdict([run(4, 4), run(4, 4), run(4, 4)]);
  const anchor = anchorDriftVerdict([{ metric: "build_passes", direction: "higher", bound: 1 }] as never, { build_passes: 1 }, { build_passes: 0.5 });
  assert.ok(drift.pause && drift.reason, "the revert-ratio gate did not pause, so this proves nothing");
  assert.ok(anchor.pause && anchor.reason, "the anchor gate did not pause, so this proves nothing");
  for (const reason of [drift.reason, anchor.reason]) {
    const found = statusFindings(
      {
        budget: { month: "2026-09", caps: {}, spend: {}, exceeded: false, reason: null },
        namespaces: [{ namespace: "foxing", paused: loopPauseReason(reason) }],
      } as never
    );
    assert.deepEqual(found.map((f) => f.fingerprint), ["paused-foxing"], `not reported: ${reason}`);
  }
});

test("a budget over the warning fraction is a finding, per cap", () => {
  const found = statusFindings(
    {
      budget: {
        month: "2026-09",
        caps: { actions_minutes_month: 300, model_usd_month: 50 },
        spend: { ci_minutes: 290, cost_usd: 45 },
        exceeded: false,
        reason: null,
      },
      namespaces: [],
    } as never
  );
  assert.deepEqual(found.map((f) => f.fingerprint).sort(), ["budget-actions_minutes_month-2026-09", "budget-model_usd_month-2026-09"]);
  // Just under the threshold is not a finding.
  const under = statusFindings(
    {
      budget: {
        month: "2026-09",
        caps: { actions_minutes_month: 100, model_usd_month: 100 },
        spend: { ci_minutes: BUDGET_WARN_FRACTION * 100 - 1, cost_usd: BUDGET_WARN_FRACTION * 100 - 1 },
        exceeded: false,
        reason: null,
      },
      namespaces: [],
    } as never
  );
  assert.deepEqual(under, []);
});

test("CI red for longer than a flake is a finding, and a fresh red is not", () => {
  const red = (hours: number) => [{ head_sha: "deadbee1234", status: "completed", conclusion: "failure", created_at: hoursAgo(hours) }];
  assert.deepEqual(ciFindings("capsid", red(CI_RED_HOURS + 1), NOW).map((f) => f.fingerprint), ["ci-red-capsid"]);
  assert.deepEqual(ciFindings("capsid", red(CI_RED_HOURS - 1), NOW), [], "a red run somebody is already fixing is not a finding");
});

test("a run still in flight is not an answer either way", () => {
  const inFlight = [{ head_sha: "deadbee1234", status: "in_progress", conclusion: null, created_at: hoursAgo(9) }];
  assert.deepEqual(ciFindings("capsid", inFlight, NOW), []);
});

// the pass

function fakeFinding(fingerprint: string, namespace = "capsid"): Finding {
  return { fingerprint, namespace, title: `Watcher: something [${fingerprint}]`, body: "evidence" };
}

function harness(found: Finding[], open: Map<string, string>) {
  const posted: Finding[] = [];
  const cleared: string[] = [];
  return {
    posted,
    cleared,
    readers: {
      findings: async () => ({ findings: found, ran: new Set(WATCHER_CHECKS) }),
      open: async () => open,
      clear: async (id: string) => {
        cleared.push(id);
        return true;
      },
      post: async (f: Finding) => {
        posted.push(f);
        return { ok: true as const, jobId: `job_${f.fingerprint}` };
      },
      memory: fakeFindingMemory().memory,
    },
  };
}

test("EACH FINDING POSTS EXACTLY ONCE, and a second pass posts nothing", async () => {
  const first = harness([fakeFinding("ci-red-abc")], new Map());
  const one = await runPass(first.readers, NOW);
  assert.deepEqual(one.posted, ["ci-red-abc"]);
  assert.equal(first.posted.length, 1);

  // The same finding, now with its job open. The queue's own duplicate rule would
  // refuse it; the pass does not even ask, so the log does not fill with refusals.
  const second = harness([fakeFinding("ci-red-abc")], new Map([["ci-red-abc", "job_1"]]));
  const two = await runPass(second.readers, NOW);
  assert.deepEqual(two.posted, []);
  assert.equal(second.posted.length, 0, "a finding already open must not be posted again");
});

test("A CLEARED FINDING CLOSES ITS JOB, and a finding still being found does not", async () => {
  const h = harness([fakeFinding("still-broken")], new Map([["still-broken", "job_1"], ["went-away", "job_2"]]));
  const result = await runPass(h.readers, NOW);
  assert.deepEqual(result.cleared, ["went-away"]);
  assert.deepEqual(h.cleared, ["job_2"], "a finding that is still being found must keep its job");
});

test("A FAILED READ DOES NOT CLEAR THE JOBS ITS CHECK OWNS", async () => {
  // improve_status and the roster CI reads failed this pass, so their findings are
  // absent. That says nothing about whether the problems went away.
  const open = new Map([["ci-red-abc1234", "job_1"], ["paused-foxing", "job_2"], ["backup-stale", "job_3"]]);
  const cleared: string[] = [];
  const result = await runPass(
    {
      findings: async () => ({ findings: [], ran: new Set(WATCHER_CHECKS.filter((c) => c !== "ci" && c !== "improve_status")) }),
      open: async () => open,
      clear: async (id) => {
        cleared.push(id);
        return true;
      },
      post: async () => ({ ok: true as const, jobId: "job_new" }),
      memory: fakeFindingMemory().memory,
    },
    NOW
  );
  assert.deepEqual(result.cleared, ["backup-stale"], "only a job whose check ran may be cleared");
  assert.deepEqual(cleared, ["job_3"]);
});

test("every fingerprint the checks produce has an owning check", () => {
  const stale = new Date(NOW.getTime() - 999 * 3_600_000);
  const all: Finding[] = [
    ...healthFindings({ ...HEALTHY, status: "degraded", backup: { last_ok: null, age_hours: 99 } }, "0360787", "0099_x.sql", "capsid"),
    ...ciFindings("germomics", [{ head_sha: "feedface99", status: "completed", conclusion: "failure", created_at: hoursAgo(9) }], NOW),
    ...statusFindings(
      {
        budget: { month: "2026-09", caps: { actions_minutes_month: 10, model_usd_month: 10 }, spend: { ci_minutes: 10, cost_usd: 10 }, exceeded: true, reason: null },
        namespaces: [{ namespace: "foxing", paused: loopPauseReason("budget") }],
      } as never
    ),
    ...mirrorFindings("capsid", null, [], NOW),
    ...mirrorFindings("capsid", stale, [], NOW),
    ...mirrorFindings("capsid", stale, [{ name: "mirror", status: "completed", conclusion: "failure" }], NOW),
    ...mirrorFindings("capsid", stale, [{ name: "mirror", status: "completed", conclusion: "success" }], NOW),
    ...identityFindings([{ namespace: "capsid", block: "a", report: "a" }], ["foxing"], []),
    ...identityFindings([{ namespace: "capsid", block: "a", report: "a" }, { namespace: "foxing", block: "b", report: "a" }], [], []),
  ];
  assert.equal(all.length, 16, `the scan produced ${all.length} findings: ${all.map((f) => f.fingerprint).join(", ")}`);
  for (const f of all) assert.ok(owningCheck(f.fingerprint), `${f.fingerprint} has no owning check, so a failed read would clear it`);
});

test("A HEALTHY PASS POSTS NOTHING AND CLOSES NOTHING", async () => {
  const h = harness([], new Map());
  const result = await runPass(h.readers, NOW);
  assert.deepEqual(result, { posted: [], cleared: [], held: [] });
});

test("clearing runs BEFORE posting, so a finding that flickers is not refused as its own duplicate", async () => {
  // If the post ran first, a finding whose job was about to be closed would be
  // refused as a duplicate of it.
  const order: string[] = [];
  await runPass(
    {
      findings: async () => ({ findings: [fakeFinding("b")], ran: new Set(WATCHER_CHECKS) }),
      open: async () => new Map([["a", "job_a"]]),
      clear: async (id) => {
        order.push(`clear:${id}`);
        return true;
      },
      post: async (f) => {
        order.push(`post:${f.fingerprint}`);
        return { ok: true as const, jobId: "job_b" };
      },
      memory: fakeFindingMemory().memory,
    },
    NOW
  );
  assert.deepEqual(order, ["clear:job_a", "post:b"]);
});

test("a pass posts at most its bound, and the rest are found again next time", async () => {
  const many = Array.from({ length: MAX_FINDINGS_PER_PASS + 5 }, (_, i) => fakeFinding(`f-${i}`));
  const h = harness(many, new Map());
  const result = await runPass(h.readers, NOW);
  assert.equal(result.posted.length, MAX_FINDINGS_PER_PASS);
});

test("a refused post is logged and does not stop the rest of the pass", async () => {
  const posted: string[] = [];
  const result = await runPass(
    {
      findings: async () => ({ findings: [fakeFinding("first"), fakeFinding("second")], ran: new Set(WATCHER_CHECKS) }),
      open: async () => new Map(),
      clear: async () => true,
      post: async (f) => {
        posted.push(f.fingerprint);
        return f.fingerprint === "first" ? { ok: false as const, refusal: "a duplicate is already open" } : { ok: true as const, jobId: "job_second" };
      },
      memory: fakeFindingMemory().memory,
    },
    NOW
  );
  assert.deepEqual(posted, ["first", "second"], "a refusal on one finding must not abandon the others");
  assert.deepEqual(result.posted, ["second"], "only what actually posted is reported as posted");
});

// The watcher's memory of a finding across jobs (src/watcher-findings.ts). The
// decision is pure and driven here; the D1 statements run in
// test-integration/watcher-findings.test.ts.

const HOUR = 3_600_000;
const later = (hours: number) => new Date(NOW.getTime() + hours * HOUR);

function findingRow(fingerprint: string, over: Partial<FindingRow> = {}): FindingRow {
  return {
    fingerprint,
    namespace: "sample",
    title: `Watcher: something [${fingerprint}]`,
    state: "open",
    job_id: "job_1",
    first_seen_at: hoursAgo(10),
    last_seen_at: hoursAgo(1),
    seen_count: 3,
    cleared_at: null,
    reopen_after: null,
    evidence: "[]",
    updated_at: hoursAgo(1),
    ...over,
  };
}

test("the quiet period is six hours", () => {
  assert.equal(REOPEN_QUIET_MS, 6 * HOUR);
});

test("a sighting's verdict, for every state a row can be in", () => {
  const superseded = { status: "superseded", result_summary: "withdrawn", updated_at: hoursAgo(1) };
  const clearedBy = (hours: number) => ({ status: "failed", result_summary: "cleared", updated_at: hoursAgo(hours) });
  const cases: Array<[string, ReturnType<typeof onSighting>["do"], ReturnType<typeof onSighting>]> = [
    ["no row, no job", "post", onSighting(null, null, null, NOW)],
    ["its job open", "bump", onSighting(findingRow("a"), "job_1", null, NOW)],
    ["an open job with no row (posted before the table)", "adopt", onSighting(null, "job_9", null, NOW)],
    ["an open job on a cleared row", "adopt", onSighting(findingRow("a", { state: "cleared", job_id: null }), "job_9", null, NOW)],
    ["an open row whose job a person superseded", "dismiss", onSighting(findingRow("a"), null, superseded, NOW)],
    ["an open row whose job was done", "dismiss", onSighting(findingRow("a"), null, { status: "done", result_summary: "fixed", updated_at: hoursAgo(1) }, NOW)],
    ["an open row whose job is gone", "dismiss", onSighting(findingRow("a"), null, null, NOW)],
    ["an open row the watcher cleared an hour ago", "quiet", onSighting(findingRow("a"), null, clearedBy(1), NOW)],
    ["an open row the watcher cleared seven hours ago", "post", onSighting(findingRow("a"), null, clearedBy(7), NOW)],
    ["an open row with no job (a refused post)", "post", onSighting(findingRow("a", { job_id: null }), null, null, NOW)],
    ["dismissed", "quiet", onSighting(findingRow("a", { state: "dismissed" }), null, null, NOW)],
    ["cleared, inside the quiet period", "quiet", onSighting(findingRow("a", { state: "cleared", reopen_after: later(1).toISOString() }), null, null, NOW)],
    ["cleared, past the quiet period", "post", onSighting(findingRow("a", { state: "cleared", reopen_after: hoursAgo(1) }), null, null, NOW)],
    ["cleared, reopen_after exactly now", "post", onSighting(findingRow("a", { state: "cleared", reopen_after: NOW.toISOString() }), null, null, NOW)],
    ["cleared, reopen_after unreadable", "post", onSighting(findingRow("a", { state: "cleared", reopen_after: "garbage" }), null, null, NOW)],
  ];
  for (const [name, want, got] of cases) assert.equal(got.do, want, name);
  assert.equal(cases.length, 15);
});

test("evidence keeps the newest MAX_EVIDENCE sightings, newest last, and restarts on a value that does not parse", () => {
  let evidence: string | null = null;
  for (let i = 0; i < MAX_EVIDENCE + 5; i++) evidence = appendEvidence("fp", evidence, { ...fakeFinding("fp"), evidence: [`sighting ${i}`] }, later(i));
  const list = JSON.parse(evidence as string) as EvidenceEntry[];
  assert.equal(list.length, MAX_EVIDENCE);
  assert.deepEqual(list[list.length - 1].lines, [`sighting ${MAX_EVIDENCE + 4}`]);
  assert.deepEqual(list[0].lines, ["sighting 5"]);
  const fresh = JSON.parse(appendEvidence("fp", "{not json", { ...fakeFinding("fp"), evidence: ["x".repeat(1000)] }, NOW)) as EvidenceEntry[];
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].lines[0].length, 300, "one evidence line is bounded");
});

test("ci-red is one incident per namespace: a new head sha is the same finding, and the sha is its evidence", () => {
  const red = (sha: string) => [{ head_sha: sha, status: "completed", conclusion: "failure", created_at: hoursAgo(CI_RED_HOURS + 1) }];
  const [a] = ciFindings("sample", red("aaaaaaa1111111"), NOW);
  const [b] = ciFindings("sample", red("bbbbbbb2222222"), NOW);
  assert.equal(a.fingerprint, "ci-red-sample");
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.title, b.title, "the title is the queue's duplicate key, so it must not move with the sha either");
  assert.ok(b.evidence?.includes("head sha: bbbbbbb2222222"), `the sha is not in the evidence: ${b.evidence?.join("; ")}`);
  assert.notEqual(ciFindings("capsid", red("aaaaaaa1111111"), NOW)[0].fingerprint, a.fingerprint, "two namespaces' red branches are two incidents");
});

function memoryPass(found: Finding[], open: Map<string, string>, memory: ReturnType<typeof fakeFindingMemory>, now: Date, ran: ReadonlySet<WatcherCheck> = new Set(WATCHER_CHECKS)) {
  const posted: string[] = [];
  const closed: string[] = [];
  const result = runPass(
    {
      findings: async () => ({ findings: found, ran }),
      open: async () => open,
      clear: async (id) => {
        closed.push(id);
        return true;
      },
      post: async (f) => {
        posted.push(f.fingerprint);
        return { ok: true as const, jobId: `job_new_${f.fingerprint}` };
      },
      memory: memory.memory,
    },
    now
  );
  return { result, posted, closed };
}

test("A FINDING A PERSON ENDED IS NOT FILED AGAIN until it has cleared and stayed quiet", async () => {
  const fp = "site-map-drift-add-sample";
  const mem = fakeFindingMemory([findingRow(fp, { job_id: "job_1" })], { job_1: { status: "superseded", result_summary: "withdrawn", updated_at: hoursAgo(1) } });

  // Still seen after the seat superseded its job: dismissed, not posted.
  const one = memoryPass([fakeFinding(fp)], new Map(), mem, NOW);
  assert.deepEqual((await one.result).posted, []);
  assert.deepEqual((await one.result).held, [fp]);
  assert.equal(mem.rows.get(fp)?.state, "dismissed");
  assert.equal(mem.rows.get(fp)?.seen_count, 4, "the sighting is counted");

  // Seen again: still dismissed, still not posted.
  assert.deepEqual((await memoryPass([fakeFinding(fp)], new Map(), mem, later(1)).result).posted, []);

  // The drift is fixed: cleared, quiet for six hours from now.
  await memoryPass([], new Map(), mem, later(2)).result;
  assert.equal(mem.rows.get(fp)?.state, "cleared");
  assert.equal(mem.rows.get(fp)?.reopen_after, new Date(later(2).getTime() + REOPEN_QUIET_MS).toISOString());

  // It flaps back inside the quiet period: counted, not posted.
  assert.deepEqual((await memoryPass([fakeFinding(fp)], new Map(), mem, later(3)).result).posted, []);
  assert.equal(mem.rows.get(fp)?.state, "cleared");

  // Seen after the quiet period: a recurrence, filed once, and the row is open on the new job.
  assert.deepEqual((await memoryPass([fakeFinding(fp)], new Map(), mem, later(9)).result).posted, [fp]);
  assert.equal(mem.rows.get(fp)?.state, "open");
  assert.equal(mem.rows.get(fp)?.job_id, `job_new_${fp}`);
  assert.equal(mem.rows.get(fp)?.reopen_after, null);
});

test("a cleared row is not cleared again each pass, so its quiet period does not slide forever", async () => {
  const fp = "backup-stale";
  const mem = fakeFindingMemory([findingRow(fp, { state: "cleared", cleared_at: hoursAgo(7), reopen_after: hoursAgo(1) })]);
  await memoryPass([], new Map(), mem, NOW).result;
  assert.deepEqual(mem.writes, [], "a cleared row that is still clear was written");
  assert.deepEqual((await memoryPass([fakeFinding(fp)], new Map(), mem, NOW).result).posted, [fp]);
});

test("a finding whose check did not run is neither cleared nor dismissed", async () => {
  const mem = fakeFindingMemory([findingRow("ci-red-sample", { state: "dismissed" }), findingRow("backup-stale", { job_id: "job_2" })]);
  const pass = memoryPass([], new Map([["backup-stale", "job_2"]]), mem, NOW, new Set(WATCHER_CHECKS.filter((c) => c !== "ci")));
  await pass.result;
  assert.equal(mem.rows.get("ci-red-sample")?.state, "dismissed", "a failed CI read cleared a dismissed incident");
  assert.equal(mem.rows.get("backup-stale")?.state, "cleared");
  assert.deepEqual(pass.closed, ["job_2"]);
});

test("an open job with no row, posted before the table existed, is adopted rather than filed again", async () => {
  const mem = fakeFindingMemory();
  const pass = memoryPass([fakeFinding("backup-stale")], new Map([["backup-stale", "job_legacy"]]), mem, NOW);
  assert.deepEqual((await pass.result).posted, []);
  assert.equal(mem.rows.get("backup-stale")?.state, "open");
  assert.equal(mem.rows.get("backup-stale")?.job_id, "job_legacy");
});

test("the bound counts posts, so findings already open do not use it up", async () => {
  const already = Array.from({ length: MAX_FINDINGS_PER_PASS }, (_, i) => fakeFinding(`old-${i}`));
  const open = new Map(already.map((f, i) => [f.fingerprint, `job_${i}`]));
  const pass = memoryPass([...already, fakeFinding("new-a"), fakeFinding("new-b")], open, fakeFindingMemory(), NOW);
  assert.deepEqual((await pass.result).posted, ["new-a", "new-b"]);
});

test("the fingerprint round-trips through the title, which is what deduplicates", () => {
  // The title is the dedup key, so a fingerprint that cannot be read back out of it
  // would post the same finding every pass.
  const f = healthFindings({ ...HEALTHY, status: "degraded" }, HEALTHY.sha, HEALTHY.schema_version, "capsid")[0];
  const match = /\[([^\]]+)\]\s*$/.exec(f.title);
  assert.ok(match, `no fingerprint in '${f.title}'`);
  assert.equal(match[1], f.fingerprint);
});

test("DERIVED: every finding this module can produce carries a readable fingerprint", () => {
  const all: Finding[] = [
    ...healthFindings({ ...HEALTHY, status: "degraded", backup: { last_ok: null, age_hours: null } }, "0360787", "0099_x.sql", "capsid"),
    ...ciFindings("germomics", [{ head_sha: "feedface99", status: "completed", conclusion: "failure", created_at: hoursAgo(9) }], NOW),
  ];
  assert.ok(all.length >= 5, `the scan produced only ${all.length} findings; it is reading nothing`);
  for (const f of all) {
    const match = /\[([^\]]+)\]\s*$/.exec(f.title);
    assert.ok(match, `no fingerprint in '${f.title}'`);
    assert.equal(match[1], f.fingerprint);
    assert.ok(f.namespace.length > 0, "a finding with no namespace has nowhere to be posted");
    assert.match(f.body, /Evidence/, "a finding with no evidence section is a rumour");
  }
});

test("allowsToolAction is what makes the watcher's narrowing real", () => {
  const agent = watcherAgent();
  assert.equal(allowsToolAction(agent.scopes.tools, "jobs", "post"), true);
  assert.equal(allowsToolAction(agent.scopes.tools, "jobs", "claim"), false);
});

// The pieces the pass is built from, exported because they carry rules worth
// guarding; this file is their caller for the dead-export check.

test("an unset, unusable or unreadable cadence falls back to the default", async () => {
  const env = (get: () => Promise<string | null>) => ({ APP_KV: { get } }) as never;
  assert.equal(await cadenceMinutes(env(async () => null)), DEFAULT_CADENCE_MINUTES);
  assert.equal(await cadenceMinutes(env(async () => "0")), DEFAULT_CADENCE_MINUTES, "zero would run every check on every tick");
  assert.equal(await cadenceMinutes(env(async () => "-5")), DEFAULT_CADENCE_MINUTES);
  assert.equal(await cadenceMinutes(env(async () => "not a number")), DEFAULT_CADENCE_MINUTES);
  assert.equal(
    await cadenceMinutes(
      env(async () => {
        throw new Error("KV is down");
      })
    ),
    DEFAULT_CADENCE_MINUTES,
    "an unreadable store must fall back to the safe value, not to whatever was last in memory"
  );
  // And a usable value IS obeyed, so the fallback is a floor rather than a ceiling.
  assert.equal(await cadenceMinutes(env(async () => "120")), 120);
  assert.equal(await cadenceMinutes(env(async () => "7.9")), 7, "a fractional cadence floors rather than being refused");
});

test("newestMigration takes the last by name, and ignores what is not a migration", () => {
  assert.equal(newestMigration(["0001_init.sql", "0016_jobs_retry_cap.sql", "0002_links.sql"]), "0016_jobs_retry_cap.sql");
  assert.equal(newestMigration(["README.md"]), null);
  assert.equal(newestMigration([]), null);
});

// openWatcherFingerprints and clearFinding are driven against seeded
// jobs rows on a real D1 in test-integration/watcher.test.ts.
