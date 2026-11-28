import { heatStrip, timeline, type TimelineEvent } from "enarratio";
import { areaChart } from "enarratio/lite/area";
import { lineChart } from "enarratio/lite/line";
import { ChartFrame } from "capsomer/react/chart-frame";
import { Panel } from "capsomer/react/panel";
import { useApp } from "../app/ctx";
import { padRing } from "capsomer/behavior/uptime-strip";
import { RING_SLOTS, cfNoData, cfOk, slotStart } from "../lib/derive";
import { DAY, HOUR, SLOT_MS, pct, shortId } from "../lib/format";
import { shortCount } from "capsomer/behavior/format";
import { parse, utc } from "capsomer/behavior/time";
import { useTrends } from "../lib/trends";
import type { PortalPackageHistory, PortalTrends, SiteSnapshot, TrendCiRepo } from "../types";
import { errorTotals } from "../ui/charts";
import { Status } from "capsomer/react/status";
import "./TrendCharts.css";

// The Portal's charts drawn with Enarratio's primitives (docs/design/design-portal-evaluation.md section 3; DECIDE 6 and 7). Each is
// Enarratio's whole figure in Capsomer's chart frame, from enarratio/lite (no Observable Plot, to fit the chunk budget). Loads with the
// page that shows a chart, never in the initial bundle; uptime's UptimeTicks is in ui/charts.tsx.

// A later read that failed keeps the last answer on screen and says so, so numbers no longer current are not passed off.
function Stale({ error }: { error: string | null }) {
  return error ? (
    <p className="cap-text" data-tone="dim">
      Not refreshed: {error}
    </p>
  ) : null;
}

// First chart on Needs you: this week's minutes, the change on last week, and eight weeks as a line (Dustin's review, 2026-10-11).
export function MinutesTile() {
  const { data, error, loading } = useTrends();
  if (loading && !data) return null;
  if (!data) return <Unread what="Your time per week" error={error} />;
  return (
    <>
      <Minutes minutes={data.minutes} />
      <Stale error={error} />
    </>
  );
}

// More of Dustin's time is worse.
export function minutesChange(
  now: number,
  before: number | null,
): { text: string; dir: "up" | "down" | "same" | null } {
  if (before === null) return { text: "no week before to compare", dir: null };
  const d = now - before;
  if (d === 0) return { text: "the same as last week", dir: "same" };
  return {
    text: `${Math.abs(d)} min ${d > 0 ? "more" : "less"} than last week`,
    dir: d > 0 ? "up" : "down",
  };
}

function Minutes({ minutes }: { minutes: PortalTrends["minutes"] }) {
  const weeks = minutes.weeks;
  const now = weeks[weeks.length - 1];
  const before = weeks[weeks.length - 2];
  if (!now) return null;
  const change = minutesChange(now.minutes, before ? before.minutes : null);
  const opts = {
    data: weeks.map((w) => ({ week: w.start, minutes: w.minutes })),
    x: "week",
    y: "minutes",
    xLabel: "Week starting",
    yLabel: "Minutes",
    formatValue: (v: number) => `${v} min`,
    height: 56 + 4 * 30,
    title: "How much of your time does Capsid take?",
    subtitle: `${now.minutes} min this week, ${change.text}`,
    alt: `Your time on Capsid per week, ${weeks[0]!.start} to ${now.start}: ${now.minutes} minutes this week, ${change.text}.`,
    caption: `An estimate from what you did in Capsid: each stretch of actions with no gap over 5 minutes counts from its first action to its last, plus a minute. Reading the Portal without acting is not counted.${minutes.truncated ? " Cut at the read's row limit, so the figure is low." : ""}`,
    source: { name: "Capsid audit log, your actions" },
  } as const;
  return (
    <ChartFrame
      className="minutes-chart"
      draw={(width, fit) => lineChart({ ...opts, width, ...fit })}
    />
  );
}

function Unread({ what, error }: { what: string; error: string | null }) {
  return (
    <p className="cap-text" data-tone="dim">
      {what} could not be read: {error}
    </p>
  );
}

const restoreWords = (s: number | null) =>
  s === null ? "-" : s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;

export function DeploysTable() {
  const { data, error, loading } = useTrends();
  if (loading && !data) return null;
  if (!data) return <Unread what="Deploys" error={error} />;
  const repos = data.deploys.repos;
  return (
    <Panel
      flush
      title={`Deploys, ${data.weeks} weeks`}
      src="deploy_outcomes, each deploy's live gate"
      id="deploy-measures"
    >
      <Stale error={error} />
      <div className="cap-table-wrap" data-reflow="wide">
        <table className="cap-table">
          <thead>
            <tr>
              <th>Repository</th>
              <th>Per week</th>
              <th>Shipped</th>
              <th>Refused</th>
              <th>Change failure rate</th>
              <th>Median time to restore</th>
            </tr>
          </thead>
          <tbody>
            {repos.map((r) => (
              <tr key={r.repo}>
                <td>{r.repo.split("/")[1]}</td>
                <td data-label="Per week">{r.per_week}</td>
                <td data-label="Shipped">{r.shipped}</td>
                <td data-label="Refused">
                  {r.refused}
                  {r.unverified ? (
                    <span className="cap-text" data-tone="dim">
                      {" "}
                      ({r.unverified} could not be checked)
                    </span>
                  ) : null}
                </td>
                <td data-label="Change failure rate">{pct(r.change_failure_rate, 0)}</td>
                <td data-label="Median time to restore">
                  {restoreWords(r.restore_median_seconds)}
                </td>
              </tr>
            ))}
            {repos.length === 0 && (
              <tr>
                <td colSpan={6} className="cap-text" data-tone="dim">
                  No deploy went through a live gate in this window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// The requests the old drawing showed as bars are in the caption's totals.
export function ErrorRate({ site }: { site: SiteSnapshot }) {
  const cf = cfOk(site);
  const why = cfNoData(site.cloudflare);
  const title = "Requests and error rate, 24 hours";
  if (!cf) return <ChartFrame noData={{ title, reason: why ?? "" }} />;
  if (!cf.errors24)
    return (
      <ChartFrame
        noData={{
          title,
          reason: cf.errors_reason ?? "the analytics read failed",
        }}
      />
    );
  const e = cf.errors24;
  if (!e.length)
    return <ChartFrame noData={{ title, reason: "the analytics read returned no hours" }} />;
  const rates = e.map((x) => (x.requests ? (x.errors / x.requests) * 100 : 0));
  const peak = Math.max(...rates);
  const t0 = parse(e[0]!.hour);
  const t1 = parse(e[e.length - 1]!.hour) + HOUR;
  const inWindow = cf.deploys.filter((d) => parse(d.created_on) >= t0 && parse(d.created_on) <= t1);
  const tot = errorTotals(e);
  const opts = {
    data: e.map((x, i) => ({
      hour: new Date(parse(x.hour)).toISOString(),
      rate: Math.round(rates[i]! * 100) / 100,
    })),
    x: "hour",
    y: "rate",
    xLabel: null,
    yLabel: "Error rate (%)",
    formatValue: (v: number) => `${v}%`,
    references: [{ y: 1, label: "Alert at 1%" }],
    markers: inWindow.map((d) => ({
      x: new Date(parse(d.created_on)).toISOString(),
      label: `Deploy ${shortId(d.version_id ?? d.id)}`,
    })),
    height: 220,
    title,
    subtitle: `${shortCount(tot.req)} requests and ${shortCount(tot.err)} errors (${pct(tot.rate)})`,
    alt: `Error rate for ${site.name} over the last 24 hours: peak ${peak.toFixed(2)}% in an hour, ${pct(tot.rate)} overall, ${inWindow.length} ${inWindow.length === 1 ? "deploy" : "deploys"} in the window.`,
    caption: inWindow.length
      ? `Deploys: ${inWindow.map((d) => `${shortId(d.version_id ?? d.id)} at ${utc(parse(d.created_on))}${d.message ? ` (${d.message})` : ""}`).join("; ")}.`
      : "No deploy in the window.",
    source: { name: "Cloudflare Workers analytics, hourly" },
  } as const;
  return <ChartFrame draw={(width, fit) => lineChart({ ...opts, width, ...fit })} />;
}

// Enarratio gives way to a plain list where narrow, so a phone reads events instead of scrolling a drawing.
export function DeployTimeline({ sites, days }: { sites: SiteSnapshot[]; days: number }) {
  const { now } = useApp();
  const t0 = now - days * DAY;
  const events: TimelineEvent[] = [];
  const lanes = sites.map((s) => s.name);
  let deploys = 0;
  let downSlots = 0;
  const noData: string[] = [];
  for (const s of sites) {
    const ring = padRing(s.ring, RING_SLOTS);
    for (let k = 0; k < ring.length;) {
      const c = ring[k];
      let end = k + 1;
      while (end < ring.length && ring[end] === c) end++;
      const from = Math.max(t0, slotStart(s, k));
      const to = slotStart(s, end - 1) + SLOT_MS;
      if (c !== "1" && to > t0) {
        if (c === "0") downSlots += end - k;
        events.push({
          lane: s.name,
          label:
            c === "0"
              ? `Probe failed, ${end - k} half-hour ${end - k === 1 ? "slot" : "slots"}`
              : "No watcher pass",
          status: c === "0" ? "error" : "unknown",
          from,
          to,
        });
      }
      k = end;
    }
    const why = cfNoData(s.cloudflare);
    if (why) noData.push(`${s.name}: ${why}`);
    for (const d of cfOk(s)?.deploys ?? []) {
      const t = parse(d.created_on);
      if (t < t0 || t > now) continue;
      deploys++;
      events.push({
        lane: s.name,
        label: `Deploy ${shortId(d.version_id ?? d.id)}${d.triggered_by ? `, ${d.triggered_by}` : ""}${d.message ? `: ${d.message}` : ""}`,
        status: "ok",
        at: t,
      });
    }
  }
  const notes = [
    ...(days > 7 ? ["The probe ring holds 7 days; older downtime is not shown."] : []),
    ...(noData.length ? [`Deploys not read for ${noData.join("; ")}.`] : []),
  ];
  const opts = {
    events,
    lanes,
    start: t0,
    end: now,
    title: "Deploys and downtime",
    label: `Deploys and downtime across ${sites.length} sites, last ${days} days`,
    alt: `Deploys and downtime across ${sites.length} sites, last ${days} days: ${deploys} deploys, ${downSlots} half-hour probe failures.`,
    notes,
    source: { name: "Cloudflare deployments and the watcher's probes" },
  };
  return <ChartFrame draw={(width, fit) => timeline({ ...opts, width, ...fit })} />;
}

// As if it started when the plan was read: the plan holds estimates, not a start time, and the axis is a UTC clock.
// Heavy lanes share one session so run in turn; the window runs a tenth past the end so the last tick is not on the edge.

export function BackupSlots() {
  const { data, error, loading } = useTrends();
  const b = data?.backups;
  return (
    <Panel flush title="Retention slots" src="backup bucket, complete runs" id="backup-slots">
      <div className="body cap-stack" data-gap="4">
        {b && <Stale error={error} />}
        {!b ? (
          loading ? null : (
            <Status tone="nodata">Not read: {error}</Status>
          )
        ) : !b.slots ? (
          <Status tone="nodata">{b.error}</Status>
        ) : (
          (
            [
              ["Daily", `${b.slots.daily.length} days`, b.slots.daily],
              ["Weekly", `${b.slots.weekly.length} weeks`, b.slots.weekly],
              ["Monthly", `${b.slots.monthly.length} months`, b.slots.monthly],
            ] as const
          ).map(([name, span, slots]) => {
            const kept = slots.filter((s) => s.filled).length;
            const opts = {
              values: slots.map((s) => (s.filled ? 1 : null)),
              min: 0,
              max: 1,
              title: name,
              subtitle: `${kept} of ${slots.length} kept`,
              label: `${name} backups, the last ${span}`,
              height: 20,
              cellLabels: slots.map((s) => s.key),
              formatValue: () => "kept",
              csv: false,
              summary: false,
            } as const;
            return (
              <ChartFrame
                key={name}
                inline
                draw={(width, fit) => heatStrip({ ...opts, width, ...fit })}
              />
            );
          })
        )}
        {b?.slots && (
          <p className="cap-text slot-key" data-tone="dim">
            <span className="slot-swatch" data-kept="" aria-hidden="true" /> kept{" "}
            <span className="slot-swatch" aria-hidden="true" /> missing
          </p>
        )}
      </div>
    </Panel>
  );
}

// Green 0, red 1, no run as no value: red reads as the strong end and a day with no verdict is missing, never green.
function ciValues(r: TrendCiRepo): (number | null)[] {
  return r.days.map((d) => (d.state === "none" ? null : d.state === "red" ? 1 : 0));
}

function redStreak(r: TrendCiRepo): number {
  let n = 0;
  for (let i = r.days.length - 1; i >= 0 && r.days[i]!.state === "red"; i--) n++;
  return n;
}

export function CiHistory() {
  const { data, error, loading } = useTrends();
  const ci = data?.ci;
  return (
    <Panel
      flush
      title="The last 14 days"
      src="GitHub, default branch runs, kept an hour"
      id="ci-history"
    >
      <div className="body cap-stack" data-gap="4">
        {ci && <Stale error={error} />}
        {!ci ? (
          loading ? null : (
            <Status tone="nodata">Not read: {error}</Status>
          )
        ) : (
          <>
            {ci.repos.map((r) => {
              const streak = redStreak(r);
              if (!r.days.some((d) => d.state !== "none")) {
                return (
                  <div className="slot-head" key={r.namespace} data-ci={r.namespace}>
                    <b>{r.namespace}</b> <Status tone="nodata">no run in 14 days</Status>
                  </div>
                );
              }
              const opts = {
                values: ciValues(r),
                min: 0,
                max: 1,
                title: r.namespace,
                subtitle: streak
                  ? `red for ${streak === r.days.length ? "at least " : ""}${streak} ${streak === 1 ? "day" : "days"}`
                  : "green",
                label: `${r.namespace} default branch, red or green by day`,
                notes: r.truncated ? "Over 100 runs; early days may be missing some." : undefined,
                height: 20,
                cellLabels: r.days.map((d) => d.day),
                formatValue: (v: number) => (v >= 1 ? "red" : "green"),
                csv: false,
                summary: false,
              } as const;
              return (
                <div key={r.namespace} data-ci={r.namespace}>
                  <ChartFrame inline draw={(width, fit) => heatStrip({ ...opts, width, ...fit })} />
                </div>
              );
            })}
            {ci.not_read.map((n) => (
              <div className="slot-head" key={n.namespace}>
                <b>{n.namespace}</b> <Status tone="nodata">{`not read: ${n.error}`}</Status>
              </div>
            ))}
          </>
        )}
      </div>
    </Panel>
  );
}

// Over WEEKLY_AFTER days the days are summed by week (Monday, UTC): a point a day for 18 months was 194 kB, over the 100 kB chart budget.
const WEEKLY_AFTER = 120;

function weekOf(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  const back = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - back * 86_400_000).toISOString().slice(0, 10);
}

const plusDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// Only weeks inside the history: one npm has not finished counting, or cut at the start, would read as a fall.
function byWeek(days: PortalPackageHistory["days"]): PortalPackageHistory["days"] {
  const start = days[0]!.day;
  const end = days[days.length - 1]!.day;
  const sums = new Map<string, PortalPackageHistory["days"][number]>();
  for (const d of days) {
    const day = weekOf(d.day);
    if (day < start || plusDays(day, 6) > end) continue;
    const key = `${day} ${d.name}`;
    const row = sums.get(key);
    if (row) row.downloads += d.downloads;
    else sums.set(key, { day, downloads: d.downloads, name: d.name });
  }
  return [...sums.values()];
}

export function DownloadsChart({ data }: { data: PortalPackageHistory }) {
  if (!data.days.length)
    return (
      <ChartFrame
        noData={{
          title: `Daily downloads of ${data.name}`,
          reason: "npm has counted no downloads for this package yet.",
        }}
      />
    );
  const weekly =
    Date.parse(data.days[data.days.length - 1]!.day) - Date.parse(data.days[0]!.day) >
    WEEKLY_AFTER * 86_400_000;
  const rows = weekly ? byWeek(data.days) : data.days;
  const total = rows.reduce((a, d) => a + d.downloads, 0);
  const first = rows[0]!.day;
  const last = weekly ? plusDays(rows[rows.length - 1]!.day, 6) : rows[rows.length - 1]!.day;
  const max = Math.max(...rows.map((d) => d.downloads));
  const per = weekly ? "week" : "day";
  const opts = {
    data: rows,
    x: "day",
    y: "downloads",
    series: "name",
    xLabel: null,
    yLabel: `Downloads a ${per}`,
    height: 200,
    title: `${weekly ? "Weekly" : "Daily"} downloads of ${data.name}`,
    alt: `${weekly ? "Weekly" : "Daily"} downloads of ${data.name}${data.formerly ? ` and its former name ${data.formerly}` : ""}, ${first} to ${last}: ${shortCount(total)} in all, at most ${shortCount(max)} in a ${per}.`,
    ...(weekly
      ? {
          caption:
            "Each point is a week's downloads, Monday to Sunday (UTC), at the Monday it starts; a week not yet over is left out.",
        }
      : {}),
    source: {
      name: "npm downloads API",
      href: `https://www.npmjs.com/package/${encodeURIComponent(data.name)}`,
    },
  } as const;
  return <ChartFrame draw={(width, fit) => areaChart({ ...opts, width, ...fit })} />;
}
