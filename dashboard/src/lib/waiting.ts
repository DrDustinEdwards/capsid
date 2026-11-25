import { useAnswer } from "capsomer/react/data";
import { LIVE, fetchMergeUnits, fetchNamespaces } from "./api";
import { pausedProjects, unitRows } from "./merge-units";
import type { InboxApp, InboxItem, OpsFeed } from "../types";

export type Entry = { app: InboxApp; item: InboxItem };
export type AutoMergeAsks = ReturnType<typeof useAutoMergeAsks>;

// Read once for the header's count and Needs you's list, so the two cannot differ.
export function useWaiting(feed: OpsFeed | null) {
  const load = useAnswer([LIVE, "namespaces"], fetchNamespaces);
  const asks = useAutoMergeAsks(feed);
  const stops = load.data?.namespaces.filter((n) => n.breaker.open) ?? [];
  const all: Entry[] =
    feed?.live.inbox.apps.flatMap((app) => app.items.map((item) => ({ app, item }))) ?? [];
  const listed = asks.units ? all.filter((e) => e.item.kind !== "proposal") : all;
  const total = listed.length + stops.length + asks.count;
  return { listed, stops, asks, total, error: load.error, reread: load.reread };
}

function useAutoMergeAsks(feed: OpsFeed | null) {
  const load = useAnswer([LIVE, "merge-units"], fetchMergeUnits);
  const policy = feed?.live.merge_policy;
  const paused = feed ? pausedProjects(feed) : [];
  const units = load.data ?? null;
  const unitAsks =
    units && policy?.loads ? unitRows(policy.units, units).filter((r) => r.state !== "auto") : [];
  const count = (policy && !policy.loads ? 1 : 0) + paused.length + unitAsks.length;
  return { policy, paused, units, unitAsks, count, error: load.error };
}
