import { jsonResponse } from "@dustinedwards/site-runtime/http";
import { kvCached } from "@dustinedwards/site-runtime/kv-cache";
import { errorMessage } from "@dustinedwards/site-runtime/log";
import type { Env } from "./env";
import { whoActed, writesRecent, writesYear } from "./figures";
import type { AgentDaily, FigureSet, PortalFigures } from "./ops-types/board";
import { OTHER, topNames } from "./portal-board";
import { behindGate } from "./portal-auth";
import { lastDays, mondayOf, weekStarts } from "./trends-days";
import { isoWeek } from "./time";

export const PORTAL_FIGURES_PATH = "/portal/api/figures";
const SETS: readonly FigureSet[] = ["memory", "agents", "roster"];
const CACHE_SECONDS = 10 * 60;
const YEAR_DAYS = 365;
const AGENT_DAYS = 30;
const HANDOFF_WEEKS = 12;
const TOP_PROJECTS = 5;
const TOP_ACTORS = 10;

type Plot = typeof import("enarratio/plot");

export function actorLabel(actor: string, client: string | null): string {
  const c = client?.trim() || null;
  if (actor.startsWith("access:") || actor.includes("@")) {
    if (!c) return "You (Portal)";
    return /claude/i.test(c) ? "Project threads" : `You via ${c}`;
  }
  const [kind, ...rest] = actor.split(":");
  const name = rest.join(":") || kind!;
  const base = kind === "agent" ? name : rest.length ? `${name} (${kind})` : name;
  return c ? `${base} via ${c}` : base;
}

async function memory(env: Env, plot: Plot, now: Date): Promise<Partial<PortalFigures>> {
  const days = lastDays(now, YEAR_DAYS);
  const mondays = weekStarts(now, HANDOFF_WEEKS);
  const [writes, handoffs] = await Promise.all([
    env.DB.prepare(
      "SELECT substr(at, 1, 10) AS day, COUNT(*) AS n FROM audit_log WHERE action = 'write' AND at >= ?1 GROUP BY day",
    )
      .bind(days[0])
      .all<{ day: string; n: number }>(),
    env.DB.prepare(
      "SELECT substr(at, 1, 10) AS day, namespace, COUNT(*) AS n FROM audit_log WHERE action = 'write' AND at >= ?1 AND path LIKE 'handoff/%' GROUP BY day, namespace",
    )
      .bind(mondays[0])
      .all<{ day: string; namespace: string | null; n: number }>(),
  ]);
  const counts = new Map(writes.results.map((r) => [r.day, r.n]));
  const wide = writesYear(plot, days, counts);
  const narrow = writesRecent(plot, days, counts);
  const totals = new Map<string, number>();
  for (const r of handoffs.results) {
    const ns = r.namespace ?? "none";
    totals.set(ns, (totals.get(ns) ?? 0) + r.n);
  }
  const top = topNames(totals, TOP_PROJECTS);
  const projects = totals.size > top.length ? [...top, OTHER] : top;
  const sums = new Map<string, number>();
  for (const r of handoffs.results) {
    const ns = r.namespace ?? "none";
    const key = `${mondayOf(r.day)}|${top.includes(ns) ? ns : OTHER}`;
    sums.set(key, (sums.get(key) ?? 0) + r.n);
  }
  return {
    figures: wide ? { writes: wide, ...(narrow ? { writes_recent: narrow } : {}) } : {},
    empty: wide ? {} : { writes: "No document was written in the last year." },
    handoff_weeks: mondays.flatMap((m) =>
      projects.map((project) => ({
        week: isoWeek(new Date(`${m}T00:00:00Z`)),
        project,
        writes: sums.get(`${m}|${project}`) ?? 0,
      })),
    ),
  };
}

export function agentRows(
  rows: Array<{ day: string; actor: string | null; client: string | null; n: number }>,
  days: string[],
): AgentDaily[] {
  const index = new Map(days.map((d, i) => [d, i]));
  const by = new Map<string, AgentDaily>();
  for (const r of rows) {
    const i = index.get(r.day);
    if (i === undefined) continue;
    const actor = r.actor ?? "unknown";
    const key = `${actor}\u0000${r.client ?? ""}`;
    let row = by.get(key);
    if (!row) {
      row = {
        actor,
        client: r.client,
        label: actorLabel(actor, r.client),
        counts: days.map(() => 0),
        total: 0,
      };
      by.set(key, row);
    }
    row.counts[i]! += r.n;
    row.total += r.n;
  }
  return [...by.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

export function heatRows(rows: AgentDaily[], days: string[]): AgentDaily[] {
  const byLabel = new Map<string, AgentDaily>();
  for (const r of rows) {
    const row = byLabel.get(r.label);
    if (!row) byLabel.set(r.label, { ...r, counts: [...r.counts] });
    else {
      r.counts.forEach((n, i) => (row.counts[i]! += n));
      row.total += r.total;
    }
  }
  const all = [...byLabel.values()].sort((a, b) => b.total - a.total);
  const top = all.slice(0, TOP_ACTORS);
  const rest = all.slice(TOP_ACTORS);
  if (rest.length === 0) return top;
  const other: AgentDaily = {
    actor: OTHER,
    client: null,
    label: OTHER,
    counts: days.map((_, i) => rest.reduce((n, r) => n + r.counts[i]!, 0)),
    total: rest.reduce((n, r) => n + r.total, 0),
  };
  return [...top, other];
}

async function actorDays(env: Env, now: Date): Promise<{ days: string[]; actors: AgentDaily[] }> {
  const days = lastDays(now, AGENT_DAYS);
  const { results } = await env.DB.prepare(
    "SELECT substr(at, 1, 10) AS day, actor, client, COUNT(*) AS n FROM audit_log WHERE at >= ?1 GROUP BY day, actor, client",
  )
    .bind(days[0])
    .all<{ day: string; actor: string | null; client: string | null; n: number }>();
  return { days, actors: agentRows(results, days) };
}

async function roster(env: Env, _plot: Plot, now: Date): Promise<Partial<PortalFigures>> {
  return actorDays(env, now);
}

async function agents(env: Env, plot: Plot, now: Date): Promise<Partial<PortalFigures>> {
  const { days, actors } = await actorDays(env, now);
  const heat = heatRows(actors, days);
  const wide = whoActed(plot, days, heat, "day");
  const narrow = whoActed(plot, days, heat, "week");
  return {
    figures: wide && narrow ? { who_acted: wide, who_acted_weeks: narrow } : {},
    empty: wide ? {} : { who_acted: "No one acted in the last 30 days." },
  };
}

const READERS: Record<
  FigureSet,
  (env: Env, plot: Plot, now: Date) => Promise<Partial<PortalFigures>>
> = { memory, agents, roster };

async function readFigures(env: Env, set: FigureSet, now: Date): Promise<PortalFigures> {
  const base: PortalFigures = {
    set,
    generated: now.toISOString(),
    figures: {},
    empty: {},
    not_checked: [],
  };
  try {
    const plot = await import("enarratio/plot");
    return { ...base, ...(await READERS[set](env, plot, now)) };
  } catch (err) {
    return { ...base, not_checked: [`the ${set} charts: ${errorMessage(err)}`] };
  }
}

export const handlePortalFigures = behindGate(async (request, env, now) => {
  const set = new URL(request.url).searchParams.get("set") as FigureSet | null;
  if (!set || !SETS.includes(set))
    return jsonResponse({ error: `set must be one of ${SETS.join(", ")}.` }, 400);
  const body = await kvCached(
    env.APP_KV,
    `portal:figures:${set}:v2`,
    {
      ttl: CACHE_SECONDS,
      valid: (kept) => typeof (kept as Partial<PortalFigures> | null)?.figures === "object",
      keep: (out) => out.not_checked.length === 0 || Object.keys(out.figures).length > 0,
    },
    () => readFigures(env, set, now),
  );
  return jsonResponse(body);
});
