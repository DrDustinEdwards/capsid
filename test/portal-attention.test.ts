import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { OpsFeed } from "../src/ops-types.ts";

// The Overview's Needs attention list, grouped and tiered (dashboard/src/lib/derive.ts,
// attentionGroups and blockedOrder; capsid/research/audit-ui-patterns.md, rulings 3 and
// 10). Built on the dashboard's own sample feed (fake data), reshaped per test.
const { attentionGroups, blockedOrder, GROUP_CHILDREN, STALE_BLOCKED_MS } = await import("../dashboard/src/lib/derive.ts");

const SAMPLE = readFileSync(join(import.meta.dirname, "..", "dashboard", "dev", "sample-feed.json"), "utf8");
const DAY = 86_400_000;

function feed(): { f: OpsFeed; now: number } {
  const f = JSON.parse(SAMPLE) as OpsFeed;
  return { f, now: Date.parse(f.live.generated) };
}

function prs(f: OpsFeed, n: number): void {
  const a0 = f.live.awaiting_seat[0];
  assert.ok(a0, "the sample feed has a pull request awaiting the seat");
  f.live.awaiting_seat = Array.from({ length: n }, (_, i) => ({ ...a0, repo: "example-org/sample-info", namespace: "sample-info", number: 29 + i, at: new Date(Date.parse(a0.at) + i * 60_000).toISOString() }));
}

test("PLANT: four pull requests awaiting the seat are one row that holds all four", () => {
  const { f, now } = feed();
  prs(f, 4);
  const g = attentionGroups(f, now);
  const rows = g.problems.filter((r) => r.kind === "PR");
  assert.equal(rows.length, 1, rows.map((r) => r.title).join(" | "));
  const row = rows[0]!;
  assert.equal(row.title, "4 pull requests await the seat");
  assert.equal(row.sub, "example-org/sample-info");
  assert.equal(row.total, 4);
  assert.deepEqual(
    row.children?.map((c) => c.title),
    ["example-org/sample-info #32 awaits the seat", "example-org/sample-info #31 awaits the seat", "example-org/sample-info #30 awaits the seat", "example-org/sample-info #29 awaits the seat"],
  );
  assert.deepEqual(row.view, { id: "ci", label: "CI and merges" });
});

test("a group shows at most five children and counts the rest", () => {
  const { f, now } = feed();
  prs(f, 7);
  const row = attentionGroups(f, now).problems.find((r) => r.kind === "PR");
  assert.equal(GROUP_CHILDREN, 5);
  assert.equal(row?.children?.length, 5);
  assert.equal(row?.total, 7);
});

test("one pull request stays a row of its own", () => {
  const { f, now } = feed();
  const rows = attentionGroups(f, now).problems.filter((r) => r.kind === "PR");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.children, undefined);
  assert.equal(rows[0]?.title, "example-org/sample-c #32 awaits the seat");
});

test("PLANT: problems hold no notice; missing data, a check that could not run, unread CI, drift and silent drivers are notices", () => {
  const { f, now } = feed();
  const g = attentionGroups(f, now);
  assert.ok(g.problems.length >= 4);
  assert.deepEqual(g.problems.filter((r) => r.sev === "nodata").map((r) => r.title), []);
  const titles = g.notices.map((r) => r.title);
  // The sample feed has each kind once.
  assert.ok(titles.includes("Sample G: no Cloudflare data"), titles.join(" | "));
  assert.ok(titles.some((t) => t.startsWith("Check 'cf-deploys' could not run")), titles.join(" | "));
  assert.ok(titles.includes("CI runs for sample-d could not be read"), titles.join(" | "));
  assert.ok(titles.some((t) => t.startsWith("Site map drift")), titles.join(" | "));
  assert.ok(titles.some((t) => t.startsWith("sample-d-driver has been silent")), titles.join(" | "));
  assert.equal(g.noticeCount, g.notices.length);
  // Worst first: every critical row before every warning.
  const sevs = g.problems.map((r) => r.sev);
  assert.deepEqual(sevs, [...sevs].sort((a, b) => (a === b ? 0 : a === "crit" ? -1 : 1)));
});

test("health not read and the mirror not read stay warnings, not notices", () => {
  const { f, now } = feed();
  assert.ok(f.snapshot);
  f.snapshot.health = null;
  f.snapshot.mirror = null;
  const g = attentionGroups(f, now);
  const warn = g.problems.filter((r) => r.sev === "warn").map((r) => r.title);
  assert.ok(warn.includes("Capsid health was not read on the last pass"), warn.join(" | "));
  assert.ok(warn.includes("The off-account mirror was not read on the last pass"), warn.join(" | "));
  assert.equal(g.notices.filter((r) => /was not read on the last pass/.test(r.title)).length, 0);
});

test("silent drivers are one notice", () => {
  const { f, now } = feed();
  let n = 0;
  for (const a of f.live.agents) if (a.kind === "driver" && !a.revoked_at) (a.last_seen = new Date(now - (8 + n++) * DAY).toISOString());
  assert.ok(n >= 3);
  const g = attentionGroups(f, now);
  const rows = g.notices.filter((r) => r.kind === "Agent");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.title, `${n} drivers have been silent for over 7 days`);
  assert.equal(rows[0]?.total, n);
  // The notice count counts drivers, not rows.
  assert.equal(g.noticeCount, g.notices.length - 1 + n);
});

test("PLANT: blocked jobs are ordered by priority, then newest; over 7 days they are Stale", () => {
  const { f, now } = feed();
  const base = f.live.jobs.find((j) => j.status === "blocked")!;
  const at = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();
  f.live.jobs = [
    { ...base, id: "job_000000000001", priority: 0, updated_at: at(1) },
    { ...base, id: "job_000000000002", priority: 2, updated_at: at(3) },
    { ...base, id: "job_000000000003", priority: 0, updated_at: at(0.5) },
    { ...base, id: "job_000000000004", priority: 2, updated_at: at(2) },
    { ...base, id: "job_000000000005", priority: 5, updated_at: at(9) },
    { ...base, id: "job_000000000006", priority: 0, updated_at: at(8) },
    { ...base, id: "job_000000000007", priority: 0, updated_at: at(12) },
  ];
  assert.equal(STALE_BLOCKED_MS, 7 * DAY);
  const o = blockedOrder(f.live.jobs, now);
  assert.deepEqual(o.blocked.map((j) => j.id.slice(-1)), ["4", "2", "3", "1"]);
  assert.deepEqual(o.stale.map((j) => j.id.slice(-1)), ["5", "6", "7"]);
  // The Overview's blocked group lists its children in the same order, Stale after.
  const row = attentionGroups(f, now).problems.find((r) => r.kind === "Queue");
  assert.equal(row?.title, "7 jobs are waiting on you");
  assert.equal(row?.total, 7);
  assert.deepEqual(row?.children?.map((c) => c.open), ["4", "2", "3", "1", "5"].map((d) => `job:job_00000000000${d}`));
});

// ---- the run ledger (src/task-runs.ts) ------------------------------------------

test("PLANT: a scheduled task that failed or went quiet is a problem; a backup is critical; no run yet is not listed", async () => {
  const { attentionItems } = await import("../dashboard/src/lib/derive.ts");
  const { f, now } = feed();
  assert.ok(f.scheduled.tasks, "the sample feed carries the run ledger");
  const tasks = f.scheduled.tasks;
  const at = new Date(now - 60_000).toISOString();
  const set = (id: string, flag: "failing" | "quiet" | "never" | null, outcome: "ok" | "threw" | "refused" = "ok") => {
    const t = tasks.find((x) => x.id === id)!;
    t.flag = flag;
    t.recent = flag === "never" ? [] : [{ started_at: at, finished_at: at, outcome, reason: `${id} reason` }];
  };
  for (const t of tasks) set(t.id, null);
  set("backup", "failing", "threw");
  set("watcher", "quiet");
  set("skill-cycle", "never");
  const rows = attentionItems(f, now).filter((a) => a.kind === "Scheduled");
  assert.deepEqual(
    rows.map((r) => [r.sev, r.title, r.sub]),
    [
      ["crit", "Backup: its last run threw", "backup reason"],
      ["warn", "Watcher pass has not run for 1m", "watcher reason"],
    ]
  );
});

test("a run ledger that could not be read is a notice that says why", async () => {
  const { attentionItems } = await import("../dashboard/src/lib/derive.ts");
  const { f, now } = feed();
  f.scheduled = { tasks: null, error: "D1_ERROR: no such table: task_runs" };
  const rows = attentionItems(f, now).filter((a) => a.kind === "Scheduled");
  assert.deepEqual(rows.map((r) => [r.sev, r.sub]), [["nodata", "D1_ERROR: no such table: task_runs"]]);
});
