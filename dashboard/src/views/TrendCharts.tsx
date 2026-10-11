import { heatStrip, heatStripTable, sparkline, sparklineTable, timeline, timelineTable, uptimeStrip, uptimeStripTable, type TimelineEvent, type UptimeSlot } from "enarratio";
import { Panel } from "capsomer/react/panel";
import { useTrends } from "../lib/trends";
import type { PortalPlan, PortalTrends, TrendCiRepo } from "../types";
import { EnarChart } from "../ui/Enar";
import { St } from "../ui/icons";

// The Portal's charts drawn with Enarratio's primitives (docs/design/design-portal-evaluation.md
// section 3; ruled 2026-10-09, DECIDE 6 and 7): 1 minutes of Dustin per week (Needs you),
// 4 Tonight as a timeline (Queue), 10 the backup retention slots and 11 the default branches
// by day (Health). Chart 8, each site's uptime, is ui/charts.tsx's UptimeTicks, and its
// uptimeStrip is in the initial bundle with the Sites table. Charts 2, 3, 5, 6, 7 and 9 need
// Enarratio's bar, line and area charts, which are too large for the Portal's budget until
// enarratio job_26efccfa9c7b. This module loads with the page that shows a chart, never in
// the initial bundle. Each chart carries its table companion.

const TABLE = { dataTable: "details" } as const;

// A later read that failed keeps the last answer on screen; this says so, so the failure is
// not hidden behind numbers that are no longer current.
function Stale({ error }: { error: string | null }) {
  return error ? <p className="faint">Not refreshed: {error}</p> : null;
}

// ---- 1. Minutes of Dustin per week ------------------------------------------------------

/** The header tile on Needs you: this week's minutes, the change on last week in words,
 *  and eight weeks as a sparkline. Says it is an estimate (the route's note). */
export function MinutesTile() {
  const { data, error, loading } = useTrends();
  if (loading && !data) return null;
  if (!data) return <p className="faint minutes-none">Minutes per week could not be read: {error}</p>;
  return (
    <>
      <Minutes minutes={data.minutes} />
      <Stale error={error} />
    </>
  );
}

function Minutes({ minutes }: { minutes: PortalTrends["minutes"] }) {
  const weeks = minutes.weeks;
  const now = weeks[weeks.length - 1];
  const before = weeks[weeks.length - 2];
  if (!now) return null;
  const delta = before ? now.minutes - before.minutes : null;
  const opts = {
    values: weeks.map((w) => w.minutes),
    label: `Minutes of Dustin per week, ${weeks[0]!.week} to ${now.week}`,
    formatValue: (v: number) => `${v} min`,
  };
  return (
    <div className="tile minutes-tile" data-chart="minutes">
      <div className="t1">
        <span className="v">
          {now.minutes} <small>min this week</small>
        </span>
        <span className="l">{delta === null ? "no week before" : `${delta > 0 ? "+" : ""}${delta} vs last week`}</span>
      </div>
      <EnarChart draw={() => ({ svg: sparkline(opts), table: sparklineTable(opts, TABLE).markup })}>
        <figcaption className="d">
          {now.decisions} {now.decisions === 1 ? "decision" : "decisions"} in {now.sessions} {now.sessions === 1 ? "session" : "sessions"} this week. An estimate: {minutes.note.replace(/^An estimate: /, "")}
          {minutes.truncated ? " Cut at the row limit, so the figure is low." : ""}
        </figcaption>
      </EnarChart>
    </div>
  );
}

// ---- 4. Tonight -------------------------------------------------------------------------

const MIN = 60_000;

/** Tonight's plan as a timeline, one lane per repo, as if it started when the plan was read:
 *  the plan holds estimates, not a start time, and Enarratio's axis is a UTC clock. Light
 *  lanes start together; heavy lanes share one session, so they run one after another. A
 *  gated job is a warning. The window runs a tenth past the budget or the last job, so the
 *  last tick is not drawn on the edge. */
function planEvents(plan: PortalPlan): { events: TimelineEvent[]; start: number; end: number } {
  const events: TimelineEvent[] = [];
  const start = Date.parse(plan.generated);
  let heavyAt = start;
  let end = start + plan.budget_minutes * MIN;
  for (const lane of plan.lanes) {
    let at = lane.heavy ? heavyAt : start;
    for (const j of lane.jobs) {
      const to = at + Math.max(1, j.estimate_minutes) * MIN;
      events.push({ lane: lane.repo, label: j.title, status: j.gated ? "warning" : "ok", from: at, to });
      at = to;
    }
    if (lane.heavy) heavyAt = at;
    end = Math.max(end, at);
  }
  return { events, start, end: end + (end - start) / 10 };
}

export function TonightTimeline({ plan }: { plan: PortalPlan }) {
  const { events, start, end } = planEvents(plan);
  if (!events.length) return null;
  const opts = {
    events,
    lanes: plan.lanes.filter((l) => l.jobs.length).map((l) => l.repo),
    start,
    end,
    label: `Tonight's plan, ${events.length} ${events.length === 1 ? "job" : "jobs"} by repo, as if it started when the plan was read (UTC)`,
  };
  return <EnarChart className="tonight-chart" draw={() => ({ svg: timeline(opts), table: timelineTable(opts, TABLE).markup })} />;
}

// ---- 10. Backup retention slots ---------------------------------------------------------

const SLOT = (filled: boolean): Extract<UptimeSlot, string> => (filled ? "up" : "down");

export function BackupSlots() {
  const { data, error, loading } = useTrends();
  const b = data?.backups;
  return (
    <Panel flush title="Retention slots" src="backup bucket, complete runs" id="backup-slots">
      <div className="body stack-gap">
        {b && <Stale error={error} />}
        {!b ? (
          loading ? null : <St kind="nodata">Not read: {error}</St>
        ) : !b.slots ? (
          <St kind="nodata">{b.error}</St>
        ) : (
          ([
            ["Daily", "14 days", b.slots.daily],
            ["Weekly", "8 weeks", b.slots.weekly],
            ["Monthly", "6 months", b.slots.monthly],
          ] as const).map(([name, span, slots]) => {
            const kept = slots.filter((s) => s.filled).length;
            const opts = {
              slots: slots.map((s) => ({ status: SLOT(s.filled), label: s.key })),
              label: `${name} backups, the last ${span}`,
              width: 560,
              height: 20,
            };
            return (
              <div className="slot-row" key={name} data-slots={name.toLowerCase()}>
                <div className="slot-head">
                  <b>{name}</b> <span className="faint num">{kept} of {slots.length} kept</span>
                </div>
                <EnarChart draw={() => ({ svg: uptimeStrip(opts), table: uptimeStripTable(opts, TABLE).markup })} />
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
}

// ---- 11. Default branches by day --------------------------------------------------------

// Green 0, red 1, no run yet as no value: a heat strip's two ends, so red reads as the
// strong end and a day with no verdict is drawn as missing, never as green.
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
    <Panel flush title="The last 14 days" src="GitHub, default branch runs, kept an hour" id="ci-history">
      <div className="body stack-gap">
        {ci && <Stale error={error} />}
        {!ci ? (
          loading ? null : <St kind="nodata">Not read: {error}</St>
        ) : (
          <>
            {ci.repos.map((r) => {
              const streak = redStreak(r);
              const opts = {
                values: ciValues(r),
                min: 0,
                max: 1,
                label: `${r.namespace} default branch, red or green by day`,
                width: 560,
                height: 20,
                cellLabels: r.days.map((d) => d.day),
                formatValue: (v: number) => (v >= 1 ? "red" : "green"),
              };
              return (
                <div className="slot-row" key={r.namespace} data-ci={r.namespace}>
                  <div className="slot-head">
                    <b>{r.namespace}</b>{" "}
                    {streak ? <St kind="crit">{`red for ${streak === r.days.length ? "at least " : ""}${streak} ${streak === 1 ? "day" : "days"}`}</St> : r.days.some((d) => d.state !== "none") ? <St kind="ok">green</St> : <St kind="nodata">no run in 14 days</St>}
                    {r.truncated && <span className="faint"> (over 100 runs; early days may be missing some)</span>}
                  </div>
                  {/* A branch with no verdict in the window has nothing to draw; its line says so. */}
                  {r.days.some((d) => d.state !== "none") && <EnarChart className="ci-strip" draw={() => ({ svg: heatStrip(opts), table: heatStripTable(opts, TABLE).markup })} />}
                </div>
              );
            })}
            {ci.not_read.map((n) => (
              <div className="slot-row slot-head" key={n.namespace}>
                <b>{n.namespace}</b> <St kind="nodata">{`not read: ${n.error}`}</St>
              </div>
            ))}
          </>
        )}
      </div>
    </Panel>
  );
}
