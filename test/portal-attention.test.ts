import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { OpsFeed } from "../src/ops-types/feed.ts";

const { attentionList, blockedOrder } = await import("../dashboard/src/lib/derive.ts");

const SAMPLE = readFileSync(
  join(import.meta.dirname, "..", "dashboard", "dev", "sample-feed.json"),
  "utf8",
);
const DAY = 86_400_000;

function feed(): { f: OpsFeed; now: number } {
  const f = JSON.parse(SAMPLE) as OpsFeed;
  return { f, now: Date.parse(f.live.generated) };
}

const list = (f: OpsFeed, now: number) => attentionList(f, now, (ref) => `/open/${ref}`);

test("PLANT: Problems hold nothing Needs you lists with its buttons", () => {
  const { f, now } = feed();
  assert.ok(
    f.live.jobs.some((j) => j.status === "blocked"),
    "the sample has a blocked job",
  );
  const left = list(f, now).items.map((r) => r.detail?.split(" · ")[0] ?? "");
  assert.deepEqual(
    left.filter((k) => ["Queue", "PR", "Breaker"].includes(k)),
    [],
  );
  assert.ok(left.length > 0, "the other problems stay");
});

test("PLANT: missing data, a check that could not run, unread CI, drift and silent drivers are notices", () => {
  const { f, now } = feed();
  const { items } = list(f, now);
  assert.ok(items.filter((r) => r.tone !== "nodata").length >= 4);
  const titles = items.filter((r) => r.tone === "nodata").map((r) => r.title);
  assert.ok(titles.includes("Sample G: no Cloudflare data"), titles.join(" | "));
  assert.ok(
    titles.some((t) => t.startsWith("Check 'cf-deploys' could not run")),
    titles.join(" | "),
  );
  assert.ok(titles.includes("CI runs for sample-d could not be read"), titles.join(" | "));
  assert.ok(
    titles.some((t) => t.startsWith("Site map drift")),
    titles.join(" | "),
  );
  const silent = items.find((r) => r.title.startsWith("sample-d-driver has been silent"));
  assert.equal(silent?.href, "/open/agent:sample-d-driver");
  assert.equal(silent?.group, "silent");
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
  const o = blockedOrder(f.live.jobs, now);
  assert.deepEqual(
    o.blocked.map((j) => j.id.slice(-1)),
    ["4", "2", "3", "1"],
  );
  assert.deepEqual(
    o.stale.map((j) => j.id.slice(-1)),
    ["5", "6", "7"],
  );
});

test("PLANT: a scheduled task that failed or went quiet is a problem; a backup is critical; no run yet is not listed", async () => {
  const { attentionItems } = await import("../dashboard/src/lib/derive.ts");
  const { f, now } = feed();
  assert.ok(f.scheduled.tasks, "the sample feed carries the run ledger");
  const tasks = f.scheduled.tasks;
  const at = new Date(now - 60_000).toISOString();
  const set = (
    id: string,
    flag: "failing" | "quiet" | "never" | null,
    outcome: "ok" | "threw" | "refused" = "ok",
  ) => {
    const t = tasks.find((x) => x.id === id)!;
    t.flag = flag;
    t.recent =
      flag === "never"
        ? []
        : [
            {
              started_at: at,
              finished_at: at,
              outcome,
              reason: `${id} reason`,
            },
          ];
  };
  for (const t of tasks) set(t.id, null);
  set("backup", "failing", "threw");
  set("watcher", "quiet");
  set("merge-resume", "never");
  const rows = attentionItems(f, now).filter((a) => a.kind === "Scheduled");
  assert.deepEqual(
    rows.map((r) => [r.sev, r.title, r.sub]),
    [
      ["crit", "Backup: its last run threw", "backup reason"],
      ["warn", "Watcher pass has not run for 1m", "watcher reason"],
    ],
  );
});

test("a run ledger that could not be read is a notice that says why", async () => {
  const { attentionItems } = await import("../dashboard/src/lib/derive.ts");
  const { f, now } = feed();
  f.scheduled = { tasks: null, error: "D1_ERROR: no such table: task_runs" };
  const rows = attentionItems(f, now).filter((a) => a.kind === "Scheduled");
  assert.deepEqual(
    rows.map((r) => [r.sev, r.sub]),
    [["nodata", "D1_ERROR: no such table: task_runs"]],
  );
});
