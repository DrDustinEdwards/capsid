import { jsonResponse } from "@dustinedwards/site-runtime/http";
import { kvCached } from "@dustinedwards/site-runtime/kv-cache";
import { errorMessage } from "@dustinedwards/site-runtime/log";
import { overlaps, readThreads } from "./board";
import type { Env } from "./env";
import { openHandoffs } from "./handoffs";
import type { PortalBoard, PortalPrs } from "./ops-types/board";
import { behindGate } from "./portal-auth";
import { unfence } from "./provenance";
import { lastDays } from "./trends-days";
import { readOpenPrs } from "./whats-next";

// The Portal's Board (GET /portal/api/board) and Pull requests (GET /portal/api/prs): the
// coordinator board capsid_admin_whats_next serves (src/board.ts, src/whats-next.ts), split so
// the cheap D1 parts are read live and the slow GitHub part is kept in KV and loaded after the
// page paints. Text is unfenced here: the page shows it as text, never as markup.

export const PORTAL_BOARD_PATH = "/portal/api/board";
export const PORTAL_PRS_PATH = "/portal/api/prs";

const HANDOFFS_MAX = 100;
const THREAD_DAYS = 21;
const THREADS_MAX = 2000;
const RECENT_THREADS = 10;
const TOP_PROJECTS = 5;
export const OTHER = "Other";
const PRS_CACHE_KEY = "portal:prs:v1";
const PRS_CACHE_SECONDS = 15 * 60;

/** The `top` names with the largest totals, largest first; the rest are counted as "Other". */
export function topNames(totals: Map<string, number>, top: number): string[] {
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([name]) => name);
}

export function threadsPerDay(
  rows: Array<{ namespace: string | null; first_seen: string }>,
  days: string[],
): Pick<PortalBoard["threads"], "per_day" | "projects" | "total"> {
  const inWindow = rows.filter((r) => r.first_seen.slice(0, 10) >= days[0]!);
  const totals = new Map<string, number>();
  for (const r of inWindow)
    totals.set(r.namespace ?? "none", (totals.get(r.namespace ?? "none") ?? 0) + 1);
  const top = topNames(totals, TOP_PROJECTS);
  const projects = totals.size > top.length ? [...top, OTHER] : top;
  const counts = new Map<string, number>();
  for (const r of inWindow) {
    const ns = r.namespace ?? "none";
    const key = `${r.first_seen.slice(0, 10)}|${top.includes(ns) ? ns : OTHER}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const per_day = days.flatMap((day) =>
    projects.map((project) => ({ day, project, threads: counts.get(`${day}|${project}`) ?? 0 })),
  );
  return { per_day, projects, total: inWindow.length };
}

async function readBoard(env: Env, now: Date): Promise<PortalBoard> {
  const notChecked: string[] = [];
  const [handoffs, threads] = await Promise.all([
    openHandoffs(env.DB, HANDOFFS_MAX + 1).catch((err: unknown) => {
      notChecked.push(`the open handoffs: ${errorMessage(err)}`);
      return [];
    }),
    readThreads(env.DB, THREAD_DAYS, THREADS_MAX).catch((err: unknown) => {
      notChecked.push(`the thread list: ${errorMessage(err)}`);
      return [];
    }),
  ]);
  const list = handoffs.slice(0, HANDOFFS_MAX).map((h) => ({
    namespace: h.namespace,
    path: h.path,
    title: h.title === null ? null : unfence(h.title),
    updated_at: h.updated_at,
    checklist: h.checklist && { done: h.checklist.done, open: h.checklist.open },
    waiting: h.waiting_on_dustin === null ? null : unfence(h.waiting_on_dustin),
  }));
  const days = lastDays(now, THREAD_DAYS);
  return {
    generated: now.toISOString(),
    handoffs: {
      open: list.length,
      done_items: list.reduce((n, h) => n + (h.checklist?.done ?? 0), 0),
      open_items: list.reduce((n, h) => n + (h.checklist?.open ?? 0), 0),
      list: list.map(({ waiting: _w, ...h }) => h),
      truncated: handoffs.length > HANDOFFS_MAX,
    },
    waiting_on_dustin: list
      .filter((h) => h.waiting !== null)
      .map((h) => ({ namespace: h.namespace, path: h.path, title: h.title, text: h.waiting! })),
    threads: {
      days: THREAD_DAYS,
      ...threadsPerDay(threads, days),
      recent: threads.slice(0, RECENT_THREADS).map((t) => ({
        thread: t.thread,
        namespace: t.namespace,
        last_seen: t.last_seen,
      })),
    },
    not_checked: notChecked,
  };
}

async function readPrsFresh(env: Env, now: Date): Promise<PortalPrs> {
  const notChecked: string[] = [];
  const { prs, repos_read } = await readOpenPrs(env, notChecked);
  const shared = await overlaps(env, prs, notChecked).catch((err: unknown) => {
    notChecked.push(`same-file overlaps: ${errorMessage(err)}`);
    return [];
  });
  return {
    as_of: now.toISOString(),
    prs: prs.map((p) => ({ ...p, title: unfence(p.title) })),
    overlaps: shared,
    repos_read,
    not_checked: notChecked,
  };
}

/** The open pull requests, kept 15 minutes; a read that reached no repo is served but not kept. */
function readPortalPrs(env: Env, now: Date): Promise<PortalPrs> {
  return kvCached(
    env.APP_KV,
    PRS_CACHE_KEY,
    {
      ttl: PRS_CACHE_SECONDS,
      valid: (kept) => Array.isArray((kept as Partial<PortalPrs> | null)?.prs),
      keep: (out) => out.repos_read > 0,
    },
    () => readPrsFresh(env, now),
  );
}

export const handlePortalBoard = behindGate(async (_request, env, now) =>
  jsonResponse(await readBoard(env, now)),
);

export const handlePortalPrs = behindGate(async (_request, env, now) =>
  jsonResponse(await readPortalPrs(env, now)),
);
