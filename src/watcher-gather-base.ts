import type { Env } from "./env";
import type { Observed } from "./watcher";
import type { WatcherCheck } from "./watcher-checks";
import type { Finding } from "./watcher-detect";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";

// What the watcher's read phases share (src/watcher-gather.ts runs them in turn).

// How many reads of one roster run together: the pass waits on GitHub and Cloudflare (src/map-limit.ts).
export const READ_CONCURRENCY = 6;

export async function attempt<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    logEvent(
      "WATCHER_READ_FAILED",
      {
        message: `WATCHER_READ_FAILED ${what}: ${errorMessage(err)}`,
      },
      { level: "error" },
    );
    return null;
  }
}

/** One pass: the findings, the checks that ran and what was observed, filled in by each phase. */
export type Pass = {
  env: Env;
  now: Date;
  fetchImpl: typeof fetch;
  out: Finding[];
  ran: Set<WatcherCheck>;
  observed: Observed;
};
