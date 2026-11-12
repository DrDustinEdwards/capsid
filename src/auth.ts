import { isAdminEmail } from "@dustinedwards/site-runtime/access";
import { hostCookie } from "@dustinedwards/site-runtime/headers";

// A Capsid cookie's Set-Cookie, HttpOnly and SameSite=Lax: site-runtime's hostCookie, which names a cookie scoped to
// the whole host (Path=/) __Host- and one scoped to a path (the Portal under /portal on the MCP host) __Secure-.
// `maxAge: 0` with an empty value ends it.
export function capsidCookie(name: string, value: string, path: string, maxAge: number): string {
  return hostCookie(name, value, { maxAge, path });
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

// The admin roster is site-runtime's (./access, the one admin model of every site): ADMIN_EMAIL,
// the main admin, and CO_OWNER_EMAILS (comma separated), trimmed and compared in lower case. An
// unset ADMIN_EMAIL admits nobody, a co-owner included, so losing the main admin's secret closes
// both logins. Both secrets are set only in Cloudflare: nothing inside Capsid can change who is
// admin.

// A grant's props on /mcp, checked on every request: only a grant whose email Access
// verified as an admin (isAdminEmail) passes. A grant from before the move to Access
// carries a GitHub login and no email, and fails here, so its client signs in again once.
export async function adminGrantEmail(env: AdminEnv, props: unknown): Promise<string | null> {
  const email =
    props && typeof props === "object" ? (props as { email?: unknown }).email : undefined;
  return typeof email === "string" && isAdminEmail(env, email) ? email : null;
}
