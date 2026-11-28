import { z } from "zod";
import type { Env } from "./env";
import { bounded } from "./limits";
import { readSnapshot } from "./ops-snapshot";

// The public aggregate numbers (capsid/rulings/system-explorer-2026-10-10.md, section 3 and answer
// 5; design capsid/research/design-system-explorer.md, section 2; docs/public-data.md).

export const FLOOR = 10;

const Count = z.number().int().min(0);
const Rate = z.number().min(0).max(1).nullable();

export const PublicStatsSchema = z.strictObject({
  version: z.literal(1),
  as_of: bounded(10).regex(/^\d{4}-\d{2}-\d{2}$/),
  sites: z.strictObject({
    watched: Count,
    uptime_7d: Rate,
    slots_measured_7d: Count,
  }),
  store: z.strictObject({ documents: Count, namespaces: Count }),
  systems: z.strictObject({ public: Count, private: Count }).nullable(),
  capsid: z.strictObject({ sha7: bounded(7).regex(/^[0-9a-f]{7}$|^unknown$/) }),
});

export type PublicStats = z.infer<typeof PublicStatsSchema>;

/** The rows the numbers are computed from. */
export interface StatsRows {
  /** Each watched site's uptime ring ('1' up, '0' down, '-' not measured). */
  rings: string[];
  documents: number;
  namespaces: number;
  systems: { public: number; private: number } | null;
  sha: string | undefined;
}

function rate(num: number, den: number): number | null {
  return den < FLOOR ? null : Math.round((num / den) * 1000) / 1000;
}

/** Midnight UTC at the start of `now`'s day: every window ends here. */
function windowEnd(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The public numbers from their rows. Pure, and the only place the rules live. */
export function summarize(rows: StatsRows, now: Date): PublicStats {
  const endIso = windowEnd(now).toISOString();
  let up = 0;
  let down = 0;
  for (const ring of rows.rings) {
    for (const c of ring) {
      if (c === "1") up++;
      else if (c === "0") down++;
    }
  }

  const sha = rows.sha && /^[0-9a-f]{7,40}$/.test(rows.sha) ? rows.sha.slice(0, 7) : "unknown";

  return {
    version: 1,
    as_of: endIso.slice(0, 10),
    sites: {
      watched: rows.rings.length,
      uptime_7d: rate(up, up + down),
      slots_measured_7d: up + down,
    },
    store: { documents: rows.documents, namespaces: rows.namespaces },
    systems: rows.systems,
    capsid: { sha7: sha },
  };
}

/** Reads the rows for summarize. */
export async function readStatsRows(
  env: Env,
  now: Date,
  systems: StatsRows["systems"],
): Promise<StatsRows> {
  const db = env.DB;
  const documents = await db.prepare("SELECT COUNT(*) AS n FROM documents").first<{ n: number }>();
  const namespaces = await db
    .prepare("SELECT COUNT(*) AS n FROM namespaces")
    .first<{ n: number }>();
  const snapshot = await readSnapshot(env);
  return {
    rings: (snapshot?.sites ?? []).map((s) => s.ring),
    documents: documents?.n ?? 0,
    namespaces: namespaces?.n ?? 0,
    systems,
    sha: env.BUILD_SHA,
  };
}
