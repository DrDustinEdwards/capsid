import {
  adminEmails,
  isAdminEmail as siteRuntimeIsAdminEmail,
} from "@dustinedwards/site-runtime/access";
import { toHex } from "@dustinedwards/site-runtime/encoding";
import { hostCookie } from "@dustinedwards/site-runtime/headers";

// HMAC-SHA256, hex. The one definition.
export async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return toHex(sig);
}

// A cookie's name with the prefix its scope earns. Every Capsid cookie is Secure with no Domain, so one scoped to the
// whole host (Path=/) is __Host-, which no sibling subdomain can set or shadow, and one scoped to a path is __Secure-.
function cookieName(name: string, path: string): string {
  return `${path === "/" ? "__Host-" : "__Secure-"}${name}`;
}

// A Capsid cookie's Set-Cookie, HttpOnly and SameSite=Lax: site-runtime's hostCookie for one scoped to the whole host,
// and the same attributes under __Secure- for one scoped to a path (the Portal under /portal on the MCP host), which
// hostCookie, being Path=/ only, cannot write. `maxAge: 0` with an empty value ends it.
export function capsidCookie(name: string, value: string, path: string, maxAge: number): string {
  if (path === "/") return hostCookie(name, value, { maxAge });
  return `${cookieName(name, path)}=${value}; Path=${path}; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

// Cookie lookup, once, for the consent flow and the Portal session: the prefixed name first, then the bare name the
// cookies had before the prefixes, read for one release so live sessions survive. REMOVAL: the release after.
export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  const jar = new Map<string, string>();
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!jar.has(key)) jar.set(key, part.slice(eq + 1).trim());
  }
  return jar.get(`__Host-${name}`) ?? jar.get(`__Secure-${name}`) ?? jar.get(name) ?? null;
}

type AdminEnv = { ADMIN_EMAIL?: string; CO_OWNER_EMAILS?: string };

// The admin, by the email Access verified: ADMIN_EMAIL, the main admin, or an entry of
// CO_OWNER_EMAILS (comma separated). The roster is site-runtime's (./access, the one admin model
// of every site): addresses are trimmed and compared in lower case, empty entries are skipped.
// An unset ADMIN_EMAIL admits nobody, a co-owner included, so losing the main admin's secret
// closes both logins. Both secrets are set only in Cloudflare: nothing inside Capsid can change
// who is admin. Async so every call site keeps its await (test/source-conventions.test.ts).
export async function isAdminEmail(env: AdminEnv, email: string): Promise<boolean> {
  return siteRuntimeIsAdminEmail(env, email);
}

// The admins as a list: ADMIN_EMAIL and every CO_OWNER_EMAILS entry, and nobody while
// ADMIN_EMAIL is unset. The Access drift check reads it hashed (src/index.ts, ADMIN_LIST_PATH).
export function adminEmailList(env: AdminEnv): string[] {
  return adminEmails(env);
}

// A grant's props on /mcp, checked on every request: only a grant whose email Access
// verified as an admin (isAdminEmail) passes. A grant from before the move to Access
// carries a GitHub login and no email, and fails here, so its client signs in again once.
export async function adminGrantEmail(env: AdminEnv, props: unknown): Promise<string | null> {
  const email =
    props && typeof props === "object" ? (props as { email?: unknown }).email : undefined;
  return typeof email === "string" && (await isAdminEmail(env, email)) ? email : null;
}
