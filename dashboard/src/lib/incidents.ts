import type { OpenRef } from "./derive";
import { JOB, isOpen } from "./derive";
import type { OpsFeed } from "../types";
import { parse } from "capsomer/behavior/time";

export interface Incident {
  sev: "crit" | "warn";
  open: boolean;
  title: string;
  fp: string;
  ns: string;
  at: number;
  ref: OpenRef | null;
  status: string;
}

const HOT = /^(probe|down|offaccount|backup)/;

export function incidents(feed: OpsFeed): Incident[] {
  const items: Incident[] = [];
  const seen = new Set<string>();
  for (const j of feed.live.jobs) {
    if (!j.finding) continue;
    seen.add(j.finding.fingerprint);
    items.push({
      sev: HOT.test(j.finding.fingerprint) ? "crit" : "warn",
      open: isOpen(j),
      title: j.title.replace(/^Watcher: /, "").replace(/ \[[^\]]*\]$/, ""),
      fp: j.finding.fingerprint,
      ns: j.namespace,
      at: parse(j.created_at),
      ref: `job:${j.id}`,
      status: JOB[j.status].label.toLowerCase(),
    });
  }
  // A check's finding with no job in the live window: shown, not openable.
  for (const c of feed.snapshot?.checks ?? []) {
    if (c.state !== "finding") continue;
    for (const fp of c.findings) {
      if (seen.has(fp)) continue;
      items.push({
        sev: HOT.test(fp) ? "crit" : "warn",
        open: true,
        title: `Check '${c.id}' reports a finding`,
        fp,
        ns: "watcher",
        at: parse(feed.snapshot?.pass_at ?? feed.live.generated),
        ref: null,
        status: "no job in the live window",
      });
    }
  }
  return items.sort((a, b) => Number(b.open) - Number(a.open) || b.at - a.at);
}
