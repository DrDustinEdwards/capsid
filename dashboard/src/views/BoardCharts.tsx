import { progressRing, tableChart, timeline, type TimelineEvent } from "enarratio";
import { barChart } from "enarratio/lite/bar";
import { ChartFrame } from "capsomer/react/chart-frame";
import { parse } from "capsomer/behavior/time";
import { useApp } from "../app/ctx";
import { agentState, nsList, rosterAgents } from "../lib/agents";
import { DAY, ago } from "../lib/format";
import { useHtmlLinks } from "../lib/router";
import type { AgentDaily, BoardHandoffRow, OpsTask, PortalBoard, PortalPrs } from "../types";
import { memoryDocHref } from "./memory-links";

// The Board's, Memory's, Pull requests' and Agents' charts drawn in the browser with Enarratio's core and lite
// charts (no Observable Plot), and the frame for the charts the Worker draws (src/figures.ts). A chunk of its own
// (views/charts.ts), never in the initial bundle.

interface RowLink {
  href: string;
  // A Portal path, moved to in the app; otherwise another site, opened in a new tab.
  route: boolean;
}

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** A tableChart's row headers as links, in data order: Enarratio's cells are text. */
export function linkRows(html: string, links: ReadonlyArray<RowLink | null>): string {
  let i = 0;
  return html.replace(/<th scope="row">([\s\S]*?)<\/th>/g, (whole, inner: string) => {
    const l = links[i++];
    if (!l) return whole;
    const how = l.route ? " data-route" : ' target="_blank" rel="noopener noreferrer"';
    return `<th scope="row"><a href="${attr(l.href)}"${how}>${inner}</a></th>`;
  });
}

function LinkedChart({ html, className }: { html: string; className?: string }) {
  const { onClick } = useHtmlLinks();
  return (
    <div onClick={onClick}>
      <ChartFrame chart={html} className={className} />
    </div>
  );
}

/** A chart the Worker drew, as it sent it: the same string on the server and in the browser. */
export function ServerFigure({ html, narrow }: { html: string; narrow?: string }) {
  if (!narrow) return <ChartFrame chart={html} />;
  return (
    <>
      <div className="fig-wide">
        <ChartFrame chart={html} />
      </div>
      <div className="fig-narrow">
        <ChartFrame chart={narrow} />
      </div>
    </>
  );
}

const sortHandoffs = (a: BoardHandoffRow, b: BoardHandoffRow) =>
  (b.checklist?.open ?? 0) - (a.checklist?.open ?? 0) || b.updated_at.localeCompare(a.updated_at);

export function HandoffsProgress({ board }: { board: PortalBoard }) {
  const { done_items: done, open_items: open, open: count } = board.handoffs;
  const total = done + open;
  if (total === 0) return null;
  return (
    <ChartFrame
      inline
      chart={progressRing({
        value: done,
        max: total,
        size: 56,
        title: "Checklist items done",
        alt: `${done} of ${total} checklist items done across ${count} open handoffs.`,
      })}
    />
  );
}

export function HandoffsTable({ board }: { board: PortalBoard }) {
  const { now } = useApp();
  const { href } = useHtmlLinks();
  const rows = [...board.handoffs.list].sort(sortHandoffs);
  const data = rows.map((h) => ({
    title: h.title || h.path,
    project: h.namespace,
    touched: ago(parse(h.updated_at), now),
    progress: h.checklist
      ? `${h.checklist.done} of ${h.checklist.done + h.checklist.open} done`
      : "no checklist",
    open: h.checklist?.open ?? 0,
  }));
  const html = tableChart({
    id: "open-handoffs",
    data,
    columns: [
      { field: "title", label: "Handoff" },
      { field: "project", label: "Project" },
      { field: "touched", label: "Last touched" },
      { field: "progress", label: "Checklist" },
      { field: "open", label: "Open items", kind: "bar" },
    ],
    title: "Open handoffs",
    alt: `${rows.length} open handoffs, most open items first: ${board.handoffs.open_items} items open in all.`,
    summary: false,
  });
  return (
    <LinkedChart
      html={linkRows(
        html,
        rows.map((h) => ({ href: href(memoryDocHref(h.namespace, h.path)), route: true })),
      )}
    />
  );
}

export function ThreadsChart({ threads }: { threads: PortalBoard["threads"] }) {
  const busiest = Object.entries(
    threads.per_day.reduce<Record<string, number>>(
      (a, r) => ((a[r.day] = (a[r.day] ?? 0) + r.threads), a),
      {},
    ),
  ).reduce((a, b) => (b[1] > a[1] ? b : a), ["", 0]);
  const opts = {
    data: threads.per_day,
    x: "day",
    xType: "time",
    interval: "day",
    y: "threads",
    series: "project",
    seriesDomain: threads.projects,
    layout: "stacked",
    wholeNumbers: true,
    xLabel: null,
    yLabel: "Threads",
    height: 220,
    title: `How many threads started each day?`,
    subtitle: `${threads.total} in ${threads.days} days`,
    alt: `Threads started per day over the last ${threads.days} days, by project: ${threads.total} in all${busiest[1] ? `, the most ${busiest[1]} on ${busiest[0]}` : ""}.`,
    source: { name: "Capsid audit log, start of session" },
  } as const;
  return <ChartFrame draw={(width, fit) => barChart({ ...opts, width, ...fit })} />;
}

export function RecentThreads({ threads }: { threads: PortalBoard["threads"] }) {
  const { now } = useApp();
  return (
    <ChartFrame
      chart={tableChart({
        id: "recent-threads",
        data: threads.recent.map((t) => ({
          thread: t.thread,
          project: t.namespace ?? "none",
          seen: ago(parse(t.last_seen), now),
        })),
        columns: [
          { field: "thread", label: "Thread" },
          { field: "project", label: "Project" },
          { field: "seen", label: "Last seen" },
        ],
        title: "Recent threads",
        alt: `The ${threads.recent.length} threads seen most recently, newest first.`,
        summary: false,
      })}
    />
  );
}

const yesNo = (v: boolean | null) => (v === null ? "not known" : v ? "yes" : "no");

export function PrTable({ data }: { data: PortalPrs }) {
  const { now } = useApp();
  const overlaps = new Map<string, number>();
  for (const o of data.overlaps)
    for (const n of [o.pr, o.other]) {
      const k = `${o.repo}#${n}`;
      overlaps.set(k, (overlaps.get(k) ?? 0) + 1);
    }
  const rows = [...data.prs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const html = tableChart({
    id: "open-prs",
    data: rows.map((p) => ({
      title: `${p.title}${p.draft ? " (draft)" : ""}`,
      repo: `${p.repo.split("/")[1]}#${p.number}`,
      age: Math.max(0, Math.floor((now - parse(p.created_at)) / DAY)),
      ci: p.ci ?? "none",
      conflict: yesNo(p.conflict),
      overlap: overlaps.get(`${p.repo}#${p.number}`) ?? 0,
    })),
    columns: [
      { field: "title", label: "Pull request" },
      { field: "repo", label: "Repo" },
      { field: "age", label: "Age (days)", kind: "bar" },
      { field: "ci", label: "CI" },
      { field: "conflict", label: "Conflict" },
      { field: "overlap", label: "Shares files with" },
    ],
    title: "Open pull requests",
    alt: `${rows.length} open pull requests, oldest first: ${rows.filter((p) => p.ci === "failure").length} red, ${rows.filter((p) => p.conflict).length} in conflict, ${data.overlaps.length} pairs sharing files.`,
    summary: false,
  });
  return (
    <LinkedChart
      html={linkRows(
        html,
        rows.map((p) => ({ href: p.url, route: false })),
      )}
    />
  );
}

export function HandoffWeeksChart({
  weeks,
}: {
  weeks: Array<{ week: string; project: string; writes: number }>;
}) {
  const projects = [...new Set(weeks.map((w) => w.project))];
  const total = weeks.reduce((n, w) => n + w.writes, 0);
  if (total === 0)
    return (
      <ChartFrame
        noData={{ title: "Handoff writes per week", reason: "No handoff was written in 12 weeks." }}
      />
    );
  const opts = {
    data: weeks.map((w) => ({ ...w, week: w.week.slice(5) })),
    x: "week",
    y: "writes",
    series: "project",
    seriesDomain: projects,
    layout: "stacked",
    wholeNumbers: true,
    xLabel: `ISO week, ${weeks[0]!.week.slice(0, 4)} on`,
    yLabel: "Writes",
    height: 220,
    title: "How often are handoffs written?",
    subtitle: `${total} handoff writes in 12 weeks`,
    alt: `Handoff writes per ISO week over 12 weeks, by project: ${total} in all.`,
    source: { name: "Capsid audit log, handoff writes" },
  } as const;
  return <ChartFrame draw={(width, fit) => barChart({ ...opts, width, ...fit })} />;
}

export function RosterTable({ actors }: { actors: AgentDaily[] | null }) {
  const { feed, now } = useApp();
  const { href } = useHtmlLinks();
  const agents = rosterAgents(feed.live.agents);
  const of = (name: string) => {
    const mine = (actors ?? []).filter((a) => a.actor === `agent:${name}`);
    const counts = mine[0]?.counts.map((_, i) => mine.reduce((n, a) => n + a.counts[i]!, 0)) ?? [];
    return {
      counts: counts.length ? counts : [0, 0],
      total: mine.reduce((n, a) => n + a.total, 0),
    };
  };
  const data = agents.map((a) => {
    const st = agentState(a, now);
    const act = of(a.name);
    return {
      agent: a.name,
      kind: a.kind,
      projects: nsList(a),
      grants: a.flags.join(", ") || "none",
      seen: `${st.label}, ${a.last_seen ? ago(parse(a.last_seen), now) : "never"}`,
      daily: act.counts,
      total: act.total,
    };
  });
  if (data.length === 0) return <p className="cap-text">No live agent.</p>;
  const busiest = data.reduce((a, b) => (b.total > a.total ? b : a));
  const html = tableChart({
    id: "agent-roster",
    data,
    columns: [
      { field: "agent", label: "Agent" },
      { field: "kind", label: "Kind" },
      { field: "projects", label: "Projects" },
      { field: "grants", label: "Grants" },
      { field: "seen", label: "Last seen" },
      ...(actors
        ? ([{ field: "daily", label: "Actions a day, 30 days", kind: "sparkline" }] as const)
        : []),
      ...(actors ? ([{ field: "total", label: "30 days", kind: "bar" }] as const) : []),
    ],
    title: "Live agents",
    alt: `${data.length} live agents${actors ? `; the busiest over 30 days, ${busiest.agent}, with ${busiest.total} actions` : ""}.`,
    summary: false,
  });
  return (
    <LinkedChart
      html={linkRows(
        html,
        agents.map((a) => ({
          href: href(`/agents/agent/${encodeURIComponent(a.name)}`),
          route: true,
        })),
      )}
    />
  );
}

const BACKUP_TASK = /backup|dump|offaccount|amazon/i;

/** The backup tasks' recent runs, one lane per task the feed reports. */
export function BackupRuns({ tasks }: { tasks: OpsTask[] }) {
  const { now } = useApp();
  const start = now - 14 * DAY;
  const lanes = tasks.filter((t) => BACKUP_TASK.test(`${t.id} ${t.label}`));
  const events: TimelineEvent[] = lanes.flatMap((t) =>
    t.recent
      .filter((r) => parse(r.started_at) >= start)
      .map((r) => ({
        lane: t.label,
        label: `${r.outcome}${r.reason ? `: ${r.reason}` : ""}`,
        status: r.outcome === "ok" ? "ok" : r.outcome === "skipped" ? "unknown" : "error",
        at: parse(r.started_at),
      })),
  );
  const title = "Backup runs, last 14 days";
  if (lanes.length === 0 || events.length === 0)
    return <ChartFrame noData={{ title, reason: "No backup task ran in 14 days." }} />;
  const failed = events.filter((e) => e.status === "error").length;
  const opts = {
    events,
    lanes: lanes.map((t) => t.label),
    start,
    end: now,
    title,
    label: title,
    alt: `${events.length} backup runs in 14 days across ${lanes.length} tasks: ${failed} failed or refused.`,
    source: { name: "Capsid's scheduled tasks" },
  };
  return <ChartFrame draw={(width, fit) => timeline({ ...opts, width, ...fit })} />;
}
