import type { Env } from "./env";
import { CF_API, cfGetAll, cloudflareCredentials, type FetchLike } from "./ops-cloudflare";
import { registrableDomain } from "./domain-expiry";
import { DAY_MS } from "./time";

// TLS CERTIFICATE EXPIRY (area 8, U5), beside the domain registration check
// (src/domain-expiry.ts). A Worker cannot see the certificate a TLS peer presents, so the
// date comes from where the edge certificate lives: the zone's certificate packs in the
// Cloudflare API (GET /zones?name=<domain>, then GET /zones/{id}/ssl/certificate_packs).
// A host's expiry is the latest expires_on among the certificates of the active packs that
// cover it (the host itself, or a one-label wildcard over it): while a renewed certificate
// is being issued beside the old one, the old date would alert for nothing.
//
// The watcher pass reads it (src/watcher-gather.ts) and keeps it in KV; the five-minute push
// (src/push.ts) sends each host once at 14 days and once at 3, keyed by the date, so a
// renewal that moves the date clears it and a new near date alerts again. Hosts on Vercel
// or a hosting suffix are not on a Cloudflare zone of ours and are left out.
//
// CF_OPS_TOKEN needs Zone / SSL and Certificates / Read (and the Zone / Zone / Read it holds)
// for this read; without it the read fails, is logged, and the stored dates are kept.

export const TLS_EXPIRY_KEY = "tls:expiry:v1";
const EARLY_DAYS = 14;
const LATE_DAYS = 3;

export interface TlsExpiry {
  read_at: string;
  hosts: Array<{ host: string; expires: string }>;
  failed: Array<{ host: string; error: string }>;
}

interface Pack {
  status?: unknown;
  hosts?: unknown;
  certificates?: Array<{ expires_on?: unknown; status?: unknown }>;
}

/** Whether a pack's host entry covers `host`: the same name, or `*.parent` one label up. */
function covers(entry: string, host: string): boolean {
  const e = entry.toLowerCase();
  if (e === host) return true;
  return e.startsWith("*.") && host.endsWith(e.slice(1)) && !host.slice(0, -e.length + 1).includes(".");
}

/** The latest expiry of the active certificates that cover `host`, ISO, or null. */
function hostExpiry(packs: readonly Pack[], host: string): string | null {
  let latest: number | null = null;
  for (const pack of packs) {
    if (pack.status !== "active" || !Array.isArray(pack.hosts)) continue;
    if (!pack.hosts.some((h) => typeof h === "string" && covers(h, host))) continue;
    for (const cert of pack.certificates ?? []) {
      const at = typeof cert.expires_on === "string" ? Date.parse(cert.expires_on) : NaN;
      if (Number.isFinite(at) && (latest === null || at > latest)) latest = at;
    }
  }
  return latest === null ? null : new Date(latest).toISOString();
}

/** Each Cloudflare-hosted origin's certificate expiry, read zone by zone. */
export async function readTlsExpiry(env: Env, origins: ReadonlyArray<{ origin: string | null; platform: string | null }>, fetchImpl: FetchLike, now: Date): Promise<TlsExpiry> {
  const credentials = cloudflareCredentials(env);
  if (!credentials.ok) throw new Error(credentials.reason);
  const byDomain = new Map<string, string[]>();
  for (const o of origins) {
    if (!o.origin || o.platform !== "cloudflare") continue;
    const domain = registrableDomain(o.origin);
    if (!domain) continue;
    const host = new URL(o.origin).hostname.toLowerCase();
    byDomain.set(domain, [...new Set([...(byDomain.get(domain) ?? []), host])]);
  }
  const out: TlsExpiry = { read_at: now.toISOString(), hosts: [], failed: [] };
  for (const [domain, hosts] of [...byDomain].sort(([a], [b]) => a.localeCompare(b))) {
    try {
      const zones = (await cfGetAll(fetchImpl, credentials.token, `${CF_API}/zones?name=${encodeURIComponent(domain)}`, `zone ${domain}`, 5)) as Array<{ id?: unknown }>;
      const id = zones.find((z) => typeof z.id === "string")?.id as string | undefined;
      if (!id) throw new Error(`no zone named ${domain} in this account`);
      const packs = (await cfGetAll(fetchImpl, credentials.token, `${CF_API}/zones/${id}/ssl/certificate_packs?status=all`, `certificate packs of ${domain}`, 50)) as Pack[];
      for (const host of hosts) {
        const expires = hostExpiry(packs, host);
        if (expires) out.hosts.push({ host, expires });
        else out.failed.push({ host, error: "no active certificate pack covers it" });
      }
    } catch (err) {
      for (const host of hosts) out.failed.push({ host, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
    }
  }
  return out;
}

/** The alerts the stored dates stand behind now: 14 days out and 3 days out, each once per
 *  certificate date. */
export function tlsAlerts(read: TlsExpiry | null, now: Date): Array<{ key: string; title: string; body: string }> {
  const out: Array<{ key: string; title: string; body: string }> = [];
  for (const { host, expires } of read?.hosts ?? []) {
    const days = Math.floor((Date.parse(expires) - now.getTime()) / DAY_MS);
    if (days > EARLY_DAYS) continue;
    const late = days <= LATE_DAYS;
    out.push({
      key: `tls-${late ? "3d" : "14d"}:${host}:${expires}`,
      title: days < 0 ? `${host}'s TLS certificate has expired` : `${host}'s TLS certificate expires in ${days} days`,
      body: `Cloudflare's certificate packs say it expires at ${expires} (read ${read?.read_at}). Cloudflare renews its own certificates; one this close means renewal is stuck: check the zone's Edge Certificates.`,
    });
  }
  return out;
}

export async function readStoredTls(env: Pick<Env, "APP_KV">): Promise<TlsExpiry | null> {
  return (await env.APP_KV.get(TLS_EXPIRY_KEY, "json")) as TlsExpiry | null;
}
