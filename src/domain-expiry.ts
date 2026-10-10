import type { Finding } from "./watcher";

// DOMAIN REGISTRATION EXPIRY, BY RDAP (job_5ac1139641e0, design-portal-insight.md section 5,
// pulled forward by Dustin on 2026-10-07: dustinedwards.info expires 2026-12-27, and
// auto-renew being on is no reason to go without the alert).
//
// The domains are the registrable names of the configured sites' origins (ops_sites), so
// nothing here is a list in code. Hosting suffixes a site borrows (workers.dev and the
// like) are not ours to renew and are left out.
//
// RDAP (RFC 9224 bootstrap, RFC 9083 responses): the IANA bootstrap maps a TLD to its
// registry's RDAP base; `{base}domain/{name}` answers with an `expiration` event. Both are
// public and need no key. The bootstrap is kept a week and each domain's answer a day, in
// KV, so a half-hourly watcher pass makes about one RDAP call per domain per day.
//
// A finding at EARLY_DAYS before expiry, and a second, new fingerprint at LATE_DAYS, so the
// last week posts again even if the first finding was dismissed. A domain whose expiry
// could not be read is not a finding (it says nothing about the domain); the check then
// counts as not run, so an open finding is not cleared by a read that failed.

export const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const BOOTSTRAP_KEY = "rdap:bootstrap:v1";
const BOOTSTRAP_TTL_SECONDS = 7 * 86_400;
export const expiryKey = (domain: string) => `rdap:expiry:v1:${domain}`;
const EXPIRY_TTL_SECONDS = 86_400;
const EARLY_DAYS = 30;
const LATE_DAYS = 7;
const DAY_MS = 86_400_000;
const FETCH_TIMEOUT_MS = 8000;

// Suffixes a site may sit under that are a host's, not a registration of ours.
const HOSTING_SUFFIXES = ["workers.dev", "pages.dev", "vercel.app", "netlify.app", "github.io"];

/** The registrable domain of a site origin, or null for a hosting suffix or an IP. The
 *  portfolio's TLDs are all single-label (.info, .app, .com, .org, .dev), so the last two
 *  labels are the registration; a multi-label public suffix would need the PSL. */
export function registrableDomain(origin: string): string | null {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (/^[\d.]+$/.test(host) || host.includes(":")) return null;
  if (HOSTING_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return null;
  const labels = host.split(".").filter(Boolean);
  return labels.length >= 2 ? labels.slice(-2).join(".") : null;
}

/** The RDAP base for a domain's TLD from the IANA bootstrap, or null. */
export function rdapBase(bootstrap: unknown, domain: string): string | null {
  const tld = domain.split(".").pop() ?? "";
  const services = (bootstrap as { services?: unknown })?.services;
  if (!Array.isArray(services)) return null;
  for (const entry of services) {
    if (!Array.isArray(entry) || !Array.isArray(entry[0]) || !Array.isArray(entry[1])) continue;
    if ((entry[0] as unknown[]).some((t) => typeof t === "string" && t.toLowerCase() === tld)) {
      const url = (entry[1] as unknown[]).find((u): u is string => typeof u === "string" && u.startsWith("https://"));
      if (url) return url.endsWith("/") ? url : `${url}/`;
    }
  }
  return null;
}

/** The `expiration` event's date from an RDAP domain answer, ISO, or null. */
export function expirationOf(rdap: unknown): string | null {
  const events = (rdap as { events?: unknown })?.events;
  if (!Array.isArray(events)) return null;
  for (const e of events) {
    const ev = e as { eventAction?: unknown; eventDate?: unknown };
    if (ev.eventAction === "expiration" && typeof ev.eventDate === "string" && Number.isFinite(Date.parse(ev.eventDate))) return new Date(ev.eventDate).toISOString();
  }
  return null;
}

/** The findings for domains whose expiry is known. */
export function expiryFindings(expiries: ReadonlyArray<{ domain: string; expires: string }>, now: Date): Finding[] {
  const out: Finding[] = [];
  for (const { domain, expires } of expiries) {
    const days = Math.floor((Date.parse(expires) - now.getTime()) / DAY_MS);
    if (days > EARLY_DAYS) continue;
    const late = days <= LATE_DAYS;
    const fingerprint = `domain-expiry-${late ? "7d" : "30d"}-${domain.replace(/[^a-z0-9]+/g, "-")}`;
    const headline = days < 0 ? `${domain}'s registration expired ${-days} days ago` : `${domain}'s registration expires in ${days} days`;
    const evidence = [`RDAP expiration ${expires}`, `read ${now.toISOString()}`];
    out.push({
      fingerprint,
      namespace: "capsid",
      title: `Watcher: ${headline} [${fingerprint}]`,
      body: [
        `The registry's RDAP record says ${domain} expires at ${expires}. Renew it, or confirm auto-renew has run, then fail this job saying so; the finding clears once RDAP shows the new date.`,
        "",
        "## Evidence",
        "",
        ...evidence.map((line) => `- ${line}`),
      ].join("\n"),
      evidence,
    });
  }
  return out;
}

type Cached = { expires: string; read_at: string };

async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const resp = await fetchImpl(url, { headers: { Accept: "application/rdap+json, application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`${url} answered ${resp.status}`);
  return resp.json();
}

/**
 * Each domain's expiry, from KV when read in the last day, otherwise from RDAP. Returns
 * the expiries it has and the domains it could not read, with why.
 */
export async function readExpiries(
  kv: KVNamespace,
  domains: readonly string[],
  fetchImpl: typeof fetch,
  now: Date
): Promise<{ expiries: Array<{ domain: string; expires: string }>; failed: Array<{ domain: string; error: string }> }> {
  const expiries: Array<{ domain: string; expires: string }> = [];
  const failed: Array<{ domain: string; error: string }> = [];
  let bootstrap: unknown = null;
  for (const domain of domains) {
    const cached = (await kv.get(expiryKey(domain), "json")) as Cached | null;
    if (cached?.expires) {
      expiries.push({ domain, expires: cached.expires });
      continue;
    }
    try {
      if (bootstrap === null) {
        bootstrap = await kv.get(BOOTSTRAP_KEY, "json");
        if (!bootstrap) {
          bootstrap = await fetchJson(fetchImpl, BOOTSTRAP_URL);
          await kv.put(BOOTSTRAP_KEY, JSON.stringify(bootstrap), { expirationTtl: BOOTSTRAP_TTL_SECONDS });
        }
      }
      const base = rdapBase(bootstrap, domain);
      if (!base) throw new Error(`the IANA bootstrap names no RDAP server for .${domain.split(".").pop()}`);
      const expires = expirationOf(await fetchJson(fetchImpl, `${base}domain/${encodeURIComponent(domain)}`));
      if (!expires) throw new Error("the RDAP answer has no expiration event");
      await kv.put(expiryKey(domain), JSON.stringify({ expires, read_at: now.toISOString() } satisfies Cached), { expirationTtl: EXPIRY_TTL_SECONDS });
      expiries.push({ domain, expires });
    } catch (err) {
      failed.push({ domain, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { expiries, failed };
}
