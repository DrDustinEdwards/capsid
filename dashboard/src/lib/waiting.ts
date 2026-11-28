import type { InboxApp, InboxItem, OpsFeed } from "../types";

type Entry = { app: InboxApp; item: InboxItem };

// Read once for the header's count and Needs you's list, so the two cannot differ.
export function useWaiting(feed: OpsFeed | null) {
  const listed: Entry[] =
    feed?.live.inbox.apps.flatMap((app) => app.items.map((item) => ({ app, item }))) ?? [];
  return { listed, total: listed.length };
}
