import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OFFACCOUNT_DRILL_STALE_DAYS,
  OFFACCOUNT_LATE_HOURS,
  OFFACCOUNT_REPORT_STALE_HOURS,
  OFFACCOUNT_STALE_HOURS,
  offaccountCoverageFindings,
  offaccountDrillFindings,
  offaccountFindings,
  parseDumpStamp,
  type OffaccountReport,
} from "../src/watcher-detect.ts";
import {
  OFFACCOUNT_SITES,
  parseOffaccountReport,
  type OffaccountSiteReport,
} from "../src/offaccount.ts";

// The Amazon copy check (capsid/rulings/backups-offaccount-2026-10-10.md item 6). The age
// is the dump's own timestamp, the run id, so a copy run that is green and copies nothing
// still reads as stale; a report that stops arriving is its own finding, or the last good
// report would hide a dead copy for ever; and a copy far off its usual size is a gutted or
// runaway dump that its age alone would call healthy.

const NOW = new Date("2026-11-05T14:00:00Z");
const runId = (hoursAgo: number) =>
  new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString().replace(/[:.]/g, "-");
const line = (hoursAgo: number, bytes = 100, before: number[] = []): OffaccountSiteReport => ({
  newest: runId(hoursAgo),
  bytes,
  recent_bytes: [bytes, ...before],
  weekly: null,
  monthly: null,
});
const none: OffaccountSiteReport = {
  newest: null,
  bytes: null,
  recent_bytes: [],
  weekly: null,
  monthly: null,
};
const report = (sites: Record<string, OffaccountSiteReport>, hoursAgo = 1): OffaccountReport => ({
  received_at: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
  sites,
});
const prints = (r: OffaccountReport | null, sites = ["lorem", "ipsum"]) =>
  offaccountFindings("capsid", sites, r, null, NOW).map((f) => f.fingerprint);

test("a run id parses to its own time, and anything else to null", () => {
  assert.equal(
    parseDumpStamp("2026-09-12T09-00-11-132Z")?.toISOString(),
    "2026-09-12T09:00:11.132Z",
  );
  for (const name of [
    "",
    "_complete.json",
    "2026-09-12",
    "2026-09-12T09-00-11Z",
    "2026-13-45T99-99-99-999Z",
  ])
    assert.equal(parseDumpStamp(name), null, name);
});

test("each site is judged on its own copy's age: late at 30 hours, stale at 36, and a missing one is named", () => {
  assert.deepEqual(
    prints(report({ lorem: line(5), ipsum: line(OFFACCOUNT_LATE_HOURS - 0.1) })),
    [],
  );
  assert.deepEqual(prints(report({ lorem: line(5), ipsum: line(OFFACCOUNT_LATE_HOURS + 0.1) })), [
    "offaccount-late-ipsum",
  ]);
  assert.deepEqual(prints(report({ lorem: line(5), ipsum: line(OFFACCOUNT_STALE_HOURS + 0.1) })), [
    "offaccount-stale-ipsum",
  ]);
  // A site the report leaves out is not a healthy one.
  assert.deepEqual(prints(report({ lorem: none })), [
    "offaccount-no-copy-lorem",
    "offaccount-no-copy-ipsum",
  ]);
});

test("a copy under a quarter or over double the median of the copies before it is flagged, given three to compare", () => {
  const history = [100, 104, 96];
  assert.deepEqual(
    prints(report({ lorem: line(5, 30, history), ipsum: line(5, 190, history) })),
    [],
  );
  assert.deepEqual(prints(report({ lorem: line(5, 24, history), ipsum: line(5, 210, history) })), [
    "offaccount-size-lorem",
    "offaccount-size-ipsum",
  ]);
  // Two earlier copies are not a median worth judging by.
  assert.deepEqual(prints(report({ lorem: line(5, 1, [100, 100]), ipsum: line(5) })), []);
});

test("no report, or one that stopped arriving, is a finding even when its copies look fresh", () => {
  assert.deepEqual(prints(null), ["offaccount-no-report"]);
  assert.deepEqual(
    prints(report({ lorem: line(5), ipsum: line(5) }, OFFACCOUNT_REPORT_STALE_HOURS + 0.1)),
    ["offaccount-report-stale"],
  );
});

test("the drill must have passed within 35 days; a newer failure does not count as a pass", () => {
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
  const pass = (d: number) => ({
    status: "completed",
    conclusion: "success",
    created_at: daysAgo(d),
  });
  assert.deepEqual(
    offaccountDrillFindings("capsid", [pass(OFFACCOUNT_DRILL_STALE_DAYS - 1)], NOW),
    [],
  );
  const stale = [
    { status: "completed", conclusion: "failure", created_at: daysAgo(1) },
    pass(OFFACCOUNT_DRILL_STALE_DAYS + 1),
  ];
  assert.deepEqual(
    offaccountDrillFindings("capsid", stale, NOW).map((f) => f.fingerprint),
    ["offaccount-drill-stale"],
  );
  assert.deepEqual(
    offaccountDrillFindings("capsid", [], NOW).map((f) => f.fingerprint),
    ["offaccount-drill-stale"],
  );
});

test("every D1 database a Worker binds needs a copy; a preview-only or unbound one does not", () => {
  const dbs = [
    { name: "lorem", used_by: [{ script: "lorem" }] },
    { name: "ipsum", used_by: [{ script: "ipsum-desk" }] },
    { name: "lorem-preview", used_by: [{ script: "lorem", binding: "DB (preview)" }] },
    { name: "leftover", used_by: [] },
  ];
  assert.deepEqual(
    offaccountCoverageFindings("capsid", ["lorem"], dbs).map((f) => f.fingerprint),
    ["offaccount-uncovered-ipsum"],
  );
});

test("a report must name every site and only known ones, each line well formed", () => {
  const site = {
    newest: "2026-11-05T09-00-48-001Z",
    bytes: 10,
    recent_bytes: [10],
    weekly: null,
    monthly: null,
  };
  const all = Object.fromEntries(OFFACCOUNT_SITES.map((s) => [s, site]));
  const body = (sites: unknown) => JSON.stringify({ jti: "a1b2c3d4e5", sites });
  const refusal = (sites: unknown) =>
    (parseOffaccountReport(body(sites)) as { refusal?: string }).refusal ?? "";
  assert.equal(parseOffaccountReport(body(all)).ok, true);
  assert.match(refusal({ ...all, lorem: site }), /unknown sites: lorem/);
  const { capsid: _left, ...short } = all;
  assert.match(refusal(short), /leaves out: capsid/);
  assert.match(refusal({ ...all, capsid: { ...site, newest: "yesterday" } }), /capsid: expected/);
  // A copy with no size, or a size with no copy, is a malformed line.
  assert.match(refusal({ ...all, capsid: { ...site, bytes: null } }), /capsid: expected/);
});
