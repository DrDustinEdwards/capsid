import type { AgentDaily } from "./ops-types/board";
import type { PortalBackups } from "./ops-types/views";
import { DAY_MS, HOUR_MS, isoWeek, timeMs } from "./time";

// The Portal's charts that need Observable Plot, drawn by the Worker (src/portal-figures.ts). Each
// takes enarratio/plot as an argument, so the module is imported only by the figure route, never
// at the Worker's start (the same Worker serves MCP). Every figure states its finding in `alt` and
// carries its data table; none carries a style attribute (the Portal's CSP).

type Plot = typeof import("enarratio/plot");

const STRICT = { strict: true } as const;
// The widths the Worker draws at: the Portal's main column on a wide screen, and a phone's.
const WIDE = 1040;
const NARROW = 360;
const whole = (v: number) => Math.round(v).toLocaleString("en-US");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A day's column name: the day of the month, with the month on the first column, on the 1st, and
// wherever the number alone would repeat.
function dayNames(days: string[]): string[] {
  const used = new Set<string>();
  return days.map((d, i) => {
    const n = String(Number(d.slice(8, 10)));
    const long = `${MONTHS[Number(d.slice(5, 7)) - 1]} ${n}`;
    const name = i === 0 || n === "1" || used.has(n) ? long : n;
    used.add(name);
    return name;
  });
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Document writes per day over the last year, as a calendar. */
// A year has too many weeks to lie flat at any width (Enarratio turns it upright below about 11 px a
// week), so it is drawn once, upright, at a phone's width.
export function writesCalendar(
  plot: Plot,
  days: string[],
  counts: Map<string, number>,
): string | null {
  const data = days.map((day) => ({ day, writes: counts.get(day) ?? 0 }));
  const total = data.reduce((n, d) => n + d.writes, 0);
  if (total === 0) return null;
  const busiest = data.reduce((a, b) => (b.writes > a.writes ? b : a));
  const active = data.filter((d) => d.writes > 0).length;
  return plot.calendarHeatmap({
    ...STRICT,
    id: "memory-writes",
    width: NARROW,
    data,
    date: "day",
    value: "writes",
    valueLabel: "Writes",
    formatValue: whole,
    weekStart: 1,
    title: "How often is memory written?",
    subtitle: `${total.toLocaleString("en-US")} writes on ${plural(active, "day")} in the last year`,
    alt: `Document writes per day, ${days[0]} to ${days[days.length - 1]}: ${total} in all on ${active} of ${days.length} days, the most ${busiest.writes} on ${busiest.day}.`,
    source: { name: "Capsid audit log, document writes" },
  });
}

/** Who acted, by day (wide) or by ISO week (narrow), one row per actor and client. */
export function whoActed(
  plot: Plot,
  days: string[],
  rows: AgentDaily[],
  by: "day" | "week",
): string | null {
  if (rows.length === 0) return null;
  const names = dayNames(days);
  const columns = by === "day" ? names : [...new Set(days.map((d) => weekOf(d)))];
  const data = rows.flatMap((r) => {
    const sums = new Map<string, number>();
    r.counts.forEach((n, i) => {
      const col = by === "day" ? names[i]! : weekOf(days[i]!);
      sums.set(col, (sums.get(col) ?? 0) + n);
    });
    return columns.map((col) => ({ col, who: r.label, actions: sums.get(col) ?? 0 }));
  });
  const total = rows.reduce((n, r) => n + r.total, 0);
  const top = rows[0]!;
  return plot.heatmap({
    ...STRICT,
    id: by === "day" ? "who-acted" : "who-acted-weeks",
    width: by === "day" ? WIDE : NARROW,
    data,
    x: "col",
    y: "who",
    value: "actions",
    xDomain: columns,
    yDomain: rows.map((r) => r.label),
    valueLabel: "Actions",
    formatValue: whole,
    xLabel: by === "day" ? "Day (UTC)" : "ISO week",
    yLabel: null,
    cellLabels: by === "week",
    title: "Who acted, last 30 days",
    alt: `Actions per ${by} over the last 30 days by ${plural(rows.length, "actor")}: ${total.toLocaleString("en-US")} in all, the most by ${top.label} (${top.total.toLocaleString("en-US")}).`,
    source: { name: "Capsid audit log" },
  });
}

const weekOf = (day: string) => isoWeek(new Date(`${day}T00:00:00Z`)).slice(5);

export interface OpenFinding {
  namespace: string;
  title: string;
  first_seen_at: string;
  last_seen_at: string;
}

/** How long each open finding has been open: first seen to last seen, in days before now. */
export function findingsRange(plot: Plot, rows: OpenFinding[], now: Date): string | null {
  if (rows.length === 0) return null;
  const ago = (at: string) => -Math.round(((now.getTime() - timeMs(at)) / DAY_MS) * 10) / 10;
  const seen = new Set<string>();
  const data = rows
    .map((r) => ({
      finding: unique(seen, `${r.namespace}: ${r.title.slice(0, 70)}`),
      from: ago(r.first_seen_at),
      to: ago(r.last_seen_at),
    }))
    .sort((a, b) => a.from - b.from);
  const oldest = data[0]!;
  return plot.rangePlot({
    ...STRICT,
    id: "findings-open",
    data,
    y: "finding",
    low: "from",
    high: "to",
    xLabel: "Days before now",
    formatValue: (v) => `${Math.abs(v).toFixed(1)} d`,
    title: "How long has each open problem been open?",
    alt: `${plural(data.length, "open problem")}, from first seen to last seen: the oldest, ${oldest.finding}, first seen ${Math.abs(oldest.from).toFixed(1)} days ago.`,
    source: { name: "The watcher's open findings" },
  });
}

function unique(seen: Set<string>, name: string): string {
  let out = name;
  for (let i = 2; seen.has(out); i++) out = `${name} (${i})`;
  seen.add(out);
  return out;
}

// A dump runs daily: on time under 26 hours, late under 50, stale beyond.
const DUMP_TARGET = 26;
const DUMP_LATE = 50;
// The Amazon copy (src/offaccount.ts): late from 30 hours, stale from 36 (dashboard/src/lib/derive.ts).
const COPY_LATE = 30;
const COPY_STALE = 36;

/** Hours since each site's last good dump, or its Amazon copy, against the target. */
export function backupAges(
  plot: Plot,
  b: PortalBackups,
  which: "dump" | "amazon",
  now: Date,
): { chart: string | null; missing: string[] } {
  const rows: Array<{ site: string; hours: number | null }> =
    which === "dump"
      ? [
          { site: "capsid", hours: b.capsid.status.age_hours },
          ...b.sites.map((s) => ({ site: s.namespace, hours: s.status?.age_hours ?? null })),
        ]
      : [
          { site: "capsid", hours: hoursSince(b.capsid.amazon?.newest ?? null, now) },
          ...b.sites.map((s) => ({
            site: s.namespace,
            hours: hoursSince(s.amazon?.newest ?? null, now),
          })),
        ];
  const missing = rows.filter((r) => r.hours === null).map((r) => r.site);
  const data = rows
    .filter((r): r is { site: string; hours: number } => r.hours !== null)
    .map((r) => ({
      site: r.site,
      hours: Math.round(r.hours * 10) / 10,
      target: which === "dump" ? DUMP_TARGET : COPY_LATE,
    }));
  if (data.length === 0) return { chart: null, missing };
  const [late, stale] = which === "dump" ? [DUMP_TARGET, DUMP_LATE] : [COPY_LATE, COPY_STALE];
  const end = Math.max(stale * 1.5, ...data.map((d) => d.hours));
  const over = data.filter((d) => d.hours >= late);
  const what = which === "dump" ? "last good backup" : "newest Amazon copy";
  const chart = plot.bulletChart({
    ...STRICT,
    id: which === "dump" ? "backup-age" : "amazon-age",
    data,
    label: "site",
    value: "hours",
    target: "target",
    bands: [
      { to: late, label: "On time" },
      { to: stale, label: "Late" },
      { to: end, label: "Stale" },
    ],
    lowerIsBetter: true,
    sharedScale: true,
    valueLabel: "Hours",
    formatValue: (v) => `${v.toFixed(v < 10 ? 1 : 0)} h`,
    title: which === "dump" ? "Backup age by site" : "Amazon copy age by site",
    alt: `Hours since each site's ${what}, against the ${late}-hour target: ${over.length === 0 ? `all ${plural(data.length, "site")} on time` : `${over.map((d) => `${d.site} ${d.hours} h`).join(", ")} past it`}.`,
    source: { name: which === "dump" ? "Each site's backup_status" : "The Amazon copy's report" },
  });
  return { chart, missing };
}

function hoursSince(at: string | null, now: Date): number | null {
  if (!at) return null;
  const t = timeMs(at);
  return Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / HOUR_MS) : null;
}
