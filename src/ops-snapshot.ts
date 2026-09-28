import type { Env } from "./env";
import type { HealthReport } from "./health";
import type { OpsSite } from "./ops-sites";
import type { CiObservation, MirrorObservation, OpsSnapshot, SiteCloudflare, SiteMapDrift, SiteProbe, SiteSnapshot } from "./ops-types";

// The watcher's pass, kept (capsid/research/design-ops-console.md, PR 1 of the Watch
// Floor build). Until this, a pass kept only its timestamp: every check's outcome, the
// mirror's newest dump and last run, and each repo's latest CI run were computed and
// thrown away. The dashboard reads this one KV value instead of assembling the same
// facts from about a hundred reads per load.

export const OPS_SNAPSHOT_KEY = "ops:snapshot";

// Uptime is a ring of half-hour slots aligned to the clock, 7 days long. A slot holds
// '1' (the site answered), '0' (it did not) or '-' (no pass ran in that slot), so a
// watcher that stopped shows as missing data rather than as uptime.
const RING_SLOT_MINUTES = 30;
export const RING_SLOTS = (7 * 24 * 60) / RING_SLOT_MINUTES;

const PROBE_TIMEOUT_MS = 5000;

// The shapes live in src/ops-types.ts, the contract the dashboard app reads.
// ok: the health route answered 2xx. degraded: it did not, but the root did.
// liveness: the site has no health route and its root answered 2xx, which proves it is
// up and nothing more. down: nothing answered 2xx.
export type { CheckState, CiObservation, MirrorObservation, OpsSnapshot, ProbeState, SiteProbe, SiteSnapshot } from "./ops-types";

export const ringSlot = (at: Date): number => Math.floor(at.getTime() / (RING_SLOT_MINUTES * 60_000));

/** Adds this pass's result to a site's ring. Slots no pass reached become '-'. Two
 *  passes in one slot (a Refresh run on demand) keep the worse result, so a failure is
 *  never overwritten by a later success in the same half hour. */
export function advanceRing(
  prev: { ring: string; ring_slot: number } | undefined,
  slot: number,
  up: boolean
): { ring: string; ring_slot: number } {
  const mark = up ? "1" : "0";
  if (!prev || prev.ring.length === 0) return { ring: mark, ring_slot: slot };
  if (slot <= prev.ring_slot) {
    // The same slot, or a clock that stepped back: fold into the last slot.
    const last = prev.ring.slice(-1);
    const worse = last === "0" || !up ? "0" : "1";
    return { ring: prev.ring.slice(0, -1) + worse, ring_slot: prev.ring_slot };
  }
  const gap = Math.min(slot - prev.ring_slot - 1, RING_SLOTS);
  const ring = (prev.ring + "-".repeat(gap) + mark).slice(-RING_SLOTS);
  return { ring, ring_slot: slot };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface Reached {
  status: number | null;
  latency_ms: number | null;
  body: string | null;
  error: string | null;
}

async function reach(fetchImpl: FetchLike, url: string, withBody: boolean): Promise<Reached> {
  const started = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "capsid-watcher (ops probe)" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latency_ms = Date.now() - started;
    const body = withBody ? await res.text() : null;
    if (!withBody) await res.body?.cancel();
    return { status: res.status, latency_ms, body, error: null };
  } catch (err) {
    // A probe that got no answer is a result (the site is down from here), recorded
    // with its reason, not an error in the watcher.
    return { status: null, latency_ms: null, body: null, error: (err instanceof Error ? err.message : String(err)).slice(0, 160) };
  }
}

const is2xx = (status: number | null): boolean => status !== null && status >= 200 && status < 300;

// A health body's sha, where it reports one as a string. Anything else (not JSON, no
// sha field) is a site that does not report a sha, which the dashboard shows as such.
function shaFrom(body: string | null): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { sha?: unknown };
    return typeof parsed.sha === "string" && parsed.sha.length > 0 ? parsed.sha.slice(0, 40) : null;
  } catch {
    return null;
  }
}

/** One site. The health route when it has one, and the root as well when that route
 *  fails, so a broken health route on a site that is up reads as degraded, not down. */
export async function probeSite(site: OpsSite, fetchImpl: FetchLike, now: Date, selfHealth: HealthReport | null): Promise<SiteProbe> {
  const base = {
    namespace: site.namespace,
    name: site.name,
    origin: site.origin,
    health_path: site.healthPath,
    platform: site.platform,
    checked_at: now.toISOString(),
  };
  if (site.self) {
    if (!selfHealth) return { ...base, state: "down", http_status: null, latency_ms: null, sha: null, error: "healthReport could not be read this pass" };
    const ok = selfHealth.status === "ok";
    return { ...base, state: ok ? "ok" : "degraded", http_status: ok ? 200 : 503, latency_ms: null, sha: selfHealth.sha === "unknown" ? null : selfHealth.sha, error: null };
  }
  if (site.healthPath === null) {
    const root = await reach(fetchImpl, site.origin + "/", false);
    return { ...base, state: is2xx(root.status) ? "liveness" : "down", http_status: root.status, latency_ms: root.latency_ms, sha: null, error: root.error };
  }
  const health = await reach(fetchImpl, site.origin + site.healthPath, true);
  if (is2xx(health.status)) {
    return { ...base, state: "ok", http_status: health.status, latency_ms: health.latency_ms, sha: shaFrom(health.body), error: null };
  }
  const root = await reach(fetchImpl, site.origin + "/", false);
  const why = health.error ?? `health route answered ${health.status}`;
  return is2xx(root.status)
    ? { ...base, state: "degraded", http_status: health.status, latency_ms: root.latency_ms, sha: null, error: why }
    : { ...base, state: "down", http_status: root.status ?? health.status, latency_ms: null, sha: null, error: `${why}; root ${root.error ?? `answered ${root.status}`}` };
}

const probeIsUp = (p: SiteProbe): boolean => p.state !== "down";

export interface SnapshotInput {
  now: Date;
  pass_ms: number;
  cadence_min: number;
  checks: OpsSnapshot["checks"];
  health: HealthReport | null;
  mirror: MirrorObservation | null;
  ci: CiObservation[];
  site_map: SiteMapDrift | null;
  // Null when the probes could not run at all this pass.
  probes: SiteProbe[] | null;
  // This pass's Cloudflare state per site, keyed by namespace (src/ops-cloudflare.ts).
  // A probed site with no entry is written without the field, never with last pass's.
  cloudflare?: Record<string, SiteCloudflare>;
}

/** The snapshot for this pass, carrying each site's ring forward from `prev`. A site
 *  not probed this pass keeps its last probe and gets a '-' slot, so the ring says a
 *  pass happened without an answer for it. */
export function buildSnapshot(prev: OpsSnapshot | null, input: SnapshotInput): OpsSnapshot {
  const slot = ringSlot(input.now);
  const prevSites = new Map((prev?.sites ?? []).map((s) => [s.namespace, s]));
  const sites: SiteSnapshot[] = [];
  for (const probe of input.probes ?? []) {
    const before = prevSites.get(probe.namespace);
    const cloudflare = input.cloudflare?.[probe.namespace];
    sites.push({ ...probe, ...advanceRing(before, slot, probeIsUp(probe)), ...(cloudflare ? { cloudflare } : {}) });
    prevSites.delete(probe.namespace);
  }
  if (input.probes === null) {
    for (const before of prevSites.values()) {
      const gap = Math.min(Math.max(slot - before.ring_slot, 0), RING_SLOTS);
      const cloudflare = input.cloudflare?.[before.namespace];
      sites.push({
        ...before,
        ring: (before.ring + "-".repeat(gap)).slice(-RING_SLOTS),
        ring_slot: Math.max(slot, before.ring_slot),
        ...(cloudflare ? { cloudflare } : {}),
      });
    }
  }
  return {
    version: 1,
    pass_at: input.now.toISOString(),
    pass_ms: input.pass_ms,
    cadence_min: input.cadence_min,
    checks: input.checks,
    health: input.health,
    mirror: input.mirror,
    ci: input.ci,
    site_map: input.site_map,
    sites,
  };
}

/** The last snapshot, for its rings. A value that does not parse is logged and treated
 *  as absent: the next write replaces it, and the rings restart, which the dashboard
 *  shows as missing history rather than as uptime. */
export async function readSnapshot(env: Pick<Env, "APP_KV">): Promise<OpsSnapshot | null> {
  const raw = await env.APP_KV.get(OPS_SNAPSHOT_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as OpsSnapshot;
    if (parsed?.version !== 1 || !Array.isArray(parsed.sites)) throw new Error(`unexpected shape (version ${String(parsed?.version)})`);
    return parsed;
  } catch (err) {
    console.error(`OPS_SNAPSHOT_UNREADABLE ${err instanceof Error ? err.message : String(err)}; starting the rings again`);
    return null;
  }
}

export async function writeSnapshot(env: Pick<Env, "APP_KV">, snapshot: OpsSnapshot): Promise<void> {
  await env.APP_KV.put(OPS_SNAPSHOT_KEY, JSON.stringify(snapshot));
}
