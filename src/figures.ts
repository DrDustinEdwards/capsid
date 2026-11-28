import type { AgentDaily } from "./ops-types/board";
import { DAY_MS, isoWeek } from "./time";
import { mondayOf } from "./trends-days";

type Plot = typeof import("enarratio/plot");

// A zero is drawn as an empty cell (outlined), so the ramp's lightest step means "a few", not "none".
const COMMON = { strict: true, summary: false, strings: { terms: { noData: "none" } } } as const;
const WIDE = 1040;
const NARROW = 360;
const whole = (v: number) => Math.round(v).toLocaleString("en-US");
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const orNull = (n: number) => (n > 0 ? n : null);

export function heatThresholds(values: number[]): [number, number, number, number] | undefined {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  const max = sorted.at(-1) ?? 0;
  const out: number[] = [];
  for (const q of [0.2, 0.4, 0.6, 0.8]) {
    const at = Math.ceil(sorted[Math.floor(q * (sorted.length - 1))] ?? 0);
    out.push(Math.max(at, (out.at(-1) ?? 0) + 1));
  }
  return out[3]! < max ? (out as [number, number, number, number]) : undefined;
}

export function writesYear(plot: Plot, days: string[], counts: Map<string, number>): string | null {
  const last = Date.parse(`${mondayOf(days.at(-1)!)}T00:00:00Z`);
  const first = new Date(last - 51 * 7 * DAY_MS).toISOString().slice(0, 10);
  const inRange = days.filter((d) => d >= first);
  const total = inRange.reduce((n, d) => n + (counts.get(d) ?? 0), 0);
  if (total === 0) return null;
  const weekOf = (d: string) => isoWeek(new Date(`${d}T00:00:00Z`));
  const data = inRange.map((d) => ({
    week: weekOf(d).slice(6),
    day: WEEKDAYS[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7]!,
    writes: orNull(counts.get(d) ?? 0),
  }));
  const busiest = inRange.reduce((a, b) => ((counts.get(b) ?? 0) > (counts.get(a) ?? 0) ? b : a));
  return plot.heatmap({
    ...COMMON,
    id: "memory-writes",
    width: WIDE,
    data,
    x: "week",
    y: "day",
    value: "writes",
    xDomain: [...new Set(data.map((d) => d.week))],
    yDomain: WEEKDAYS,
    thresholds: heatThresholds([...counts.values()]),
    valueLabel: "Writes",
    formatValue: whole,
    xLabel: `ISO week, ${weekOf(inRange[0]!)} to ${weekOf(inRange.at(-1)!)}`,
    yLabel: null,
    title: "How often is memory written?",
    alt: `Document writes per day over 52 weeks: ${total.toLocaleString("en-US")} in all, the most ${counts.get(busiest)} on ${busiest}.`,
    source: { name: "Capsid audit log, document writes" },
  });
}

export function writesRecent(
  plot: Plot,
  days: string[],
  counts: Map<string, number>,
): string | null {
  const recent = days.slice(-91);
  const data = recent.map((day) => ({ day, writes: orNull(counts.get(day) ?? 0) }));
  const total = recent.reduce((n, d) => n + (counts.get(d) ?? 0), 0);
  if (total === 0) return null;
  return plot.calendarHeatmap({
    ...COMMON,
    id: "memory-writes-recent",
    width: NARROW,
    data,
    date: "day",
    value: "writes",
    thresholds: heatThresholds(recent.map((d) => counts.get(d) ?? 0)),
    valueLabel: "Writes",
    formatValue: whole,
    weekStart: 1,
    title: "How often is memory written?",
    alt: `Document writes per day over the last 13 weeks: ${total.toLocaleString("en-US")} in all.`,
    source: { name: "Capsid audit log, document writes" },
  });
}

export function whoActed(
  plot: Plot,
  days: string[],
  rows: AgentDaily[],
  by: "day" | "week",
): string | null {
  if (rows.length === 0) return null;
  const names = days.map((d) => String(Number(d.slice(8, 10))));
  const colOf = (i: number) => (by === "day" ? names[i]! : weekOf(days[i]!));
  const columns = [...new Set(days.map((_, i) => colOf(i)))];
  const data = rows.flatMap((r) => {
    const sums = new Map<string, number>();
    r.counts.forEach((n, i) => sums.set(colOf(i), (sums.get(colOf(i)) ?? 0) + n));
    return columns.map((col) => ({ col, who: r.label, actions: orNull(sums.get(col) ?? 0) }));
  });
  const total = rows.reduce((n, r) => n + r.total, 0);
  const top = rows[0]!;
  return plot.heatmap({
    ...COMMON,
    id: by === "day" ? "who-acted" : "who-acted-weeks",
    width: by === "day" ? WIDE : NARROW,
    data,
    x: "col",
    y: "who",
    value: "actions",
    xDomain: columns,
    yDomain: rows.map((r) => r.label),
    thresholds: heatThresholds(data.map((d) => d.actions ?? 0)),
    valueLabel: "Actions",
    formatValue: whole,
    xLabel: by === "day" ? `Day, ${days[0]} to ${days.at(-1)} (UTC)` : "ISO week",
    yLabel: null,
    cellLabels: by === "week",
    title: "Who acted, last 30 days",
    alt: `Actions per ${by} over the last 30 days by ${plural(rows.length, "actor")}: ${total.toLocaleString("en-US")} in all, the most by ${top.label} (${top.total.toLocaleString("en-US")}).`,
    source: { name: "Capsid audit log" },
  });
}

const weekOf = (day: string) => isoWeek(new Date(`${day}T00:00:00Z`)).slice(5);
