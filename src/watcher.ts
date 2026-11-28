import type { Env } from "./env";
import { runPass } from "./watcher-pass";
import { type HealthReport } from "./health";
import { d1FindingMemory } from "./watcher-findings";
import { type SiteMapDrift } from "./ops-sites";
import { weekStatement } from "./ops-packages";
import type { ExpirySnapshot, PackageSnapshot, SiteCloudflare } from "./ops-types/sites";
import { archiveRevokedAgents } from "./agents-archive";
import {
  buildSnapshot,
  readSnapshot,
  writeSnapshot,
  type CiObservation,
  type OffaccountObservation,
  type OpsSnapshot,
  type SiteProbe,
} from "./ops-snapshot";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import type { Finding } from "./watcher-detect";
import { type WatcherCheck, WATCHER_CHECKS, owningCheck } from "./watcher-checks";
import { MINUTE_MS } from "./time";

// The watcher looks at the surface every half hour and records what is wrong in watcher_findings,
// which the board shows. It holds no blast-radius flag and cannot fix anything.

const WATCHER_NAME = "watcher";
export const WATCHER_ACTOR = `agent:${WATCHER_NAME}`;

const WATCHER_CADENCE_KEY = "watcher:cadence-minutes";
export const WATCHER_LAST_KEY = "watcher:last";

// KV-configurable. The tick runs every five minutes, so all but one invocation in six
// returns after a single KV read.
export const DEFAULT_CADENCE_MINUTES = 30;

// The floor. Zero or a negative number would run every check on every tick, which
// turns a bounded cost into an unbounded one, so an unusable value falls back rather
// than being obeyed.
const MIN_CADENCE_MINUTES = 5;

export async function cadenceMinutes(env: Env): Promise<number> {
  try {
    const raw = await env.APP_KV.get(WATCHER_CADENCE_KEY);
    if (raw === null) return DEFAULT_CADENCE_MINUTES;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < MIN_CADENCE_MINUTES) return DEFAULT_CADENCE_MINUTES;
    return Math.floor(parsed);
  } catch {
    // An unreadable store means the default.
    return DEFAULT_CADENCE_MINUTES;
  }
}

export type DueVerdict = { due: true; reason: string } | { due: false; reason: string };

export function passDue(lastIso: string | null, minutes: number, now: Date): DueVerdict {
  if (!lastIso) return { due: true, reason: "the watcher has not run yet." };
  const last = Date.parse(lastIso);
  // A corrupt stamp runs the pass: an extra pass is cheap, a watcher that silently
  // stopped is not.
  if (Number.isNaN(last))
    return {
      due: true,
      reason: `last-run stamp '${lastIso}' does not parse; running rather than blocking.`,
    };
  const elapsed = (now.getTime() - last) / MINUTE_MS;
  if (elapsed < minutes)
    return {
      due: false,
      reason: `${Math.floor(elapsed)} of ${minutes} minutes since the last pass.`,
    };
  return {
    due: true,
    reason: `${Math.floor(elapsed)} minutes since the last pass, cadence is ${minutes}.`,
  };
}

export interface WatcherReport {
  ran: boolean;
  note: string;
  recorded: string[];
  cleared: string[];
}

// What a pass saw, kept for the operations dashboard (src/ops-snapshot.ts). Null
// where the read failed, so the snapshot says "could not read" rather than "none".
export interface Observed {
  health: HealthReport | null;
  offaccount: OffaccountObservation | null;
  ci: CiObservation[];
  siteMap: SiteMapDrift | null;
  probes: SiteProbe[] | null;
  // Each site's Cloudflare state, keyed by namespace. Optional so a pass assembled
  // without it (a test's Gathered) still builds a snapshot.
  cloudflare?: Record<string, SiteCloudflare>;
  // Each configured package as this pass read it; [] with none configured, absent when
  // the configuration could not be read (the snapshot then keeps the last pass's).
  packages?: PackageSnapshot[];
  // The TLS and domain expiry dates this pass read; a part that failed is null.
  expiry?: ExpirySnapshot;
}

export interface Gathered {
  findings: Finding[];
  // The checks whose reads all succeeded this pass.
  ran: ReadonlySet<WatcherCheck>;
  observed: Observed;
}

/** The snapshot's check list: every check, as clear, finding, or could not run. */
export function checkStates(gathered: Pick<Gathered, "findings" | "ran">): OpsSnapshot["checks"] {
  return WATCHER_CHECKS.map((id) => {
    const findings = gathered.findings
      .filter((f) => owningCheck(f.fingerprint) === id)
      .map((f) => f.fingerprint);
    return {
      id,
      state: !gathered.ran.has(id) ? "could-not-run" : findings.length ? "finding" : "clear",
      findings,
    };
  });
}

// The step the five-minute tick calls. Gates on its own cadence first, unless `force` (the Portal's
// Refresh, src/ops-feed.ts), which skips that check and nothing else.
export async function watcherTick(
  env: Env,
  now: Date,
  gather: () => Promise<Gathered>,
  opts: { force?: boolean } = {},
): Promise<WatcherReport> {
  const minutes = await cadenceMinutes(env);
  const last = await env.APP_KV.get(WATCHER_LAST_KEY).catch(() => null);
  const due: DueVerdict = opts.force
    ? { due: true, reason: "an on-demand pass." }
    : passDue(last, minutes, now);
  if (!due.due) return { ran: false, note: due.reason, recorded: [], cleared: [] };

  const started = Date.now();
  const gathered = await gather();
  const { recorded, cleared, held } = await runPass(
    { findings: async () => gathered, memory: d1FindingMemory(env) },
    now,
  );

  // The pass, kept for the dashboard. Before the stamp: a snapshot that fails to write
  // throws, the stamp is not written, and the next tick runs the pass again.
  const o = gathered.observed;
  await writeSnapshot(
    env,
    buildSnapshot(await readSnapshot(env), {
      now,
      pass_ms: Date.now() - started,
      cadence_min: minutes,
      checks: checkStates(gathered),
      health: o.health,
      offaccount: o.offaccount,
      ci: o.ci,
      site_map: o.siteMap,
      probes: o.probes,
      cloudflare: o.cloudflare,
      packages: o.packages,
      expiry: o.expiry,
    }),
  );
  // The week's GitHub numbers, once per package per ISO week (ops_package_weeks). A
  // failed write loses one week's row, not the pass: it is logged, and the next pass
  // that week writes it.
  const weekly = (o.packages ?? [])
    .map((p) => weekStatement(env.DB, p, now))
    .filter((st): st is D1PreparedStatement => st !== null);
  if (weekly.length > 0) {
    try {
      await env.DB.batch(weekly);
    } catch (err) {
      logEvent(
        "WATCHER_PACKAGE_WEEKS_FAILED",
        {
          message: `WATCHER_PACKAGE_WEEKS_FAILED: ${errorMessage(err)}`,
        },
        { level: "error" },
      );
    }
  }

  // Revoked agents out of the live table, history kept (src/agents-archive.ts). A failed
  // move is logged and retried next pass; it never stops the pass.
  try {
    const moved = await archiveRevokedAgents(env.DB, WATCHER_ACTOR, now);
    if (moved.archived.length > 0 || moved.skipped.length > 0) {
      logEvent("WATCHER_AGENTS_ARCHIVED", {
        message: `WATCHER_AGENTS_ARCHIVED ${moved.archived.map((a) => `${a.name} (${a.reason})`).join(", ") || "none"}; changed under the move: ${moved.skipped.join(", ") || "none"}`,
      });
    }
  } catch (err) {
    logEvent(
      "WATCHER_AGENTS_ARCHIVE_FAILED",
      {
        message: `WATCHER_AGENTS_ARCHIVE_FAILED: ${errorMessage(err)}`,
      },
      { level: "error" },
    );
  }

  // Written last and only on a pass that ran. A stamp written first would make a
  // throwing pass look completed and skip the next several ticks.
  await env.APP_KV.put(WATCHER_LAST_KEY, now.toISOString());
  return {
    ran: true,
    note: `${due.reason} recorded ${recorded.length}, cleared ${cleared.length}, held ${held.length}.`,
    recorded,
    cleared,
  };
}
