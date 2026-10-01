import { useEffect, useMemo, useRef, useState } from "react";
import type { OpsFeed } from "../types";
import type { ViewDef, ViewId } from "./ctx";
import { stopCommands, type Command, type StopActions } from "../lib/stops";
import { JOB, PROBE, hasSites, siteKey } from "../lib/derive";
import { ago, hostOf, ms } from "../lib/format";

export interface Actions extends StopActions {
  go: (v: ViewId) => void;
  open: (ref: string) => void;
  refresh: () => void;
  theme: () => void;
  help: () => void;
  copy: (text: string) => void;
}

export function commands(feed: OpsFeed | null, views: ReadonlyArray<ViewDef>, a: Actions, now: number): Command[] {
  const out: Command[] = views.map((v) => ({ group: "Go to", text: v.label, hint: `g ${v.key}`, run: () => a.go(v.id) }));
  const sites = feed && hasSites(feed) ? (feed.snapshot?.sites ?? []) : [];
  for (const s of sites) out.push({ group: "Site", text: `${s.name}  ${hostOf(s.origin)}`, hint: PROBE[s.state].label, run: () => a.open(`site:${siteKey(s)}`) });
  for (const j of feed?.live.jobs ?? []) out.push({ group: "Job", text: j.title, hint: `${JOB[j.status].label} · ${j.namespace}`, run: () => a.open(`job:${j.id}`) });
  for (const g of feed?.live.agents ?? []) out.push({ group: "Agent", text: g.name, hint: g.last_seen ? ago(ms(g.last_seen), now) : "never seen", run: () => a.open(`agent:${g.name}`) });
  out.push(...stopCommands(feed, a));
  out.push({ group: "Action", text: "Refresh now", hint: "r", run: a.refresh });
  out.push({ group: "Action", text: "Switch light and dark", hint: "t", run: a.theme });
  out.push({ group: "Action", text: "Show keyboard shortcuts", hint: "?", run: a.help });
  for (const j of feed?.live.jobs ?? []) {
    if (j.status === "blocked" && j.command) {
      const cmd = j.command;
      out.push({ group: "Copy", text: `Copy the command for: ${j.title}`, hint: j.namespace, run: () => a.copy(cmd) });
    }
  }
  return out;
}

function score(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i >= 0) return 100 - Math.min(i, 99);
  let ti = 0;
  for (const ch of q) {
    ti = t.indexOf(ch, ti);
    if (ti < 0) return 0;
    ti++;
  }
  return 1;
}

export function CommandMenu({ open, onClose, list }: { open: boolean; onClose: () => void; list: Command[] }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open && !d.open) {
      setQ("");
      setSel(0);
      d.showModal();
      input.current?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return list
      .map((c) => ({ c, s: score(needle, `${c.group} ${c.text}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.c);
  }, [list, q]);
  const cur = Math.min(sel, Math.max(0, items.length - 1));
  useEffect(() => {
    dlg.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cur, items]);
  const run = (c: Command | undefined) => {
    onClose();
    c?.run();
  };
  return (
    <dialog
      ref={dlg}
      className="palette"
      aria-label="Command menu"
      onClose={onClose}
      onClick={(e) => e.target === dlg.current && onClose()}
    >
      <input
        ref={input}
        value={q}
        onChange={(e) => (setQ(e.target.value), setSel(0))}
        placeholder="Jump to a site, job, agent or view, or stop something..."
        aria-label="Search commands"
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded="true"
        aria-controls="paletteList"
        aria-activedescendant={items.length ? `pal-${cur}` : undefined}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setSel(Math.min(items.length - 1, cur + 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setSel(Math.max(0, cur - 1)));
          else if (e.key === "Enter") (e.preventDefault(), run(items[cur]));
        }}
      />
      <ul id="paletteList" role="listbox" aria-label="Commands">
        {items.length ? (
          items.map((c, i) => (
            <li key={`${c.group}-${c.text}-${i}`} id={`pal-${i}`} role="option" aria-selected={i === cur} onMouseMove={() => i !== cur && setSel(i)} onClick={() => run(c)}>
              <span className="grp">{c.group.slice(0, 1)}</span>
              <span>
                <span className="grp">{c.group}</span> {c.text}
              </span>
              <span className="k">{c.hint}</span>
            </li>
          ))
        ) : (
          <li role="option" aria-selected="false" aria-disabled="true">
            <span />
            <span className="faint">No match</span>
            <span />
          </li>
        )}
      </ul>
      <div className="foot">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> move
        </span>
        <span>
          <kbd>Enter</kbd> open
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </div>
    </dialog>
  );
}
