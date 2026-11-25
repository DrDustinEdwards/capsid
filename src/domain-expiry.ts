import type { Finding } from "./watcher-detect";
import { DAY_MS } from "./time";
import { callSignal } from "./call-signal";
import { parse } from "tldts";

import { errorMessage } from "@dustinedwards/site-runtime/log";
// A finding at EARLY_DAYS before expiry, and a second, new fingerprint at LATE_DAYS, so the last
// week posts again even if the first was dismissed. A domain whose expiry could not be read is not
// a finding, and the check counts as not run, so a failed read does not clear an open finding.

export const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const BOOTSTRAP_KEY = "rdap:bootstrap:v1";
const BOOTSTRAP_TTL_SECONDS = 7 * 86_400;
export const expiryKey = (domain: string) => `rdap:expiry:v1:${domain}`;
const EXPIRY_TTL_SECONDS = 86_400;
const EARLY_DAYS = 30;
const LATE_DAYS = 7;
const FETCH_TIMEOUT_MS = 8000;

/**
 * It reads the Public Suffix List (tldts), so a name under a multi-label suffix such as co.uk
 * keeps its third label, and a host under a suffix in the list's private section (workers.dev,
 * pages.dev, vercel.app, github.io and the like) is a host's, not a registration of ours.
 */
export function registrableDomain(origin: string): string | null {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.includes(":") || host.startsWith("[")) return null;
  const parsed = parse(host, { allowPrivateDomains: true });
  if (parsed.isIp || parsed.isPrivate) return null;
  return parsed.domain;
}

export function rdapBase(bootstrap: unknown, domain: string): string | null {
  const tld = domain.split(".").pop() ?? "";
  const services = (bootstrap as { services?: unknown })?.services;
  if (!Array.isArray(services)) return null;
  for (const entry of services) {
    if (!Array.isArray(entry) || !Array.isArray(entry[0]) || !Array.isArray(entry[1])) continue;
    if ((entry[0] as unknown[]).some((t) => typeof t === "string" && t.toLowerCase() === tld)) {
      const url = (entry[1] as unknown[]).find(
        (u): u is string => typeof u === "string" && u.startsWith("https://"),
      );
      if (url) return url.endsWith("/") ? url : `${url}/`;
    }
  }
  return null;
}

export function expirationOf(rdap: unknown): string | null {
  const events = (rdap as { events?: unknown })?.events;
  if (!Array.isArray(events)) return null;
  for (const e of events) {
    const ev = e as { eventAction?: unknown; eventDate?: unknown };
    if (
      ev.eventAction === "expiration" &&
      typeof ev.eventDate === "string" &&
      Number.isFinite(Date.parse(ev.eventDate))
    )
      return new Date(ev.eventDate).toISOString();
  }
  return null;
}

export function expiryFindings(
  expiries: ReadonlyArray<{ domain: string; expires: string }>,
  now: Date,
): Finding[] {
  const out: Finding[] = [];
  for (const { domain, expires } of expiries) {
    const days = Math.floor((Date.parse(expires) - now.getTime()) / DAY_MS);
    if (days > EARLY_DAYS) continue;
    const late = days <= LATE_DAYS;
    const fingerprint = `domain-expiry-${late ? "7d" : "30d"}-${domain.replace(/[^a-z0-9]+/g, "-")}`;
    const headline =
      days < 0
        ? `${domain}'s registration expired ${-days} days ago`
        : `${domain}'s registration expires in ${days} days`;
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

/**
 * The pushes the last read stands behind (U5): each domain once at 30 days out and once at 7,
 * keyed by the date, so a renewal that moves it clears the alert and a new near date alerts again.
 * The findings above stay; this is the phone line beside them.
 */
export function domainAlerts(
  read:
    | { read_at: string; domains: ReadonlyArray<{ domain: string; expires: string }> }
    | null
    | undefined,
  now: Date,
): Array<{ key: string; title: string; body: string }> {
  const out: Array<{ key: string; title: string; body: string }> = [];
  for (const { domain, expires } of read?.domains ?? []) {
    const days = Math.floor((Date.parse(expires) - now.getTime()) / DAY_MS);
    if (days > EARLY_DAYS) continue;
    out.push({
      key: `domain-${days <= LATE_DAYS ? "7d" : "30d"}:${domain}:${expires}`,
      title:
        days < 0
          ? `${domain}'s registration has expired`
          : `${domain}'s registration expires in ${days} days`,
      body: `RDAP says it expires at ${expires} (read ${read?.read_at}). Renew it, or confirm auto-renew has run.`,
    });
  }
  return out;
}

type Cached = { expires: string; read_at: string };

async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const resp = await fetchImpl(url, {
    headers: { Accept: "application/rdap+json, application/json" },
    signal: callSignal(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`${url} answered ${resp.status}`);
  return resp.json();
}

/**
 * Each domain's expiry, from KV when read in the last day, otherwise from RDAP. Returns the
 * expiries it has and the domains it could not read, with why.
 */
export async function readExpiries(
  kv: KVNamespace,
  domains: readonly string[],
  fetchImpl: typeof fetch,
  now: Date,
): Promise<{
  expiries: Array<{ domain: string; expires: string }>;
  failed: Array<{ domain: string; error: string }>;
}> {
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
          await kv.put(BOOTSTRAP_KEY, JSON.stringify(bootstrap), {
            expirationTtl: BOOTSTRAP_TTL_SECONDS,
          });
        }
      }
      const base = rdapBase(bootstrap, domain);
      if (!base)
        throw new Error(`the IANA bootstrap names no RDAP server for .${domain.split(".").pop()}`);
      const expires = expirationOf(
        await fetchJson(fetchImpl, `${base}domain/${encodeURIComponent(domain)}`),
      );
      if (!expires) throw new Error("the RDAP answer has no expiration event");
      await kv.put(
        expiryKey(domain),
        JSON.stringify({ expires, read_at: now.toISOString() } satisfies Cached),
        { expirationTtl: EXPIRY_TTL_SECONDS },
      );
      expiries.push({ domain, expires });
    } catch (err) {
      failed.push({ domain, error: errorMessage(err) });
    }
  }
  return { expiries, failed };
}
