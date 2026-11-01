import { heatStrip, timeline, type TimelineEvent } from "enarratio";
import { areaChart } from "enarratio/lite/area";
import { barChart } from "enarratio/lite/bar";
import { lineChart } from "enarratio/lite/line";
import { ChartFrame } from "capsomer/react/chart-frame";
import "capsomer/chart-frame.css";
import { Panel } from "capsomer/react/panel";
import type { ReactNode } from "react";
import { useApp } from "../app/ctx";
import { fetchClaimsAggregate, useAnswer } from "../lib/api";
import { cfNoData, cfOk, ringOf, slotStart } from "../lib/derive";
import { DAY, HOUR, MIN, SLOT_MS, fmtN, ms, pct, shortId, utc } from "../lib/format";
import { useTrends } from "../lib/trends";
import type { ClaimsAgreement, ClaimsGroup, ClaimsWaitRow, PortalPlan, PortalTrends, SiteSnapshot, TrendCiRepo } from "../types";
import { errorTotals } from "../ui/charts";
import { St } from "../ui/icons";

// The Portal's charts drawn with Enarratio's primitives (docs/design/design-portal-evaluation.md
// section 3; ruled 2026-10-09, DECIDE 6 and 7): 1 minutes of Dustin per week (Needs you),
// 4 Tonight as a timeline (Queue), 10 the backup retention slots and 11 the default branches
// by day (Health). Chart 8, each site's uptime, is ui/charts.tsx's UptimeTicks, and its
// uptimeStrip is in the initial bundle with the Sites table. Charts 2 (waiting), 3 (the
// queue), 5 (claims against verified), 6 (cost), 7 (merges) and 9 (errors and deploys) are
// Enarratio's bar, line and area charts from enarratio/lite, which drop Observable Plot and
// fit the chunk budget. This module loads with the page that shows a chart, never in the
// initial bundle. Each is Enarratio's whole figure (title, finding, notes, source, "Show data")
// in Capsomer's chart frame, which redraws it to its width.

// A later read that failed keeps the last answer on screen; this says so, so the failure is
// not hidden behind numbers that are no longer current.
function Stale({ error }: { error: string | null }) {
  return error ? <p className="faint">Not refreshed: {error}</p> : null;
}

// A chart that is a panel of its own: the panel's surface and address, with the chart's title
// and source in Enarratio's figure rather than a second header.
function ChartPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <section className="cap-panel" id={id}>
      <div className="cap-panel-body body">{children}</div>
    </section>
  );
}

// ---- 1. Minutes of Dustin per week ------------------------------------------------------

/** The first chart on Needs you: this week's minutes, the change on last week with its unit
 *  and direction, and eight weeks as a line with its axes and week dates (Dustin's review of
 *  2026-10-11: the tile was half width, a sparkline with no axes, and its words jargon). */
export function MinutesTile() {
  const { data, error, loading } = useTrends();
  if (loading && !data) return null;
  if (!data) return <p className="faint minutes-none">Your time per week could not be read: {error}</p>;
  return (
    <>
      <Minutes minutes={data.minutes} />
      <Stale error={error} />
    </>
  );
}

/** The change on last week in words, with its direction: more of Dustin's time is worse. */
export function minutesChange(now: number, before: number | null): { text: string; dir: "up" | "down" | "same" | null } {
  if (before === null) return { text: "no week before to compare", dir: null };
  const d = now - before;
  if (d === 0) return { text: "the same as last week", dir: "same" };
  return { text: `${Math.abs(d)} min ${d > 0 ? "more" : "less"} than last week`, dir: d > 0 ? "up" : "down" };
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
  return <ChartFrame className="minutes-chart" draw={(width) => lineChart({ ...opts, width })} />;
}

// ---- 2. Where does waiting go? ----------------------------------------------------------

const MOST_CLASSES = 10;

const hours = (v: number) => (v >= 1 ? `${v.toFixed(1)} h` : `${Math.round(v * 60)} min`);

// The gate classes and who ended a wait, in words (Dustin's review of 2026-10-11: the chart
// showed needs_human and push_branch). A compound command's classes are joined with "+"
// (src/ops-types/, ClaimsWaitRow); a class this list does not know reads as words.
const GATE_WORDS: Record<string, string> = {
  needs_human: "A step only a person takes",
  additive_migration: "Applying a migration",
  migration: "Applying a migration",
  push_branch: "Pushing a branch",
  open_pr: "Opening a pull request",
  unreadable_gate: "A gate that could not be read",
};
const ENDED_BY_WORDS: Record<string, string> = { human: "You", policy: "The signed policy", seat: "A session acting for you" };
const words = (code: string) => code.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function gateWords(gate: string): string {
  return gate
    .split("+")
    .map((g, i) => {
      const w = GATE_WORDS[g] ?? words(g);
      return i === 0 ? w : w.charAt(0).toLowerCase() + w.slice(1);
    })
    .join(", then ");
}

/** Total ended waiting per gate class, split by who ended it, longest first. A median
 *  cannot be combined across namespaces and says nothing of how often a gate waits; the
 *  total adds up, so the longest bar is where the hours went. */
export function waitRows(waits: ClaimsWaitRow[]): { rows: Array<{ gate: string; endedBy: string; hours: number }>; classes: number; shown: number; allHours: number } {
  const byClass = new Map<string, Map<string, number>>();
  for (const w of waits) {
    const ends = byClass.get(w.gate_class) ?? new Map<string, number>();
    ends.set(w.ended_by, (ends.get(w.ended_by) ?? 0) + w.waited_ms_total / HOUR);
    byClass.set(w.gate_class, ends);
  }
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const ranked = [...byClass].sort(([, a], [, b]) => sum(b) - sum(a)).slice(0, MOST_CLASSES);
  const rows = ranked.flatMap(([gate, ends]) => [...ends].map(([endedBy, h]) => ({ gate: gateWords(gate), endedBy: ENDED_BY_WORDS[endedBy] ?? words(endedBy), hours: Math.round(h * 100) / 100 })));
  return { rows, classes: byClass.size, shown: ranked.length, allHours: [...byClass.values()].reduce((a, m) => a + sum(m), 0) };
}

/** The header chart on Needs you: one bar per gate class, stacked by who ended the wait,
 *  over the last 14 days. Reads the claims aggregate once when the page opens. */
// The claims read behind chart 2, kept for ten minutes like useTrends: the page can be left
// and reopened without reading the aggregate again. The window is fixed when the read is made.
export function WaitingChart() {
  const { now } = useApp();
  const load = useAnswer(["claims", "waits"], () => fetchClaimsAggregate({ namespace: "", agent: "", since: new Date(now - 14 * DAY).toISOString(), until: "" }), { staleTime: 10 * 60_000 });
  if (!load.data && load.loading) return null;
  if (!load.data) return <p className="faint wait-none">Where waiting goes could not be read: {load.error}</p>;
  const { rows, classes, shown, allHours } = waitRows(load.data.waits);
  if (!rows.length) return <p className="faint wait-none">No wait ended in the last 14 days.</p>;
  const top = rows.filter((r) => r.gate === rows[0]!.gate).reduce((a, r) => a + r.hours, 0);
  const opts = {
    data: rows,
    x: "gate",
    y: "hours",
    series: "endedBy",
    layout: "stacked",
    orientation: "horizontal",
    xLabel: null,
    yLabel: "Waiting that ended (hours)",
    formatValue: hours,
    height: 56 + shown * 30,
    title: "Where does waiting go?",
    alt: `Waiting that ended in the last 14 days, by what the job waited for and who answered: ${hours(allHours)} in all, ${hours(top)} of it at ${rows[0]!.gate.toLowerCase()}.`,
    caption: `Total time between a job stopping at a gate and the gate being answered, last 14 days${classes > shown ? `; the ${shown} longest of ${classes} gate classes` : ""}.${load.data.truncated.includes("waits") ? " Cut at the read's row limit, so the figure is low." : ""}`,
    source: { name: "Claims aggregate, gate waits" },
  } as const;
  return <ChartFrame className="wait-chart" draw={(width) => barChart({ ...opts, width })} />;
}

// ---- 3. Is the queue growing or draining? -------------------------------------------------

/** Queue's header chart: jobs open at each day's end over 14 days. The trends route carries
 *  posted, ended and open, not the four states (queued, claimed, blocked, parked), so this
 *  is the one area and the days' posted and ended are said in words. */
export function QueueChart() {
  const { data, error, loading } = useTrends();
  if (loading && !data) return null;
  if (!data) return <p className="faint">The queue's last 14 days could not be read: {error}</p>;
  const days = data.queue;
  if (!days.length) return null;
  const first = days[0]!;
  const last = days[days.length - 1]!;
  const posted = days.reduce((a, d) => a + d.posted, 0);
  const ended = days.reduce((a, d) => a + d.ended, 0);
  const net = posted - ended;
  const opts = {
    data: days.map((d) => ({ day: d.day, open: d.open })),
    x: "day",
    y: "open",
    xLabel: null,
    yLabel: "Open jobs",
    height: 200,
    title: "Is the queue growing or draining?",
    alt: `Jobs open at each day's end, ${first.day} to ${last.day}: ${last.open} now, ${net === 0 ? "unchanged" : net > 0 ? `up ${net}` : `down ${-net}`} over the window. ${posted} posted, ${ended} ended.`,
    caption: `${posted} posted and ${ended} ended in 14 days, so the queue ${net === 0 ? "held" : net > 0 ? "grew" : "drained"} by ${Math.abs(net)}. Open means queued, claimed, blocked or parked.`,
    source: { name: "D1 jobs, 14 days" },
  } as const;
  return (
    <ChartPanel id="queue-trend">
      <Stale error={error} />
      <ChartFrame draw={(width) => areaChart({ ...opts, width })} />
    </ChartPanel>
  );
}

// ---- 3b. Where is the work waiting? ------------------------------------------------------------

const JOB_STATES = ["Blocked", "Running", "Queued"] as const;

export interface ProjectCounts {
  project: string;
  blocked: number;
  running: number;
  queued: number;
}

/** Jobs' "By project" panel: each project's blocked, running and queued jobs as one stacked
 *  bar, the counts in the figure's table. Status colors through Capsomer's color pairs. */
export function ProjectChart({ counts }: { counts: ProjectCounts[] }) {
  if (!counts.length) return null;
  const sum = (k: "blocked" | "running" | "queued") => counts.reduce((a, c) => a + c[k], 0);
  const rows = counts.flatMap((c) => [
    { project: c.project, state: "Blocked", jobs: c.blocked },
    { project: c.project, state: "Running", jobs: c.running },
    { project: c.project, state: "Queued", jobs: c.queued },
  ]);
  const opts = {
    data: rows,
    x: "project",
    y: "jobs",
    series: "state",
    seriesDomain: JOB_STATES,
    layout: "stacked",
    orientation: "horizontal",
    colors: { Blocked: "var(--warn)", Running: "var(--info)", Queued: "var(--nodata)" },
    xLabel: null,
    yLabel: "Jobs",
    height: 64 + 36 * counts.length,
    title: "Where is the work waiting?",
    alt: `Live jobs per project, ${counts.length} ${counts.length === 1 ? "project" : "projects"}: ${sum("blocked")} blocked, ${sum("running")} running, ${sum("queued")} queued.`,
    source: { name: "D1 jobs, the live window" },
  } as const;
  return <ChartFrame draw={(width) => barChart({ ...opts, width })} />;
}

// ---- 5. Does each agent's claim match what was verified? -----------------------------------

const AGREEMENTS: readonly ClaimsAgreement[] = ["agree", "disagree", "unclaimed", "unchecked"];

/** Agreement counts per agent, summed over the checks. An agent with no check is left out. */
export function agreementRows(groups: ClaimsGroup[]): Array<{ agent: string; agreement: ClaimsAgreement; checks: number }> {
  const per = new Map<string, Record<ClaimsAgreement, number>>();
  for (const g of groups) {
    const key = g.agent ?? "no claim yet";
    const sum = per.get(key) ?? { agree: 0, disagree: 0, unclaimed: 0, unchecked: 0 };
    for (const counts of Object.values(g.evaluations)) for (const a of AGREEMENTS) sum[a] += counts[a];
    per.set(key, sum);
  }
  return [...per].filter(([, c]) => AGREEMENTS.some((a) => c[a] > 0)).flatMap(([agent, c]) => AGREEMENTS.map((agreement) => ({ agent, agreement, checks: c[agreement] })));
}

export function AgreementChart({ groups }: { groups: ClaimsGroup[] }) {
  const rows = agreementRows(groups);
  if (!rows.length) return null;
  const agents = new Set(rows.map((r) => r.agent)).size;
  const sum = (a: ClaimsAgreement) => rows.filter((r) => r.agreement === a).reduce((n, r) => n + r.checks, 0);
  const opts = {
    data: rows,
    x: "agent",
    y: "checks",
    series: "agreement",
    seriesDomain: AGREEMENTS,
    // A color that means a status takes the status token (capsomer/enarratio.css themes the pair).
    colors: { agree: "var(--ok)", disagree: "var(--crit)", unclaimed: "var(--nodata)", unchecked: "var(--warn)" },
    layout: "grouped",
    xLabel: null,
    yLabel: "Checks",
    // Capped, so the drawing is not scaled down to unreadable text; Enarratio's frame scrolls past it.
    width: Math.min(900, Math.max(560, 150 * agents)),
    height: 260,
    title: "Does each agent's claim match what was verified?",
    alt: `Claims against what the Worker verified, for ${agents} ${agents === 1 ? "agent" : "agents"}: ${sum("agree")} agree, ${sum("disagree")} disagree, ${sum("unclaimed")} unclaimed, ${sum("unchecked")} unchecked.`,
    source: { name: "Every check, summed per agent" },
  } as const;
  return (
    <ChartPanel id="claim-agreement">
      <ChartFrame chart={barChart(opts)} />
    </ChartPanel>
  );
}

// ---- 6. What does the work cost? ------------------------------------------------------------

/** Agents' chart: model spend per week. */
export function CostChart() {
  const { data, error, loading } = useTrends();
  if (loading && !data) return null;
  if (!data) return <p className="faint">Weekly cost could not be read: {error}</p>;
  const weeks = data.cost.weeks;
  if (!weeks.some((w) => w.usd !== null)) return <p className="faint">No model cost was recorded in these {weeks.length} weeks.</p>;
  const now = weeks[weeks.length - 1]!;
  const opts = {
    data: weeks.map((w) => ({ week: w.start, usd: w.usd })),
    x: "week",
    y: "usd",
    xLabel: "Week starting",
    yLabel: "Model spend (USD)",
    formatValue: (v: number) => `$${v.toFixed(2)}`,
    height: 240,
    title: "What does the work cost?",
    alt: `Model spend per week for the last ${weeks.length} weeks${now.usd === null ? ", none recorded this week" : `, $${now.usd.toFixed(2)} this week`}. Weeks with no recorded cost are gaps.`,
    caption: "A week with no job outcome carrying a cost is a gap, not a free week.",
    source: { name: "Job outcomes, telemetry cost, an estimate" },
  } as const;
  return (
    <ChartPanel id="cost-trend">
      <Stale error={error} />
      <ChartFrame draw={(width) => lineChart({ ...opts, width })} />
    </ChartPanel>
  );
}

// ---- 7. How much merges with no human? -------------------------------------------------------

const MERGE_KINDS = ["auto", "approved", "seat", "closed"] as const;
const MERGE_NAME: Record<(typeof MERGE_KINDS)[number], string> = { auto: "Merged by policy", approved: "Merged on approval", seat: "Merged by you", closed: "Closed unmerged" };

/** Pull requests' chart: each week's merges and closes by who acted, stacked. Enarratio's bar
 *  chart has no event marker, so each rollback is listed under it. */
export function MergesChart() {
  const { data, error, loading } = useTrends();
  if (loading && !data) return null;
  if (!data) return <p className="faint">Merges per week could not be read: {error}</p>;
  const weeks = data.merges.weeks;
  const rollbacks = data.merges.rollbacks;
  const rows = weeks.flatMap((w) => MERGE_KINDS.map((k) => ({ week: w.week.slice(5), kind: MERGE_NAME[k], pulls: w[k] })));
  const total = (k: (typeof MERGE_KINDS)[number]) => weeks.reduce((a, w) => a + w[k], 0);
  const merged = total("auto") + total("approved") + total("seat");
  const opts = {
    data: rows,
    x: "week",
    y: "pulls",
    series: "kind",
    seriesDomain: MERGE_KINDS.map((k) => MERGE_NAME[k]),
    layout: "stacked",
    // Labels are the ISO week without its year, so eight fit a phone's width.
    xLabel: `ISO week, ${weeks[0]!.week.slice(0, 4)} on`,
    yLabel: "Pull requests",
    height: 240,
    title: "How much merges with no human, and is that rising?",
    subtitle: merged ? `${Math.round((total("auto") / merged) * 100)}% of the ${merged} merged in ${weeks.length} weeks went through on the policy alone.` : `Nothing merged in ${weeks.length} weeks.`,
    alt: `Pull requests merged or closed per week for ${weeks.length} weeks: ${total("auto")} merged by policy with no human, ${total("approved")} on an approval, ${total("seat")} by you, ${total("closed")} closed unmerged. ${rollbacks.length} ${rollbacks.length === 1 ? "rollback" : "rollbacks"}.`,
    caption: rollbacks.length
      ? `Rollbacks: ${rollbacks.map((r) => `${r.at.slice(0, 10)} ${r.repo}${r.pr === null ? "" : ` #${r.pr}`}${r.outcome === "rollback_failed" ? " (rollback failed)" : ""}`).join("; ")}.`
      : "No deploy was rolled back in this window.",
    source: { name: "Audit log, weekly" },
  } as const;
  return (
    <ChartPanel id="merge-trend">
      <Stale error={error} />
      <ChartFrame className="merge-chart" draw={(width) => barChart({ ...opts, width })} />
    </ChartPanel>
  );
}

// ---- 9. Did a deploy cause errors? --------------------------------------------------------------

/** The site drawer's chart: the error rate for each of the last 24 hours, a line at the 1%
 *  alert, and a marker at each deploy in the window. The requests the old drawing showed as
 *  bars are in the caption's totals. */
export function ErrorRate({ site }: { site: SiteSnapshot }) {
  const cf = cfOk(site);
  const why = cfNoData(site.cloudflare);
  const title = "Requests and error rate, 24 hours";
  if (!cf) return <ChartFrame noData={{ title, reason: why ?? "" }} />;
  if (!cf.errors24) return <ChartFrame noData={{ title, reason: cf.errors_reason ?? "the analytics read failed" }} />;
  const e = cf.errors24;
  if (!e.length) return <ChartFrame noData={{ title, reason: "the analytics read returned no hours" }} />;
  const rates = e.map((x) => (x.requests ? (x.errors / x.requests) * 100 : 0));
  const peak = Math.max(...rates);
  const t0 = ms(e[0]!.hour);
  const t1 = ms(e[e.length - 1]!.hour) + HOUR;
  const inWindow = cf.deploys.filter((d) => ms(d.created_on) >= t0 && ms(d.created_on) <= t1);
  const tot = errorTotals(e);
  const opts = {
    data: e.map((x, i) => ({ hour: new Date(ms(x.hour)).toISOString(), rate: Math.round(rates[i]! * 100) / 100 })),
    x: "hour",
    y: "rate",
    xLabel: null,
    yLabel: "Error rate (%)",
    formatValue: (v: number) => `${v}%`,
    references: [{ y: 1, label: "Alert at 1%" }],
    markers: inWindow.map((d) => ({ x: new Date(ms(d.created_on)).toISOString(), label: `Deploy ${shortId(d.version_id ?? d.id)}` })),
    height: 220,
    title,
    subtitle: `${fmtN(tot.req)} requests and ${fmtN(tot.err)} errors (${pct(tot.rate)})`,
    alt: `Error rate for ${site.name} over the last 24 hours: peak ${peak.toFixed(2)}% in an hour, ${pct(tot.rate)} overall, ${inWindow.length} ${inWindow.length === 1 ? "deploy" : "deploys"} in the window.`,
    caption: inWindow.length ? `Deploys: ${inWindow.map((d) => `${shortId(d.version_id ?? d.id)} at ${utc(ms(d.created_on))}${d.message ? ` (${d.message})` : ""}`).join("; ")}.` : "No deploy in the window.",
    source: { name: "Cloudflare Workers analytics, hourly" },
  } as const;
  return <ChartFrame className="error-rate" draw={(width) => lineChart({ ...opts, width })} />;
}

// ---- 9b. Deploys and downtime, one lane per site ------------------------------------------

/** Health's Deploys tab: each deploy a point, each run of failed probes or of missing watcher
 *  passes a span, one lane per site. Enarratio gives way to a plain list where the room is
 *  narrow, so a phone reads the events instead of scrolling a drawing. */
export function DeployTimeline({ sites, days }: { sites: SiteSnapshot[]; days: number }) {
  const { now } = useApp();
  const t0 = now - days * DAY;
  const events: TimelineEvent[] = [];
  const lanes = sites.map((s) => s.name);
  let deploys = 0;
  let downSlots = 0;
  const noData: string[] = [];
  for (const s of sites) {
    const ring = ringOf(s);
    // Consecutive slots of one kind make one span.
    for (let k = 0; k < ring.length; ) {
      const c = ring[k];
      let end = k + 1;
      while (end < ring.length && ring[end] === c) end++;
      const from = Math.max(t0, slotStart(s, k));
      const to = slotStart(s, end - 1) + SLOT_MS;
      if (c !== "1" && to > t0) {
        if (c === "0") downSlots += end - k;
        events.push({ lane: s.name, label: c === "0" ? `Probe failed, ${end - k} half-hour ${end - k === 1 ? "slot" : "slots"}` : "No watcher pass", status: c === "0" ? "error" : "unknown", from, to });
      }
      k = end;
    }
    const why = cfNoData(s.cloudflare);
    if (why) noData.push(`${s.name}: ${why}`);
    for (const d of cfOk(s)?.deploys ?? []) {
      const t = ms(d.created_on);
      if (t < t0 || t > now) continue;
      deploys++;
      events.push({ lane: s.name, label: `Deploy ${shortId(d.version_id ?? d.id)}${d.triggered_by ? `, ${d.triggered_by}` : ""}${d.message ? `: ${d.message}` : ""}`, status: "ok", at: t });
    }
  }
  const notes = [...(days > 7 ? ["The probe ring holds 7 days; older downtime is not shown."] : []), ...(noData.length ? [`Deploys not read for ${noData.join("; ")}.`] : [])];
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
  return <ChartFrame className="deploy-timeline" draw={(width) => timeline({ ...opts, width })} />;
}

// ---- 4. Tonight -------------------------------------------------------------------------

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
    title: "Tonight's plan",
    label: `Tonight's plan, ${events.length} ${events.length === 1 ? "job" : "jobs"} by repo, as if it started when the plan was read (UTC)`,
    source: { name: "The overnight planner's estimates" },
  };
  return <ChartFrame className="tonight-chart" draw={(width) => timeline({ ...opts, width })} />;
}

// ---- 10. Backup retention slots ---------------------------------------------------------

// Drawn as a heat strip on the family ramp (capsomer/enarratio.css), a missing slot at its
// strong end, at full height: as an uptime strip a missing slot was a third-height tick that
// read as an underline. The subtitle and each cell's hover text say kept or missing.
const missing = (v: number): string => (v >= 1 ? "missing" : "kept");

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
              values: slots.map((s) => (s.filled ? 0 : 1)),
              min: 0,
              max: 1,
              title: name,
              subtitle: `${kept} of ${slots.length} kept`,
              label: `${name} backups, the last ${span}`,
              height: 20,
              cellLabels: slots.map((s) => s.key),
              formatValue: missing,
            };
            return <ChartFrame key={name} inline draw={(width) => heatStrip({ ...opts, width })} />;
          })
        )}
      </div>
    </Panel>
  );
}

// ---- 11. Default branches by day --------------------------------------------------------

// Green 0, red 1, no run yet as no value: a heat strip's two ends on the family ramp, so red
// reads as the strong end and a day with no verdict is drawn as missing, never as green.
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
              // A branch with no verdict in the window has nothing to draw; its line says so.
              if (!r.days.some((d) => d.state !== "none")) {
                return (
                  <div className="slot-row slot-head" key={r.namespace} data-ci={r.namespace}>
                    <b>{r.namespace}</b> <St kind="nodata">no run in 14 days</St>
                  </div>
                );
              }
              const opts = {
                values: ciValues(r),
                min: 0,
                max: 1,
                title: r.namespace,
                subtitle: streak ? `red for ${streak === r.days.length ? "at least " : ""}${streak} ${streak === 1 ? "day" : "days"}` : "green",
                label: `${r.namespace} default branch, red or green by day`,
                notes: r.truncated ? "Over 100 runs; early days may be missing some." : undefined,
                height: 20,
                cellLabels: r.days.map((d) => d.day),
                formatValue: (v: number) => (v >= 1 ? "red" : "green"),
              };
              return (
                <div className="slot-row" key={r.namespace} data-ci={r.namespace}>
                  <ChartFrame inline draw={(width) => heatStrip({ ...opts, width })} />
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
