import { median } from "capsomer/behavior/format";
import type { OffaccountSiteReport } from "./offaccount";
import { HOUR_MS } from "./time";
import { finding, type Finding } from "./watcher-detect";

// Not BACKUP_STALE_HOURS: that is the local dump, from a key this Worker writes itself. This is the
// Amazon copy, which this Worker only hears about from capsid-backups' watch.yml, whose schedules can
// change unheard, so one shared constant would go wrong silently.
// 36 hours is the daily cadence plus slack: dumps at 09:00 UTC, copies at 11:23 UTC, so just before a
// copy the newest is about 24 hours older than the next dump. A tighter window would fire every morning.
export const OFFACCOUNT_STALE_HOURS = 36;

// A copy a few hours late shows on the Portal's attention list as a notice, not an alert.
export const OFFACCOUNT_LATE_HOURS = 30;

// Item 6 again: a copy under a quarter of, or over double, the median of the site's recent
// copies is a gutted or runaway dump. Judged only with enough history to have a median.
const OFFACCOUNT_SIZE_LOW = 0.25;
const OFFACCOUNT_SIZE_HIGH = 2;
const OFFACCOUNT_SIZE_MIN_HISTORY = 3;

// The restore drill runs monthly (the 3rd); a month plus slack without a pass means nobody has
// proved the copies restore.
export const OFFACCOUNT_DRILL_STALE_DAYS = 35;

// watch.yml reports every 6 hours. Two missed reports plus GitHub's cron delay is a
// stopped report, not a late one.
export const OFFACCOUNT_REPORT_STALE_HOURS = 13;

// The repo is never named in this module: it is resolved from the capsid namespace's
// mapping, which is the authorization boundary.
export const BACKUPS_REPO_LABEL = "backups";
// Measure the copy, not the attempt: a run can be green and copy nothing. watch.yml reports the run id
// of the newest copy carrying _complete.json, the dump's own timestamp, so the age is the data's.

// `2026-09-12T09-00-11-132Z` as d1-dump writes it. Anchored, so a stray name yields null
// rather than looking like a fresh backup.
const DUMP_STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

export function parseDumpStamp(name: string): Date | null {
  const m = DUMP_STAMP.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  const at = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

export interface OffaccountReport {
  received_at: string;
  sites: Record<string, OffaccountSiteReport>;
}

export interface WorkflowRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  created_at?: string;
  updated_at?: string | null;
  url?: string;
}

export function offaccountFindings(
  namespace: string,
  sites: readonly string[],
  report: OffaccountReport | null,
  copyRun: WorkflowRun | null,
  now: Date,
): Finding[] {
  if (!report) {
    return [
      finding(
        namespace,
        "offaccount-no-report",
        "no report of the Amazon backup copy has arrived",
        [
          "Nothing is stored at POST /backup/offaccount-report.",
          "capsid-backups' watch.yml has never reported, or APP_KV lost the report; its next run writes it again.",
        ],
      ),
    ];
  }
  const out: Finding[] = [];
  const reportHours = (now.getTime() - Date.parse(report.received_at)) / HOUR_MS;
  if (!(reportHours < OFFACCOUNT_REPORT_STALE_HOURS)) {
    out.push(
      finding(
        namespace,
        "offaccount-report-stale",
        "the Amazon backup copy's report has stopped arriving",
        [
          `last report: ${report.received_at} (${reportHours.toFixed(1)} hours old, the window is ${OFFACCOUNT_REPORT_STALE_HOURS})`,
          "capsid-backups' watch.yml runs every 6 hours; its schedule, its role or its signing key has stopped working.",
        ],
      ),
    );
  }
  const run = copyRun
    ? `last copy run: ${copyRun.created_at ?? "unknown"} concluded ${copyRun.conclusion ?? "none"}${copyRun.url ? ` (${copyRun.url})` : ""}`
    : "no completed offaccount run was returned for the backups repo";
  // A copy run that finished after the report was written (or started before it) is not in it yet, so
  // its ages are a cycle behind. The 36 hour window leaves only about an hour and a half over a late
  // report: the age is judged once the next report lands, and one that never lands is its own finding.
  const copyAfterReport =
    copyRun?.conclusion === "success" &&
    Date.parse(copyRun.updated_at ?? copyRun.created_at ?? "") > Date.parse(report.received_at);
  for (const site of sites) {
    const line = report.sites[site];
    const newest = line?.newest ?? null;
    const at = newest ? parseDumpStamp(newest) : null;
    if (!line || !at) {
      out.push(
        finding(
          namespace,
          `offaccount-no-copy-${site}`,
          `the Amazon bucket holds no complete copy of ${site}`,
          [`report of ${report.received_at}: nothing complete under daily/${site}/`, run],
        ),
      );
      continue;
    }
    const hours = (now.getTime() - at.getTime()) / HOUR_MS;
    if (copyAfterReport) {
    } else if (hours >= OFFACCOUNT_STALE_HOURS) {
      out.push(
        finding(namespace, `offaccount-stale-${site}`, `the Amazon copy of ${site} is stale`, [
          `newest complete copy: ${newest} (${hours.toFixed(1)} hours old, the window is ${OFFACCOUNT_STALE_HOURS})`,
          run,
        ]),
      );
    } else if (hours >= OFFACCOUNT_LATE_HOURS) {
      out.push(
        finding(namespace, `offaccount-late-${site}`, `the Amazon copy of ${site} is late`, [
          `newest complete copy: ${newest} (${hours.toFixed(1)} hours old; a warning from ${OFFACCOUNT_LATE_HOURS}, an alert from ${OFFACCOUNT_STALE_HOURS})`,
          run,
        ]),
      );
    }
    const before = line.recent_bytes.slice(1);
    if (line.bytes !== null && before.length >= OFFACCOUNT_SIZE_MIN_HISTORY) {
      const mid = median(before) as number;
      const ratio = mid > 0 ? line.bytes / mid : Number.POSITIVE_INFINITY;
      if (ratio < OFFACCOUNT_SIZE_LOW || ratio > OFFACCOUNT_SIZE_HIGH) {
        out.push(
          finding(
            namespace,
            `offaccount-size-${site}`,
            `the newest Amazon copy of ${site} is an unusual size`,
            [
              `${newest}: ${line.bytes} bytes against a median of ${Math.round(mid)} over the ${before.length} copies before it (${ratio.toFixed(2)}x; the bounds are ${OFFACCOUNT_SIZE_LOW}x and ${OFFACCOUNT_SIZE_HIGH}x)`,
              "A copy far smaller than usual is a gutted dump; far larger, a runaway table or a dump of the wrong thing.",
            ],
          ),
        );
      }
    }
  }
  return out;
}

// A database bound only as a Workers preview holds test data, and one no Worker binds is a leftover;
// both are left out.
export function offaccountCoverageFindings(
  namespace: string,
  covered: readonly string[],
  databases: ReadonlyArray<{
    name: string;
    used_by: ReadonlyArray<{ script: string; binding?: string }>;
  }>,
): Finding[] {
  return databases
    .filter(
      (d) => d.used_by.some((u) => !u.binding?.endsWith(" (preview)")) && !covered.includes(d.name),
    )
    .map((d) =>
      finding(
        namespace,
        `offaccount-uncovered-${d.name}`,
        `the D1 database ${d.name} has no Amazon copy`,
        [
          `bound by ${d.used_by.map((u) => u.script).join(", ")}`,
          "Its site needs a nightly d1-dump, a row in capsid's OFFACCOUNT_SOURCES, its bucket on the R2 read token, and a line in capsid-backups' workflows.",
        ],
      ),
    );
}

export function offaccountDrillFindings(
  namespace: string,
  drillRuns: WorkflowRun[],
  now: Date,
): Finding[] {
  const passed = drillRuns.find((r) => r.status === "completed" && r.conclusion === "success");
  const at = passed?.created_at ? Date.parse(passed.created_at) : Number.NaN;
  const days = (now.getTime() - at) / (24 * HOUR_MS);
  if (days < OFFACCOUNT_DRILL_STALE_DAYS) return [];
  const last = drillRuns.find((r) => r.status === "completed");
  return [
    finding(
      namespace,
      "offaccount-drill-stale",
      "no restore drill from the Amazon copy has passed recently",
      [
        passed
          ? `last passing drill: ${passed.created_at} (${days.toFixed(0)} days ago, the window is ${OFFACCOUNT_DRILL_STALE_DAYS})`
          : "no passing drill run was returned",
        last
          ? `last drill: ${last.created_at ?? "unknown"} concluded ${last.conclusion ?? "none"}${last.url ? ` (${last.url})` : ""}`
          : "no completed drill run was returned",
      ],
    ),
  ];
}
