import type { Env } from "./env";
import type { MaintenanceItem } from "./maintenance";

// The daily maintenance pass's disk rule (job_549550d73d4e, piece 4). A driver runs
// claude-skills' scripts/disk-guard.mjs preflight before every heartbeat and puts its line
// in the heartbeat's reason: "ok: 41.2 GB free", or "STOP: 12.3 GB free on D:\work, below
// the 20 GB minimum" (claude-skills commands/improve.md, "every heartbeat reports free
// disk"). The heartbeat keeps the newest reading per driver in APP_KV; the pass lists a
// driver whose reading is under WARN_GB, or a STOP, so a full disk is seen before it stops
// a claim. A KV key per driver rather than a table: one value, overwritten, that needs no
// migration and expires on its own when a driver stops reporting.

export const DISK_PREFIX = "disk:";
const WARN_GB = 30;
// A reading older than this is not current, so it is counted as stale, not listed.
const FRESH_HOURS = 48;
// A driver that stops heartbeating leaves no key behind for long.
const READING_TTL_SECONDS = 7 * 86_400;
const MAX_LINE = 200;
const MAX_ITEMS = 50;
const LIST_LIMIT = 1000;

export interface DiskReading {
  actor: string;
  namespace: string;
  job: string;
  /** Null when a STOP line carried no figure (the free space could not be read). */
  free_gb: number | null;
  stop: boolean;
  /** The line as sent, cut to MAX_LINE. */
  line: string;
  at: string;
}

/** The free-disk line in a heartbeat reason, or null when the reason carries none. */
export function parseDiskLine(reason: string): { free_gb: number | null; stop: boolean; line: string } | null {
  const line = reason.trim().slice(0, MAX_LINE);
  const ok = /^ok:\s*(\d+(?:\.\d+)?)\s*GB free/i.exec(line);
  if (ok) return { free_gb: Number(ok[1]), stop: false, line };
  if (/^STOP:/i.test(line)) {
    const figure = /(\d+(?:\.\d+)?)\s*GB free/i.exec(line);
    return { free_gb: figure ? Number(figure[1]) : null, stop: true, line };
  }
  return null;
}

/** What a heartbeat's reason did to the stored reading, for the heartbeat's reply. */
export type DiskRecord = { recorded: true; free_gb: number | null; stop: boolean } | { recorded: false; note: string };

/** Keep the driver's newest reading. A reason with no free-disk line records nothing and
 *  says so, so a driver whose preflight line went missing finds out on its next heartbeat. */
export async function recordDiskReading(
  env: Pick<Env, "APP_KV">,
  who: { actor: string; namespace: string; job: string },
  reason: string,
  now: Date
): Promise<DiskRecord> {
  const parsed = parseDiskLine(reason);
  if (!parsed) return { recorded: false, note: 'the reason carries no free-disk line ("ok: <n> GB free" or "STOP: ..."), so no disk reading was stored' };
  const reading: DiskReading = { ...who, ...parsed, at: now.toISOString() };
  await env.APP_KV.put(DISK_PREFIX + who.actor, JSON.stringify(reading), { expirationTtl: READING_TTL_SECONDS });
  return { recorded: true, free_gb: parsed.free_gb, stop: parsed.stop };
}

/** A reading under WARN_GB or a STOP, from the readings that are current. */
function lowDisk(readings: DiskReading[], now: Date): { items: MaintenanceItem[]; fresh: number } {
  const since = now.getTime() - FRESH_HOURS * 3_600_000;
  const fresh = readings.filter((r) => Date.parse(r.at) >= since);
  const low = fresh
    .filter((r) => r.stop || (r.free_gb !== null && r.free_gb < WARN_GB))
    .sort((a, b) => (a.free_gb ?? -1) - (b.free_gb ?? -1))
    .slice(0, MAX_ITEMS);
  const items = low.map((r): MaintenanceItem => {
    const free = r.free_gb === null ? "free disk it could not read" : `${r.free_gb} GB free`;
    return {
      rule: "disk-low",
      namespace: r.namespace,
      job: r.job,
      line: `${r.actor} reported ${free} at ${r.at.slice(0, 16).replace("T", " ")} UTC${r.stop ? " and stopped claiming" : `, under ${WARN_GB} GB`}: run disk-guard cleanup or free space on that machine.`,
    };
  });
  return { items, fresh: fresh.length };
}

/** Every stored reading. A value that does not parse is listed as not checked, never
 *  dropped, so a broken reading cannot pass as a clean disk. */
export async function gatherDiskItems(env: Pick<Env, "APP_KV">, now: Date): Promise<{ items: MaintenanceItem[]; read: number }> {
  const readings: DiskReading[] = [];
  const items: MaintenanceItem[] = [];
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < 5; page++) {
    const listed = await env.APP_KV.list({ prefix: DISK_PREFIX, limit: LIST_LIMIT, cursor });
    for (const key of listed.keys) {
      const raw = await env.APP_KV.get(key.name);
      if (raw === null) continue;
      try {
        const r = JSON.parse(raw) as DiskReading;
        if (typeof r.at !== "string" || typeof r.actor !== "string") throw new Error("missing at or actor");
        readings.push(r);
      } catch (err) {
        items.push(notChecked(`${key.name} does not parse (${err instanceof Error ? err.message : String(err)})`));
      }
    }
    if (listed.list_complete) {
      complete = true;
      break;
    }
    cursor = listed.cursor;
  }
  if (!complete) items.push(notChecked(`more than ${5 * LIST_LIMIT} readings; the rest were not read`));
  const low = lowDisk(readings, now);
  items.unshift(...low.items);
  return { items, read: low.fresh };
}

function notChecked(problem: string): MaintenanceItem {
  return { rule: "disk-not-checked", namespace: "drivers", job: null, line: `Driver disk readings were not fully checked (${problem}): what is missing is not a clean result.` };
}
