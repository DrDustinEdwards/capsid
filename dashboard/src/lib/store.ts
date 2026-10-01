import type { OpsFeed } from "../types";
import { bytes } from "./format";

// The D1 store against its cap (capsid/decisions.md 2026-09-30, "admin panels review
// adopted", item 5): a warning from half, Foxhound's threshold.
export const STORE_WARN_FRACTION = 0.5;

export function storeUse(feed: OpsFeed): { fraction: number; warn: boolean } | null {
  const s = feed.live.store;
  if (s.size_bytes === null) return null;
  const fraction = s.size_bytes / s.cap_bytes;
  return { fraction, warn: fraction >= STORE_WARN_FRACTION };
}

/** The Needs attention row's words, from half the cap; null below it or unreported. */
export function storeAttention(feed: OpsFeed): { title: string; sub: string } | null {
  const use = storeUse(feed);
  const s = feed.live.store;
  if (!use?.warn || s.size_bytes === null) return null;
  return { title: `The D1 store is at ${(use.fraction * 100).toFixed(0)}% of its ${bytes(s.cap_bytes)} cap`, sub: `${bytes(s.size_bytes)} used` };
}
