import { safeEqual } from "@dustinedwards/site-runtime/compare";
import { sha256Hex, toHex } from "@dustinedwards/site-runtime/encoding";

// HMAC-SHA256, hex. The one definition.
export async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return toHex(sig);
}

// Cookie lookup, once, for the consent flow and the Portal session.
export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// OPERATOR_KEY_HASH: comma-separated sha256 hex. Plain = write, "ro:" = read.
// Revoke by removing a hash. A single unprefixed hash still parses as write.
type OperatorGrant = "write" | "read" | null;

// Fingerprint is 12 hex of the presented key's sha256, not the stored verifier.
export interface OperatorIdentity {
  grant: OperatorGrant;
  fingerprint: string | null;
}

/**
 * The token of an `Authorization: Bearer` header, or null. The scheme is case-insensitive
 * (RFC 6750 via RFC 9110), and a token is one run without whitespace, as in Carrel and
 * site-api; a header with anything after the token is refused.
 */
export function bearerToken(request: Request): string | null {
  const match = /^Bearer +(\S+) *$/i.exec(request.headers.get("Authorization") ?? "");
  return match ? match[1] : null;
}

export async function operatorIdentity(
  request: Request,
  env: { OPERATOR_KEY_HASH?: string }
): Promise<OperatorIdentity> {
  const token = bearerToken(request);
  if (!token || !env.OPERATOR_KEY_HASH) return { grant: null, fingerprint: null };
  const hash = await sha256Hex(token);
  for (const raw of env.OPERATOR_KEY_HASH.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const readonly = entry.startsWith("ro:");
    if (await safeEqual(readonly ? entry.slice(3) : entry, hash)) {
      return { grant: readonly ? "read" : "write", fingerprint: hash.slice(0, 12) };
    }
  }
  return { grant: null, fingerprint: null };
}

type AdminEnv = { ADMIN_EMAIL?: string; CO_OWNER_EMAILS?: string };

// The admin, by the email Access verified: ADMIN_EMAIL, the primary owner, or an entry
// of CO_OWNER_EMAILS (comma separated). Each entry is trimmed and compared exactly, with
// no case folding; empty entries are skipped. An unset ADMIN_EMAIL admits nobody, a
// co-owner included, so losing the primary owner's secret closes both logins. Both
// secrets are set only in Cloudflare: nothing inside Capsid can change who is admin.
export async function isAdminEmail(env: AdminEnv, email: string): Promise<boolean> {
  const admin = (env.ADMIN_EMAIL ?? "").trim();
  if (!admin) return false;
  const candidate = email.trim();
  let admitted = false;
  for (const raw of [admin, ...(env.CO_OWNER_EMAILS ?? "").split(",")]) {
    const entry = raw.trim();
    if (entry && (await safeEqual(candidate, entry))) admitted = true;
  }
  return admitted;
}

// A grant's props on /mcp, checked on every request: only a grant whose email Access
// verified as an admin (isAdminEmail) passes. A grant from before the move to Access
// carries a GitHub login and no email, and fails here, so its client signs in again once.
export async function adminGrantEmail(env: AdminEnv, props: unknown): Promise<string | null> {
  const email = props && typeof props === "object" ? (props as { email?: unknown }).email : undefined;
  return typeof email === "string" && (await isAdminEmail(env, email)) ? email : null;
}
