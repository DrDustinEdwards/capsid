import type { Env } from "./env";
import { healthReport } from "./health";
import { probeSite } from "./ops-snapshot";
import { readSiteConfig, sitesFrom } from "./ops-sites";
import type { SiteProbe } from "./ops-types/sites";
import { DAY_MS } from "./time";

// THE FIVE-MINUTE PULSE (area 8, 2026-10-30). The watcher probes the sites half-hourly
// for the Portal's rings and findings, and until this nothing told Dustin when a site went
// down. On every tick the pulse probes each site's health route as the watcher does
// (src/ops-snapshot.ts probeSite, the root only when that route fails) and keeps, per
// site, how many probes in a row were down. Its alerts go out through src/push.ts, which
// records each key it sends, so each fires once:
//   down       on the second down probe in a row, once per outage;
//   back up    when a site called down answers again, once, kept a day so a tick with
//              no device does not lose it;
//   degraded   once per UTC day per failing check while the health route admits a
//              problem, so a check that starts failing later the same day (a cron, the
//              backup) still pushes after an earlier warning on that site has.

export const SITE_PULSE_KEY = "site-pulse:state";
const DOWN_AFTER = 2;

export interface PulseSite {
  name: string;
  // Down probes in a row; 0 once one is not down.
  fails: number;
  // When the site was called down (its second down probe), null while it is not down.
  down_since: string | null;
  // The last down probe's reason, while it is down.
  down_reason: string | null;
  // The outage it came back from, kept a day for the alert.
  recovered: { down_since: string; at: string } | null;
  // The reason, while the health route reports degraded.
  degraded: string | null;
}

type PulseState = Record<string, PulseSite>;

interface SiteAlert {
  key: string;
  namespace: string;
  title: string;
  body: string;
}

/** A site's pulse after this probe. */
export function nextPulse(prev: PulseSite | undefined, probe: SiteProbe, now: Date): PulseSite {
  const at = now.toISOString();
  const down = probe.state === "down";
  const fails = down ? (prev?.fails ?? 0) + 1 : 0;
  let downSince = prev?.down_since ?? null;
  let recovered = prev?.recovered ?? null;
  if (down && downSince === null && fails >= DOWN_AFTER) {
    downSince = at;
    recovered = null;
  } else if (!down && downSince !== null) {
    recovered = { down_since: downSince, at };
    downSince = null;
  }
  if (recovered && now.getTime() - Date.parse(recovered.at) > DAY_MS) recovered = null;
  return {
    name: probe.name,
    fails,
    down_since: downSince,
    down_reason: down ? (probe.error ?? `answered ${probe.http_status ?? "nothing"}`) : null,
    recovered,
    degraded: probe.state === "degraded" ? (probe.error ?? "the health route reports degraded") : null,
  };
}

/** The failing checks a degraded reason names: health-format joins them with "; ", and a
 *  part such as "backup: last successful backup was 38h ago" is keyed by its name only, so
 *  an age that grows each probe is still one check. */
function degradedChecks(reason: string): string[] {
  const names = reason.split("; ").map((part) => part.split(":")[0]!.trim().slice(0, 60)).filter(Boolean);
  return names.length ? [...new Set(names)] : ["health"];
}

/** The alerts the pulse stands behind now. A key names its outage or its day, so the
 *  sent record in src/push.ts turns these into once per outage and once a day. */
export function pulseAlerts(state: PulseState, now: Date): SiteAlert[] {
  const out: SiteAlert[] = [];
  const day = now.toISOString().slice(0, 10);
  for (const [namespace, s] of Object.entries(state)) {
    if (s.down_since) {
      out.push({ key: `site-down:${namespace}:${s.down_since}`, namespace, title: `${s.name} is down`, body: `Down on ${DOWN_AFTER} probes in a row since ${s.down_since}: ${s.down_reason ?? "no answer"}.` });
    } else if (s.degraded) {
      for (const check of degradedChecks(s.degraded)) {
        out.push({ key: `site-degraded:${namespace}:${check}:${day}`, namespace, title: `${s.name} is degraded: ${check}`, body: s.degraded });
      }
    }
    if (s.recovered) {
      out.push({ key: `site-up:${namespace}:${s.recovered.down_since}`, namespace, title: `${s.name} is back up`, body: `Down from ${s.recovered.down_since}, answering again at ${s.recovered.at}.` });
    }
  }
  return out;
}

export async function readPulse(env: Pick<Env, "APP_KV">): Promise<PulseState> {
  const raw = await env.APP_KV.get(SITE_PULSE_KEY);
  return raw ? (JSON.parse(raw) as PulseState) : {};
}

/** One pass: every configured site probed, the state written back. A site no longer
 *  configured drops out. Reports a run only when a site was called down or came back. */
export async function sitePulseTick(env: Env, now: Date, fetchImpl: typeof fetch = fetch): Promise<{ ran: boolean; note: string }> {
  const sites = sitesFrom(await readSiteConfig(env.DB));
  if (sites.length === 0) return { ran: false, note: "no site configured" };
  const prev = await readPulse(env);
  const self = sites.some((s) => s.self) ? await healthReport(env).catch(() => null) : null;
  const next: PulseState = {};
  const changed: string[] = [];
  for (const site of sites) {
    const pulse = nextPulse(prev[site.namespace], await probeSite(site, fetchImpl, now, self), now);
    next[site.namespace] = pulse;
    const was = prev[site.namespace]?.down_since ?? null;
    if (pulse.down_since !== was) changed.push(`${site.namespace} ${pulse.down_since ? "down" : "back up"}`);
  }
  const written = JSON.stringify(next);
  if (written !== JSON.stringify(prev)) await env.APP_KV.put(SITE_PULSE_KEY, written);
  return { ran: changed.length > 0, note: changed.length ? changed.join(", ") : `${sites.length} sites probed, no change` };
}
