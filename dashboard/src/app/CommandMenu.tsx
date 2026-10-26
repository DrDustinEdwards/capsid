import { useMemo } from "react";
import { CommandMenu, type Command } from "capsomer/react/command-menu";
import "capsomer/listbox.css";
import "capsomer/command-menu.css";
import type { OpsFeed } from "../types";
import type { ViewDef, ViewId } from "./ctx";
import { stopCommands, type StopActions } from "../lib/stops";
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
  const out: Command[] = views.map((v) => ({ id: `view-${v.id}`, group: "Go to", label: v.label, shortcut: `g ${v.key}`, run: () => a.go(v.id) }));
  const sites = feed && hasSites(feed) ? (feed.snapshot?.sites ?? []) : [];
  for (const s of sites) out.push({ id: `site-${siteKey(s)}`, group: "Site", label: s.name, keywords: [hostOf(s.origin)], hint: `${hostOf(s.origin)} · ${PROBE[s.state].label}`, run: () => a.open(`site:${siteKey(s)}`) });
  for (const j of feed?.live.jobs ?? []) out.push({ id: `job-${j.id}`, group: "Job", label: j.title, keywords: [j.namespace], hint: `${JOB[j.status].label} · ${j.namespace}`, run: () => a.open(`job:${j.id}`) });
  for (const g of feed?.live.agents ?? []) out.push({ id: `agent-${g.name}`, group: "Agent", label: g.name, hint: g.last_seen ? ago(ms(g.last_seen), now) : "never seen", run: () => a.open(`agent:${g.name}`) });
  out.push(...stopCommands(feed, a));
  out.push({ id: "refresh", group: "Action", label: "Refresh now", shortcut: "r", run: a.refresh });
  out.push({ id: "theme", group: "Action", label: "Switch light and dark", shortcut: "t", run: a.theme });
  out.push({ id: "help", group: "Action", label: "Show keyboard shortcuts", shortcut: "?", run: a.help });
  for (const j of feed?.live.jobs ?? []) {
    if (j.status === "blocked" && j.command) {
      const cmd = j.command;
      out.push({ id: `copy-${j.id}`, group: "Copy", label: `Copy the command for: ${j.title}`, hint: j.namespace, run: () => a.copy(cmd) });
    }
  }
  return out;
}

// Capsomer's command menu with its list built from the feed: App loads this module on the
// first Ctrl K, so neither the menu nor its list builder is in the initial bundle. App binds
// the keys (Ctrl K, Cmd K and "/") itself, since this module is not loaded until then.
export function CommandPalette({ open, onClose, feed, views, actions, now }: { open: boolean; onClose: () => void; feed: OpsFeed | null; views: ReadonlyArray<ViewDef>; actions: Actions; now: number }) {
  const list = useMemo(() => commands(feed, views, actions, now), [feed, views, actions, now]);
  return <CommandMenu open={open} onOpenChange={(o) => !o && onClose()} commands={list} bindKeys={false} placeholder="Jump to a site, job, agent or view, or stop something" />;
}
