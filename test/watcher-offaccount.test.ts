import assert from "node:assert/strict";
import { test } from "node:test";
import { OFFACCOUNT_REPORT_STALE_HOURS, OFFACCOUNT_STALE_HOURS, offaccountFindings, parseDumpStamp, type OffaccountReport } from "../src/watcher-detect.ts";
import { OFFACCOUNT_SITES, parseOffaccountReport } from "../src/offaccount.ts";

// The Amazon copy check (job_51bf55f7b42c step 4). The age is the dump's own timestamp,
// the run id, so a copy run that is green and copies nothing still reads as stale; and a
// report that stops arriving is its own finding, or the last good report would hide a
// dead copy for ever.

const NOW = new Date("2026-11-05T14:00:00Z");
const runId = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString().replace(/[:.]/g, "-");
const report = (sites: Record<string, string | null>, hoursAgo = 1): OffaccountReport => ({ received_at: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(), sites });
const prints = (r: OffaccountReport | null, sites = ["lorem", "ipsum"]) => offaccountFindings("capsid", sites, r, null, NOW).map((f) => f.fingerprint);

test("a run id parses to its own time, and anything else to null", () => {
  assert.equal(parseDumpStamp("2026-09-12T09-00-11-132Z")?.toISOString(), "2026-09-12T09:00:11.132Z");
  for (const name of ["", "_complete.json", "2026-09-12", "2026-09-12T09-00-11Z", "2026-13-45T99-99-99-999Z"]) assert.equal(parseDumpStamp(name), null, name);
});

test("each site is judged on its own copy's age, and a missing one is named", () => {
  assert.deepEqual(prints(report({ lorem: runId(5), ipsum: runId(OFFACCOUNT_STALE_HOURS - 0.1) })), []);
  assert.deepEqual(prints(report({ lorem: runId(5), ipsum: runId(OFFACCOUNT_STALE_HOURS + 0.1) })), ["offaccount-stale-ipsum"]);
  // A site the report leaves out is not a healthy one.
  assert.deepEqual(prints(report({ lorem: null })), ["offaccount-no-copy-lorem", "offaccount-no-copy-ipsum"]);
});

test("no report, or one that stopped arriving, is a finding even when its copies look fresh", () => {
  assert.deepEqual(prints(null), ["offaccount-no-report"]);
  assert.deepEqual(prints(report({ lorem: runId(5), ipsum: runId(5) }, OFFACCOUNT_REPORT_STALE_HOURS + 0.1)), ["offaccount-report-stale"]);
});

test("a report must name every site and only known ones, each a run id or null", () => {
  const all = Object.fromEntries(OFFACCOUNT_SITES.map((s) => [s, null]));
  const body = (sites: unknown) => JSON.stringify({ jti: "a1b2c3d4e5", sites });
  assert.equal(parseOffaccountReport(body({ ...all, capsid: "2026-11-05T09-00-48-001Z" })).ok, true);
  assert.match((parseOffaccountReport(body({ ...all, lorem: null })) as { refusal: string }).refusal, /unknown sites: lorem/);
  const { capsid: _left, ...short } = all;
  assert.match((parseOffaccountReport(body(short)) as { refusal: string }).refusal, /leaves out: capsid/);
  assert.match((parseOffaccountReport(body({ ...all, capsid: "yesterday" })) as { refusal: string }).refusal, /capsid: expected a run id/);
});
