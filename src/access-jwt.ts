import type { Env } from "./env";

// Cloudflare Access in front of the console, checked again in the Worker
// (capsid/decisions.md, 2026-09-27, "shared functions across the sites", point 7).
//
// The Access application covers /console on capsid.dustinedwards.info only: Access
// protects a path only on a hostname in a zone the account owns, and workers.dev is
// not one. The Worker therefore refuses every console route without a valid Access
// token, which is also what closes /console on the workers.dev hostname, where no
// Access runs. /mcp, /ops/*, /health, /.well-known/* and the OAuth endpoints never
// pass through here. This is in addition to the console's own GitHub admin check.
//
// Token rules, from developers.cloudflare.com/cloudflare-one/access-controls/
// applications/http-apps/authorization-cookie/validating-json/ (read 2026-09-27): the
// Cf-Access-Jwt-Assertion header, RS256, keys from <team domain>/cdn-cgi/access/certs
// matched by kid (they rotate every six weeks), iss equal to the team domain, and aud
// holding the application's AUD tag. exp and nbf are checked here as well.

export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";
const CERTS_TTL_MS = 60 * 60 * 1000;

export interface AccessConfig {
  // https://<team>.cloudflareaccess.com, no trailing slash.
  teamDomain: string;
  aud: string;
}

export interface Jwk {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  alg?: string;
}

export type CertsFetcher = (url: string) => Promise<{ keys: Jwk[] }>;

export type AccessVerdict = { ok: true; email: string | null } | { ok: false; reason: string };

const decoder = new TextDecoder();

function base64UrlBytes(part: string): Uint8Array {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function base64UrlJson(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(decoder.decode(base64UrlBytes(part)));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// One isolate-level cache per certs URL. A kid it does not hold is fetched again once,
// which is how a rotation is picked up before the TTL runs out.
const certsCache = new Map<string, { keys: Jwk[]; at: number }>();

export function clearAccessCertsCache(): void {
  certsCache.clear();
}

async function keyFor(kid: string, url: string, fetchCerts: CertsFetcher, now: number): Promise<Jwk | null> {
  const cached = certsCache.get(url);
  const fresh = cached && now - cached.at < CERTS_TTL_MS ? cached : null;
  const hit = fresh?.keys.find((k) => k.kid === kid);
  if (hit) return hit;
  const fetched = await fetchCerts(url);
  if (!fetched || !Array.isArray(fetched.keys)) throw new Error("the Access certs endpoint returned no keys array");
  certsCache.set(url, { keys: fetched.keys, at: now });
  return fetched.keys.find((k) => k.kid === kid) ?? null;
}

export async function verifyAccessJwt(
  token: string | null,
  config: AccessConfig,
  now: Date,
  fetchCerts: CertsFetcher
): Promise<AccessVerdict> {
  if (!token) return { ok: false, reason: `no ${ACCESS_JWT_HEADER} header` };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "the token is not a JWT" };
  const header = base64UrlJson(parts[0]);
  const payload = base64UrlJson(parts[1]);
  if (!header || !payload) return { ok: false, reason: "the token does not decode" };
  if (header.alg !== "RS256") return { ok: false, reason: `the token's alg is ${String(header.alg)}, not RS256` };
  if (typeof header.kid !== "string" || header.kid === "") return { ok: false, reason: "the token names no kid" };

  let jwk: Jwk | null;
  try {
    jwk = await keyFor(header.kid, `${config.teamDomain}/cdn-cgi/access/certs`, fetchCerts, now.getTime());
  } catch (err) {
    // Fails closed: without the keys nothing can be verified.
    return { ok: false, reason: `the Access certs could not be read: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}` };
  }
  if (!jwk) return { ok: false, reason: `no Access key has kid ${header.kid}` };
  let verified = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch (err) {
    return { ok: false, reason: `the signature could not be checked: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}` };
  }
  if (!verified) return { ok: false, reason: "the signature does not verify" };

  if (payload.iss !== config.teamDomain) return { ok: false, reason: `iss is ${String(payload.iss)}, not the team domain` };
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(config.aud)) return { ok: false, reason: "aud does not hold this application's AUD tag" };
  const seconds = Math.floor(now.getTime() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= seconds) return { ok: false, reason: "the token has expired or carries no exp" };
  if (typeof payload.nbf === "number" && payload.nbf > seconds) return { ok: false, reason: "the token is not valid yet (nbf)" };
  return { ok: true, email: typeof payload.email === "string" ? payload.email : null };
}

async function fetchCertsLive(url: string): Promise<{ keys: Jwk[] }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as { keys: Jwk[] };
}

// The router's wrapper for every console route: the handler runs only after the gate
// admits the request.
export async function throughAccess(request: Request, env: Env, handler: () => Promise<Response>): Promise<Response> {
  return (await accessGate(request, env)) ?? handler();
}

export function isConsolePath(pathname: string): boolean {
  return pathname === "/console" || pathname === "/console.json" || pathname.startsWith("/console/");
}

// Null when the request carries a valid Access token for the console, otherwise the
// refusal. Unconfigured is a refusal too: a console that silently skipped the check
// when a variable went missing would be the check switched off.
export async function accessGate(request: Request, env: Env, now: Date = new Date(), fetchCerts: CertsFetcher = fetchCertsLive): Promise<Response | null> {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.replace(/\/+$/, "");
  const aud = env.ACCESS_AUD;
  if (!teamDomain || !aud) {
    console.error("CONSOLE_ACCESS_UNCONFIGURED ACCESS_TEAM_DOMAIN or ACCESS_AUD is unset; the console is refused");
    return new Response("the console's Cloudflare Access check is not configured (ACCESS_TEAM_DOMAIN, ACCESS_AUD), so the console is closed", {
      status: 503,
      headers: { "Content-Type": "text/plain;charset=utf-8" },
    });
  }
  const verdict = await verifyAccessJwt(request.headers.get(ACCESS_JWT_HEADER), { teamDomain, aud }, now, fetchCerts);
  if (verdict.ok) return null;
  console.error(`CONSOLE_ACCESS_REFUSED ${verdict.reason}`);
  return new Response(`the console is served only through Cloudflare Access: ${verdict.reason}`, {
    status: 403,
    headers: { "Content-Type": "text/plain;charset=utf-8" },
  });
}
