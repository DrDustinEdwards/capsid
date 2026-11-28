import type { OpsFeed } from "../types";
import { parse } from "capsomer/behavior/time";

export interface Incident {
  sev: "crit" | "warn";
  title: string;
  fp: string;
  ns: string;
  at: number;
  status: string;
}

const HOT = /^(probe|down|offaccount|backup)/;

export function incidents(feed: OpsFeed): Incident[] {
  const items: Incident[] = [];
  const seen = new Set<string>();
  for (const f of feed.live.findings) {
    if (f.class !== "alert") continue;
    seen.add(f.fingerprint);
    items.push({
      sev: HOT.test(f.fingerprint) ? "crit" : "warn",
      title: f.headline,
      fp: f.fingerprint,
      ns: f.namespace,
      at: parse(f.first_seen),
      status: "open",
    });
  }
  for (const c of feed.snapshot?.checks ?? []) {
    if (c.state !== "finding") continue;
    for (const fp of c.findings) {
      if (seen.has(fp)) continue;
      items.push({
        sev: HOT.test(fp) ? "crit" : "warn",
        title: `Check '${c.id}' reports a finding`,
        fp,
        ns: "watcher",
        at: parse(feed.snapshot?.pass_at ?? feed.live.generated),
        status: "not recorded yet",
      });
    }
  }
  return items.sort((a, b) => b.at - a.at);
}
