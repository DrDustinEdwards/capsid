// Verifies the ID token Cloudflare Access for SaaS (OIDC) returns at Capsid's login
// callback (capsid/research/design-capsid-access-login.md; decided 2026-09-27).
//
// Measured 2026-09-27 from the Capsid SaaS app's discovery document: the issuer is
// https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>, the keys are
// at <issuer>/jwks, and ID tokens are RS256. Checked here: RS256 only, the key matched
// by kid (refetched once on an unknown kid, which is how a rotation is picked up), the
// signature, iss equal to the issuer, aud holding the client id, exp and nbf, the nonce
// this sign-in sent, email_verified not false, and an email present. Anything else is a
// refusal with a named reason.
//
// Adapted from the console verifier in the closed PR #183 (f3edf49), which checked
// Access's Cf-Access-Jwt-Assertion against the team certs endpoint instead.

const KEYS_TTL_MS = 60 * 60 * 1000;

export interface Jwk {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  alg?: string;
}

export type KeysFetcher = (url: string) => Promise<{ keys: Jwk[] }>;

export interface IdTokenCheck {
  issuer: string;
  clientId: string;
  jwksUrl: string;
  nonce: string;
}

export type IdTokenVerdict = { ok: true; email: string } | { ok: false; reason: string };

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

const keysCache = new Map<string, { keys: Jwk[]; at: number }>();

export function clearIdTokenKeysCache(): void {
  keysCache.clear();
}

async function keyFor(kid: string, url: string, fetchKeys: KeysFetcher, now: number): Promise<Jwk | null> {
  const cached = keysCache.get(url);
  const hit = cached && now - cached.at < KEYS_TTL_MS ? cached.keys.find((k) => k.kid === kid) : undefined;
  if (hit) return hit;
  const fetched = await fetchKeys(url);
  if (!fetched || !Array.isArray(fetched.keys)) throw new Error("the Access JWKS endpoint returned no keys array");
  keysCache.set(url, { keys: fetched.keys, at: now });
  return fetched.keys.find((k) => k.kid === kid) ?? null;
}

async function fetchKeysLive(url: string): Promise<{ keys: Jwk[] }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as { keys: Jwk[] };
}

export async function verifyIdToken(token: string, check: IdTokenCheck, now: Date, fetchKeys: KeysFetcher = fetchKeysLive): Promise<IdTokenVerdict> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "the ID token is not a JWT" };
  const header = base64UrlJson(parts[0]);
  const payload = base64UrlJson(parts[1]);
  if (!header || !payload) return { ok: false, reason: "the ID token does not decode" };
  if (header.alg !== "RS256") return { ok: false, reason: `the ID token's alg is ${String(header.alg)}, not RS256` };
  if (typeof header.kid !== "string" || header.kid === "") return { ok: false, reason: "the ID token names no kid" };

  let jwk: Jwk | null;
  try {
    jwk = await keyFor(header.kid, check.jwksUrl, fetchKeys, now.getTime());
  } catch (err) {
    return { ok: false, reason: `the Access keys could not be read: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}` };
  }
  if (!jwk) return { ok: false, reason: `no Access key has kid ${header.kid}` };
  let verified = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch (err) {
    return { ok: false, reason: `the signature could not be checked: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}` };
  }
  if (!verified) return { ok: false, reason: "the ID token's signature does not verify" };

  if (payload.iss !== check.issuer) return { ok: false, reason: `iss is ${String(payload.iss)}, not this application's issuer` };
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(check.clientId)) return { ok: false, reason: "aud does not hold this application's client id" };
  const seconds = Math.floor(now.getTime() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= seconds) return { ok: false, reason: "the ID token has expired or carries no exp" };
  if (typeof payload.nbf === "number" && payload.nbf > seconds) return { ok: false, reason: "the ID token is not valid yet (nbf)" };
  if (payload.nonce !== check.nonce) return { ok: false, reason: "the ID token's nonce is not this sign-in's" };
  if (payload.email_verified === false) return { ok: false, reason: "the ID token says the email is not verified" };
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  if (!email) return { ok: false, reason: "the ID token carries no email" };
  return { ok: true, email };
}
