// The coordinator board: the parts capsid_admin_whats_next adds beside the pull requests,
// so the coordinator sees in one read which threads are working, which handoffs are open and how
// much of each is done, what waits on Dustin, what the watcher has open, and which open pull
// requests change the same files (Dustin, 2026-11-28, Capsid redesign change 4).

import type { Env } from "./env";
import { openHandoffs, type BoardHandoff } from "./handoffs";
import { overlapsOf, type PrOverlap } from "./pr-overlaps";
import { readPrFiles } from "./github/pr-files";
import { externalFence } from "./provenance";
import { mapLimit } from "./map-limit";

import { errorMessage } from "@dustinedwards/site-runtime/log";

const HANDOFFS_MAX = 100;
const THREADS_DAYS = 14;
const THREADS_MAX = 60;
const FINDINGS_MAX = 50;
const OVERLAP_PRS_PER_REPO = 20;
const FILE_READS_AT_ONCE = 6;
// The coordinator keeps the list of active work here, not in project memory.
const ACTIVE_WORK = { namespace: "capsid", path: "active-work.md" } as const;

export interface BoardPr {
  repo: string;
  number: number;
}

export interface Board {
  active_work: { path: string; updated_at: string; body: string } | null;
  threads: Array<{ thread: string; namespace: string | null; last_seen: string; reads: number }>;
  handoffs: {
    open: number;
    open_items: number;
    list: BoardHandoff[];
  };
  waiting_on_dustin: Array<{ namespace: string; path: string; text: string }>;
  findings: Array<{
    namespace: string;
    title: string;
    first_seen_at: string;
    last_seen_at: string;
    seen_count: number;
  }>;
  overlaps: Array<{ repo: string } & PrOverlap>;
}

async function part<T>(
  name: string,
  notChecked: string[],
  fallback: T,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    notChecked.push(`${name}: ${errorMessage(err)}`);
    return fallback;
  }
}

// Threads name themselves on capsid_start_session (`thread`), which leaves one conventions-read
// audit row per thread per hour.
async function threads(db: D1Database): Promise<Board["threads"]> {
  const { results } = await db
    .prepare(
      `SELECT json_extract(params, '$.thread') AS thread,
         json_extract(params, '$.for_namespace') AS namespace,
         MAX(at) AS last_seen, COUNT(*) AS reads
       FROM audit_log
       WHERE action = 'conventions-read' AND at >= datetime('now', ?1)
         AND json_extract(params, '$.thread') IS NOT NULL
       GROUP BY thread, namespace ORDER BY last_seen DESC LIMIT ?2`,
    )
    .bind(`-${THREADS_DAYS} days`, THREADS_MAX)
    .all<{ thread: string; namespace: string | null; last_seen: string; reads: number }>();
  return (results ?? []).map((r) => ({
    ...r,
    thread: externalFence("thread-name", r.namespace ?? "none", r.thread, 120),
  }));
}

async function activeWork(db: D1Database): Promise<Board["active_work"]> {
  const row = await db
    .prepare("SELECT path, body, updated_at FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(ACTIVE_WORK.namespace, ACTIVE_WORK.path)
    .first<{ path: string; body: string | null; updated_at: string }>();
  if (!row) return null;
  return {
    path: `${ACTIVE_WORK.namespace}/${row.path}`,
    updated_at: row.updated_at,
    body: externalFence("capsid-doc", `${ACTIVE_WORK.namespace}/${row.path}`, row.body ?? ""),
  };
}

async function findings(db: D1Database): Promise<Board["findings"]> {
  const { results } = await db
    .prepare(
      "SELECT fingerprint, namespace, title, first_seen_at, last_seen_at, seen_count FROM watcher_findings WHERE state = 'open' ORDER BY last_seen_at DESC LIMIT ?1",
    )
    .bind(FINDINGS_MAX)
    .all<{
      fingerprint: string;
      namespace: string;
      title: string;
      first_seen_at: string;
      last_seen_at: string;
      seen_count: number;
    }>();
  return (results ?? []).map(({ fingerprint: _f, ...r }) => r);
}

// Same-file overlaps between the open pull requests of each repo, each pair once, the older
// pull request first (src/pr-overlaps.ts).
async function overlaps(
  env: Env,
  prs: BoardPr[],
  notChecked: string[],
): Promise<Board["overlaps"]> {
  const byRepo = new Map<string, number[]>();
  for (const p of prs) byRepo.set(p.repo, [...(byRepo.get(p.repo) ?? []), p.number]);
  const out: Board["overlaps"] = [];
  for (const [full, all] of byRepo) {
    if (all.length < 2) continue;
    const numbers = [...all].sort((a, b) => a - b);
    if (numbers.length > OVERLAP_PRS_PER_REPO)
      notChecked.push(
        `${full} overlaps: ${numbers.length - OVERLAP_PRS_PER_REPO} newer open pull requests not compared`,
      );
    const [owner, repo] = full.split("/") as [string, string];
    const read = await mapLimit(
      numbers.slice(0, OVERLAP_PRS_PER_REPO),
      FILE_READS_AT_ONCE,
      async (number) => {
        const files = await readPrFiles(env, owner, repo, number);
        if (files.problem) notChecked.push(`${full}#${number} files: ${files.problem}`);
        return { number, paths: files.paths };
      },
    );
    read.forEach((mine, i) => {
      for (const o of overlapsOf([mine], read.slice(i + 1))) out.push({ repo: full, ...o });
    });
  }
  return out;
}

export async function board(env: Env, prs: BoardPr[], notChecked: string[]): Promise<Board> {
  const [work, seen, handoffs, open, shared] = await Promise.all([
    part("the active work document", notChecked, null, () => activeWork(env.DB)),
    part("the thread list", notChecked, [], () => threads(env.DB)),
    part("the open handoffs", notChecked, [], () => openHandoffs(env.DB, HANDOFFS_MAX + 1)),
    part("the watcher's open findings", notChecked, [], () => findings(env.DB)),
    part("same-file overlaps", notChecked, [], () => overlaps(env, prs, notChecked)),
  ]);
  if (handoffs.length > HANDOFFS_MAX)
    notChecked.push(
      `more than ${HANDOFFS_MAX} open handoffs; the newest ${HANDOFFS_MAX} are listed`,
    );
  const list = handoffs.slice(0, HANDOFFS_MAX);
  return {
    active_work: work,
    threads: seen,
    handoffs: {
      open: list.length,
      open_items: list.reduce((n, h) => n + (h.checklist?.open ?? 0), 0),
      list,
    },
    waiting_on_dustin: list
      .filter((h) => h.waiting_on_dustin !== null)
      .map((h) => ({ namespace: h.namespace, path: h.path, text: h.waiting_on_dustin! })),
    findings: open,
    overlaps: shared,
  };
}
