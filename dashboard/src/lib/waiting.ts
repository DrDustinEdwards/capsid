import { useAnswer } from "capsomer/react/data";
import { LIVE, fetchMergeUnits, fetchNamespaces } from "./api";
import { pausedProjects, unitRows } from "./merge-units";
import type { InboxApp, InboxItem, OpsFeed } from "../types";

export type Entry = { app: InboxApp; item: InboxItem };
export type AutoMergeAsks = ReturnType<typeof useAutoMergeAsks>;

// Everything waiting on you, read once for the header's count and for Needs you's list, so the
// two cannot differ. Stopped queues come from the roster read (GET /portal/api/namespaces),
// read again with each feed so a reset drops its row.
export function useWaiting(feed: OpsFeed | null) {
  const load = useAnswer([LIVE, "namespaces"], fetchNamespaces);
  const asks = useAutoMergeAsks(feed);
  const stops = load.data?.namespaces.filter((n) => n.breaker.open) ?? [];
  const all: Entry[] =
    feed?.live.inbox.apps.flatMap((app) => app.items.map((item) => ({ app, item }))) ?? [];
  const prs = all.filter((e) => e.item.kind === "pr");
  const jobs = all.filter((e) => e.item.kind === "question" || e.item.kind === "blocked-job");
  // A merge unit's proposal or suspension is a row of Auto-merge, with its button, once the
  // units are read; until then, or if they cannot be read, it shows under Also waiting.
  const other = all.filter(
    (e) => !prs.includes(e) && !jobs.includes(e) && !(asks.units && e.item.kind === "proposal"),
  );
  const total = prs.length + jobs.length + other.length + stops.length + asks.count;
  return { prs, jobs, other, stops, asks, total, error: load.error, reread: load.reread };
}

// A policy that does not load, a paused project, a merge unit to sign or lift.
function useAutoMergeAsks(feed: OpsFeed | null) {
  const load = useAnswer([LIVE, "merge-units"], fetchMergeUnits);
  const policy = feed?.live.merge_policy;
  const paused = feed ? pausedProjects(feed) : [];
  const units = load.data ?? null;
  const unitAsks =
    units && policy?.loads ? unitRows(policy.units, units).filter((r) => r.state !== "auto") : [];
  const suspended = new Set(units?.suspended.map((s) => s.unit));
  const count = (policy && !policy.loads ? 1 : 0) + paused.length + unitAsks.length;
  return { policy, paused, units, unitAsks, suspended, count };
}
