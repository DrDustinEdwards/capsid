// Handoffs: the documents under handoff/ that threads leave for the next thread. Open means status
// is not closed and the handoff was written in the last 14 days; one left untouched longer counts
// as archived, so about 70 a week do not flood the start packet. Closing one early is setting its
// status to closed or moving it under archive/; writing to an old one opens it again.
// capsid_start_session returns a namespace's open handoffs; the coordinator board
// (capsid_admin_whats_next) lists them across namespaces with their checklists and what waits on
// Dustin, so open work is counted without reading the prose.

import { externalFence } from "./provenance";

const SECTION_MAX = 1500;
const ITEMS_SHOWN = 20;

export interface Checklist {
  done: number;
  open: number;
  open_items: string[];
}

// A handoff ends with a markdown task list ("- [ ] step" / "- [x] step"), so a program can count
// what is done and what is not.
const ITEM = /^[ \t]*[-*][ \t]+\[([ xX])\][ \t]+(.+?)[ \t]*$/gm;

export function checklistOf(body: string | null): Checklist | null {
  const items = [...(body ?? "").matchAll(ITEM)];
  if (items.length === 0) return null;
  const open = items.filter((m) => m[1] === " ").map((m) => m[2]!);
  return {
    done: items.length - open.length,
    open: open.length,
    open_items: open.slice(0, ITEMS_SHOWN),
  };
}

const HEADING = /^#{1,6}[ \t]+(.*)$/;

// The section a handoff heads "Waiting on Dustin" (any heading level), up to the next heading of
// the same or a higher level.
function waitingOnDustin(body: string | null): string | null {
  const lines = (body ?? "").split("\n");
  const start = lines.findIndex((l) => {
    const m = l.match(HEADING);
    return m !== null && /waiting on dustin/i.test(m[1]!);
  });
  if (start < 0) return null;
  const level = lines[start]!.match(/^#+/)![0].length;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const hashes = line.match(/^(#+)[ \t]/);
    if (hashes && hashes[1]!.length <= level) break;
    out.push(line);
  }
  const text = out.join("\n").trim();
  return text ? text.slice(0, SECTION_MAX) : null;
}

export interface BoardHandoff {
  namespace: string;
  path: string;
  title: string | null;
  updated_at: string;
  // open_items is the open lines as one fenced block.
  checklist: { done: number; open: number; open_items: string | null } | null;
  waiting_on_dustin: string | null;
}

/** Every open handoff in every namespace, newest first. Bodies are data another thread wrote. */
export async function openHandoffs(db: D1Database, limit: number): Promise<BoardHandoff[]> {
  const { results } = await db
    .prepare(
      "SELECT namespace, path, title, body, updated_at FROM documents WHERE path LIKE 'handoff/%' AND status != 'closed' AND updated_at >= datetime('now', '-14 days') ORDER BY updated_at DESC LIMIT ?1",
    )
    .bind(limit)
    .all<{
      namespace: string;
      path: string;
      title: string | null;
      body: string | null;
      updated_at: string;
    }>();
  return (results ?? []).map((r) => {
    const id = `${r.namespace}/${r.path}`;
    const waiting = waitingOnDustin(r.body);
    const list = checklistOf(r.body);
    return {
      namespace: r.namespace,
      path: r.path,
      title: r.title === null ? null : externalFence("handoff", id, r.title, 200),
      updated_at: r.updated_at,
      checklist: list && {
        done: list.done,
        open: list.open,
        open_items: list.open
          ? externalFence("handoff", id, list.open_items.map((t) => `- [ ] ${t}`).join("\n"))
          : null,
      },
      waiting_on_dustin: waiting === null ? null : externalFence("handoff", id, waiting),
    };
  });
}
