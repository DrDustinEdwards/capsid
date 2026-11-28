import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fakeFindingMemory } from "./fakes.ts";
import {
  MAX_EVIDENCE,
  REOPEN_QUIET_MS,
  appendEvidence,
  onSighting,
  type EvidenceEntry,
  type FindingRow,
} from "../src/watcher-findings.ts";
import { passDue } from "../src/watcher.ts";
import { runPass } from "../src/watcher-pass.ts";
import { readHealth } from "../src/site-watch.ts";
import { MAX_HEALTH_BYTES } from "../src/ops-snapshot.ts";
import { newestMigration } from "../src/watcher-gather-platform.ts";
import { WATCHER_CHECKS, owningCheck, type WatcherCheck } from "../src/watcher-checks.ts";
import {
  DEPLOY_SETTLE_MINUTES,
  MASTER_CI_WORKFLOW,
  deployVerdict,
  ciFindings,
  healthFindings,
  type Finding,
  CI_RED_HOURS,
} from "../src/watcher-detect.ts";
import {
  offaccountFindings,
  offaccountDrillFindings,
  offaccountCoverageFindings,
} from "../src/watcher-offaccount.ts";

// A watcher that cannot fix anything.
//
// The checks are pure functions of what a surface said, so each is driven here
// without a Worker, a database or GitHub. The most important property is the negative
// one: a healthy surface records nothing, or the watcher gets muted while the surface
// still looks watched.

const NOW = new Date("2026-09-12T12:00:00Z");
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();

const HEALTHY = {
  status: "ok" as const,
  sha: "1d6912efc2225d3725bfdc8ad5e6e5cae8dec63d",
  schema_version: "0016_jobs_retry_cap.sql",
  store: { d1: "ok", fts: "ok" },
  bindings: { media: "ok", app_kv: "ok" },
  backup: { last_ok: hoursAgo(2), age_hours: 2 },
};

// the cadence

test("a pass is due on the first run, not inside the cadence, due after it, and a corrupt stamp RUNS it", () => {
  assert.equal(passDue(null, 30, NOW).due, true);
  assert.equal(
    passDue(hoursAgo(0.25), 30, NOW).due,
    false,
    "15 minutes into a 30 minute cadence is not due",
  );
  assert.equal(passDue(hoursAgo(1), 30, NOW).due, true);
  const verdict = passDue("not a date", 30, NOW);
  assert.equal(verdict.due, true);
  assert.match(verdict.reason, /does not parse/);
});

test("PLANT: readHealth does not read a body past the cap", async () => {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled += 1_024;
      c.enqueue(new Uint8Array(1_024).fill(32));
      if (pulled > 10 * MAX_HEALTH_BYTES) c.close();
    },
  });
  const r = await readHealth(
    async () => new Response(body, { status: 200 }),
    "https://x.example.com/health",
  );
  assert.equal(r.body, null);
  assert.ok(pulled <= 2 * MAX_HEALTH_BYTES, `read ${pulled} bytes`);
});

// a healthy surface posts nothing

test("a healthy surface produces no finding", () => {
  assert.deepEqual(healthFindings(HEALTHY, HEALTHY.sha, HEALTHY.schema_version, "capsid"), []);
});

// each check, once

test("a degraded store is a finding", () => {
  const found = healthFindings(
    { ...HEALTHY, status: "degraded", store: { d1: "error", fts: "ok" } },
    HEALTHY.sha,
    HEALTHY.schema_version,
    "capsid",
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].fingerprint, "health-degraded");
  assert.match(
    (found[0].evidence ?? []).join(" "),
    /d1 error/,
    "a finding with no evidence is a rumour",
  );
});

// Master head's own CI run deploys it. Drift is judged only once that run has had its
// say: in flight, or green inside the settle window, is a deploy still landing.
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();
const ciRun = (status: string, conclusion: string | null, endedMinutesAgo = 60, name = "CI") => ({
  name,
  status,
  conclusion,
  created_at: minutesAgo(endedMinutesAgo + 10),
  updated_at: minutesAgo(endedMinutesAgo),
});
const DRIFTED = "0360787aaaabbbbccccddddeeeeffff0011223344";

test("the workflow the drift check waits for is the one that deploys master", () => {
  const ci = readFileSync(
    join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"),
    "utf8",
  );
  assert.equal(/^name: (.+)$/m.exec(ci)?.[1], MASTER_CI_WORKFLOW);
  assert.match(
    ci,
    /^  deploy:$/m,
    "ci.yml no longer holds the deploy job, so its run says nothing about the deploy",
  );
});

test("master head's CI run queued, in progress, or green inside the settle window posts no drift finding", () => {
  for (const runs of [
    [ciRun("queued", null)],
    [ciRun("in_progress", null)],
    [ciRun("completed", "success", DEPLOY_SETTLE_MINUTES - 1)],
    // A re-run in flight after a red run: the newest run decides.
    [
      { ...ciRun("completed", "failure", 30) },
      { ...ciRun("in_progress", null), created_at: minutesAgo(2) },
    ],
  ]) {
    const verdict = deployVerdict(runs, NOW);
    assert.equal(verdict.wait, true, JSON.stringify(runs));
    assert.deepEqual(
      healthFindings(HEALTHY, DRIFTED, HEALTHY.schema_version, "capsid", verdict),
      [],
      JSON.stringify(runs),
    );
  }
});

test("master head's CI run failed, canceled, never started, unreadable or long green keeps the drift finding", () => {
  const cases: Array<[Parameters<typeof deployVerdict>[0], RegExp]> = [
    [[ciRun("completed", "failure", 1)], /ended failure/],
    [[ciRun("completed", "cancelled", 1)], /ended cancelled/],
    [[], /no CI run started/],
    // Another workflow's run on the same sha is not master's deploy.
    [[ciRun("in_progress", null, 1, "mirror")], /no CI run started/],
    [null, /could not be read/],
    [[ciRun("completed", "success", DEPLOY_SETTLE_MINUTES + 1)], /succeeded 16 minutes ago/],
  ];
  for (const [runs, evidence] of cases) {
    const verdict = deployVerdict(runs, NOW);
    assert.equal(verdict.wait, false, JSON.stringify(runs));
    const found = healthFindings(HEALTHY, DRIFTED, HEALTHY.schema_version, "capsid", verdict);
    assert.deepEqual(
      found.map((f) => f.fingerprint),
      ["deploy-drift-0360787"],
      JSON.stringify(runs),
    );
    assert.match((found[0].evidence ?? []).join(" "), evidence);
  }
});

test("an UNKNOWN master sha is not drift, because that is a finding about the watcher", () => {
  assert.deepEqual(healthFindings(HEALTHY, null, HEALTHY.schema_version, "capsid"), []);
  assert.deepEqual(
    healthFindings({ ...HEALTHY, sha: "unknown" }, "0360787", HEALTHY.schema_version, "capsid"),
    [],
  );
});

test("backup findings: stale, never ran, and an unparseable stamp", () => {
  const cases = [
    [{ last_ok: hoursAgo(30), age_hours: 30 }, "backup-stale"],
    [{ last_ok: null, age_hours: null }, "backup-never"],
    // /health keeps last_ok and sets age_hours null, so neither the window nor the never check fires.
    [{ last_ok: "not-a-time", age_hours: null }, "backup-stale"],
  ] as const;
  for (const [backup, want] of cases) {
    const found = healthFindings(
      { ...HEALTHY, backup },
      HEALTHY.sha,
      HEALTHY.schema_version,
      "capsid",
    );
    assert.deepEqual(
      found.map((f) => f.fingerprint),
      [want],
    );
  }
});

test("a live schema behind the newest migration, or ahead of master, is its own finding", () => {
  const fingerprints = (live: string, master: string) =>
    healthFindings({ ...HEALTHY, schema_version: live }, HEALTHY.sha, master, "capsid").map(
      (f) => f.fingerprint,
    );
  assert.deepEqual(fingerprints(HEALTHY.schema_version, "0017_something_new.sql"), [
    "schema-behind-0017_something_new.sql",
  ]);
  assert.deepEqual(fingerprints("0018_applied_early.sql", "0017_something_new.sql"), [
    "schema-ahead-0018_applied_early.sql",
  ]);
});

test("CI red for longer than a flake is a finding; a fresh red or a run in flight is not", () => {
  const run = (status: string, conclusion: string | null, hours: number) => [
    { head_sha: "deadbee1234", status, conclusion, created_at: hoursAgo(hours) },
  ];
  assert.deepEqual(
    ciFindings("capsid", run("completed", "failure", CI_RED_HOURS + 1), NOW).map(
      (f) => f.fingerprint,
    ),
    ["ci-red-capsid"],
  );
  assert.deepEqual(ciFindings("capsid", run("completed", "failure", CI_RED_HOURS - 1), NOW), []);
  assert.deepEqual(ciFindings("capsid", run("in_progress", null, 9), NOW), []);
});

// the pass

const HOUR = 3_600_000;
const later = (hours: number) => new Date(NOW.getTime() + hours * HOUR);

function findingRow(fingerprint: string, over: Partial<FindingRow> = {}): FindingRow {
  return {
    fingerprint,
    namespace: "sample",
    title: `Watcher: something [${fingerprint}]`,
    state: "open",
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

function fakeFinding(fingerprint: string, namespace = "capsid"): Finding {
  return { fingerprint, namespace, title: `Watcher: something [${fingerprint}]` };
}

function pass(
  found: Finding[],
  memory: ReturnType<typeof fakeFindingMemory>,
  now: Date,
  ran: ReadonlySet<WatcherCheck> = new Set(WATCHER_CHECKS),
) {
  return runPass({ findings: async () => ({ findings: found, ran }), memory: memory.memory }, now);
}

test("EACH FINDING IS ONE ROW: the first pass records it, and a second pass counts a sighting", async () => {
  const mem = fakeFindingMemory();
  const one = await pass([fakeFinding("ci-red-abc")], mem, NOW);
  assert.deepEqual(one.recorded, ["ci-red-abc"]);
  const two = await pass([fakeFinding("ci-red-abc")], mem, later(1));
  assert.deepEqual(two.recorded, ["ci-red-abc"]);
  assert.equal(mem.rows.size, 1);
  assert.equal(mem.rows.get("ci-red-abc")?.seen_count, 2);
  assert.deepEqual(mem.writes, ["insert:ci-red-abc", "sight:ci-red-abc"]);
});

test("A FINDING NO LONGER FOUND IS CLEARED, and one still being found is not", async () => {
  const mem = fakeFindingMemory([findingRow("still-broken"), findingRow("went-away")]);
  const result = await pass([fakeFinding("still-broken")], mem, NOW);
  assert.deepEqual(result.cleared, ["went-away"]);
  assert.equal(mem.rows.get("still-broken")?.state, "open");
  assert.equal(mem.rows.get("went-away")?.state, "cleared");
});

test("A FAILED READ DOES NOT CLEAR THE FINDINGS ITS CHECK OWNS", async () => {
  // The roster CI reads failed this pass, so their findings are absent. That says nothing about
  // whether the problems went away.
  const mem = fakeFindingMemory([findingRow("ci-red-abc1234"), findingRow("backup-stale")]);
  const result = await pass([], mem, NOW, new Set(WATCHER_CHECKS.filter((c) => c !== "ci")));
  assert.deepEqual(result.cleared, ["backup-stale"], "only a finding whose check ran is cleared");
  assert.equal(mem.rows.get("ci-red-abc1234")?.state, "open");
});

test("every fingerprint the checks produce has an owning check", () => {
  const stale = new Date(NOW.getTime() - 999 * 3_600_000);
  const all: Finding[] = [
    ...healthFindings(
      { ...HEALTHY, status: "degraded", backup: { last_ok: null, age_hours: 99 } },
      "0360787",
      "0099_x.sql",
      "capsid",
    ),
    ...ciFindings(
      "germomics",
      [
        {
          head_sha: "feedface99",
          status: "completed",
          conclusion: "failure",
          created_at: hoursAgo(9),
        },
      ],
      NOW,
    ),
    ...offaccountFindings("capsid", ["lorem"], null, null, NOW),
    ...offaccountFindings(
      "capsid",
      ["lorem", "ipsum", "dolor"],
      {
        received_at: stale.toISOString(),
        sites: {
          lorem: { newest: null, bytes: null, recent_bytes: [], weekly: null, monthly: null },
          ipsum: {
            newest: "2026-01-01T09-00-00-000Z",
            bytes: 1,
            recent_bytes: [1, 100, 100, 100],
            weekly: null,
            monthly: null,
          },
          dolor: {
            newest: new Date(NOW.getTime() - 31 * 3_600_000).toISOString().replace(/[:.]/g, "-"),
            bytes: 1,
            recent_bytes: [1],
            weekly: null,
            monthly: null,
          },
        },
      },
      null,
      NOW,
    ),
    ...offaccountDrillFindings("capsid", [], NOW),
    ...offaccountCoverageFindings(
      "capsid",
      [],
      [{ name: "lorem", used_by: [{ script: "lorem" }] }],
    ),
  ];
  assert.equal(
    all.length,
    14,
    `the scan produced ${all.length} findings: ${all.map((f) => f.fingerprint).join(", ")}`,
  );
  for (const f of all)
    assert.ok(
      owningCheck(f.fingerprint),
      `${f.fingerprint} has no owning check, so a failed read would clear it`,
    );
});

test("clearing runs BEFORE recording, so a finding that flickers starts its quiet period first", async () => {
  const mem = fakeFindingMemory([findingRow("a")]);
  await pass([fakeFinding("b")], mem, NOW);
  assert.deepEqual(mem.writes, ["clear:a", "insert:b"]);
});

// The watcher's memory of a finding across passes (src/watcher-findings.ts). The
// decision is pure and driven here; the D1 statements run in
// test-integration/watcher-findings.test.ts.

test("a sighting's verdict, for every state a row can be in", () => {
  const row = (over: Partial<FindingRow> = {}) => findingRow("a", over);
  const cleared = (reopen_after: string) => row({ state: "cleared", reopen_after });
  const cases: Array<[string, ReturnType<typeof onSighting>["do"], ReturnType<typeof onSighting>]> =
    [
      ["no row", "record", onSighting(null, NOW)],
      ["open", "record", onSighting(row(), NOW)],
      [
        "cleared, inside the quiet period",
        "quiet",
        onSighting(cleared(later(1).toISOString()), NOW),
      ],
      ["cleared, past the quiet period", "record", onSighting(cleared(hoursAgo(1)), NOW)],
      ["cleared, reopen_after exactly now", "record", onSighting(cleared(NOW.toISOString()), NOW)],
      ["cleared, reopen_after unreadable", "record", onSighting(cleared("garbage"), NOW)],
    ];
  for (const [name, want, got] of cases) assert.equal(got.do, want, name);
});

test("evidence keeps the newest MAX_EVIDENCE sightings, newest last, and restarts on a value that does not parse", () => {
  let evidence: string | null = null;
  for (let i = 0; i < MAX_EVIDENCE + 5; i++)
    evidence = appendEvidence(
      "fp",
      evidence,
      { ...fakeFinding("fp"), evidence: [`sighting ${i}`] },
      later(i),
    );
  const list = JSON.parse(evidence as string) as EvidenceEntry[];
  assert.equal(list.length, MAX_EVIDENCE);
  assert.deepEqual(list[list.length - 1].lines, [`sighting ${MAX_EVIDENCE + 4}`]);
  assert.deepEqual(list[0].lines, ["sighting 5"]);
  const fresh = JSON.parse(
    appendEvidence("fp", "{not json", { ...fakeFinding("fp"), evidence: ["x".repeat(1000)] }, NOW),
  ) as EvidenceEntry[];
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].lines[0].length, 300, "one evidence line is bounded");
});

test("ci-red is one incident per namespace: a new head sha is the same finding, and the sha is its evidence", () => {
  const red = (sha: string) => [
    {
      head_sha: sha,
      status: "completed",
      conclusion: "failure",
      created_at: hoursAgo(CI_RED_HOURS + 1),
    },
  ];
  const [a] = ciFindings("sample", red("aaaaaaa1111111"), NOW);
  const [b] = ciFindings("sample", red("bbbbbbb2222222"), NOW);
  assert.equal(a.fingerprint, "ci-red-sample");
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.title, b.title, "the title stays the same");
  assert.ok(
    b.evidence?.includes("head sha: bbbbbbb2222222"),
    `the sha is not in the evidence: ${b.evidence?.join("; ")}`,
  );
});

test("A CLEARED FINDING IS NOT RECORDED AGAIN until it has stayed quiet", async () => {
  const fp = "site-map-drift-add-sample";
  const mem = fakeFindingMemory([findingRow(fp)]);

  // The drift is fixed: cleared, quiet for six hours from now.
  await pass([], mem, later(2));
  assert.equal(mem.rows.get(fp)?.state, "cleared");
  assert.equal(
    mem.rows.get(fp)?.reopen_after,
    new Date(later(2).getTime() + REOPEN_QUIET_MS).toISOString(),
  );

  // It flaps back inside the quiet period: counted, not opened.
  const flap = await pass([fakeFinding(fp)], mem, later(3));
  assert.deepEqual([flap.recorded, flap.held], [[], [fp]]);
  assert.equal(mem.rows.get(fp)?.state, "cleared");

  // Seen after the quiet period: a recurrence, and the row is open again.
  assert.deepEqual((await pass([fakeFinding(fp)], mem, later(9))).recorded, [fp]);
  assert.equal(mem.rows.get(fp)?.state, "open");
  assert.equal(mem.rows.get(fp)?.reopen_after, null);
});

test("a cleared row is not cleared again each pass, so its quiet period does not slide forever", async () => {
  const fp = "backup-stale";
  const mem = fakeFindingMemory([
    findingRow(fp, { state: "cleared", cleared_at: hoursAgo(7), reopen_after: hoursAgo(1) }),
  ]);
  await pass([], mem, NOW);
  assert.deepEqual(mem.writes, [], "a cleared row that is still clear was written");
  assert.deepEqual((await pass([fakeFinding(fp)], mem, NOW)).recorded, [fp]);
});

test("a finding whose check did not run is not cleared", async () => {
  const mem = fakeFindingMemory([findingRow("ci-red-sample"), findingRow("backup-stale")]);
  await pass([], mem, NOW, new Set(WATCHER_CHECKS.filter((c) => c !== "ci")));
  assert.equal(
    mem.rows.get("ci-red-sample")?.state,
    "open",
    "a failed CI read cleared an open incident",
  );
  assert.equal(mem.rows.get("backup-stale")?.state, "cleared");
});

// The pieces the pass is built from, exported because they carry rules worth
// guarding; this file is their caller for the dead-export check.

test("newestMigration takes the last by name, and ignores what is not a migration", () => {
  assert.equal(
    newestMigration(["0001_init.sql", "0016_jobs_retry_cap.sql", "0002_links.sql"]),
    "0016_jobs_retry_cap.sql",
  );
  assert.equal(newestMigration(["README.md"]), null);
  assert.equal(newestMigration([]), null);
});
