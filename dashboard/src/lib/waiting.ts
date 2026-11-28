import { useAnswer } from "capsomer/react/data";
import { LIVE, fetchNamespaces } from "./api";
import type { InboxApp, InboxItem, OpsFeed } from "../types";

export type Entry = { app: InboxApp; item: InboxItem };

// Read once for the header's count and Needs you's list, so the two cannot differ.
export function useWaiting(feed: OpsFeed | null) {
  const load = useAnswer([LIVE, "namespaces"], fetchNamespaces);
  const stops = load.data?.namespaces.filter((n) => n.breaker.open) ?? [];
  const listed: Entry[] =
    feed?.live.inbox.apps.flatMap((app) => app.items.map((item) => ({ app, item }))) ?? [];
  const total = listed.length + stops.length;
  return { listed, stops, total, error: load.error, reread: load.reread };
}
