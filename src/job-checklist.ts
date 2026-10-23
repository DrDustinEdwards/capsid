import { heading, proseOnly } from "./job-body-check";

// The DONE WHEN checklist (docs/work-queue.md, "CI on complete"; Grok design review
// 2026-10-23, build step 6). The poster numbers the items under DONE WHEN, at most
// CHECKLIST_MAX of them. An item that says it changes a path in backticks ("3. The breaker
// skips run keys: changes `src/job-breaker.ts`") is checked at complete: a pull request
// the complete names must change that path, or the job is not done. A path ending in /
// is a directory, matched by any file under it. Every other item is the session's to
// meet and the reviewer's to read; Capsid checks only what it can see in the diff.

const CHECKLIST_MAX = 10;

const PART_HEADINGS = heading("GOAL|DO|OUT OF SCOPE|DECIDED|RULES");
const DONE_WHEN = heading("DONE WHEN");
const ITEM = /^[ \t]*(\d+)[.)][ \t]+(.*)$/;
const CHANGES = /\bchanges?[ \t]+`([^`\s*?]+)`/gi;

export interface ChecklistItem {
  n: number;
  paths: string[];
}

/** The numbered items under DONE WHEN, each with the paths it says it changes. Pure. */
export function checklistItems(body: string): ChecklistItem[] {
  const raw = body.split(/\r?\n/);
  const prose = proseOnly(body).split("\n");
  const start = prose.findIndex((line) => DONE_WHEN.test(line));
  if (start < 0) return [];
  const items: ChecklistItem[] = [];
  for (let i = start + 1; i < raw.length; i++) {
    if (PART_HEADINGS.test(prose[i])) break;
    const m = ITEM.exec(prose[i]);
    // The paths are read from the line as written, since proseOnly blanks code spans.
    if (m) items.push({ n: Number(m[1]), paths: [...raw[i].matchAll(CHANGES)].map((c) => c[1]) });
  }
  return items;
}

/** A warning when DONE WHEN has more numbered items than CHECKLIST_MAX, or null. */
export function checklistWarning(body: string): string | null {
  const n = checklistItems(body).length;
  return n > CHECKLIST_MAX ? `DONE WHEN has ${n} numbered items. Keep it to ${CHECKLIST_MAX}, so each one is checked rather than skimmed. Posted anyway.` : null;
}

/** The checklist items naming a path no pull request changed, as refusal lines. Pure. */
export function unchangedItems(items: readonly ChecklistItem[], changed: readonly string[]): string[] {
  const touched = (path: string) => changed.some((c) => (path.endsWith("/") ? c.startsWith(path) : c === path));
  return items.flatMap((item) => item.paths.filter((p) => !touched(p)).map((p) => `DONE WHEN item ${item.n} changes \`${p}\``));
}
