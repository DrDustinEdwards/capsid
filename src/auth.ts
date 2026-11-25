import { isAdminEmail } from "@dustinedwards/site-runtime/access";
import { hmacSha256Hex } from "@dustinedwards/site-runtime/encoding";
import { hostCookie } from "@dustinedwards/site-runtime/headers";
import type { Env } from "./env";

export function capsidCookie(name: string, value: string, path: string, maxAge: number): string {
  return hostCookie(name, value, { maxAge, path });
}

type AdminEnv = { ADMIN_EMAIL?: string; CO_OWNER_EMAILS?: string };

// The admin roster is site-runtime's (./access, the one admin model of every site): ADMIN_EMAIL,
// the main admin, and CO_OWNER_EMAILS (comma separated), trimmed and compared in lower case. An
// unset ADMIN_EMAIL admits nobody, a co-owner included, so losing the main admin's secret closes
// both logins.

export async function adminGrantEmail(env: AdminEnv, props: unknown): Promise<string | null> {
  const email =
    props && typeof props === "object" ? (props as { email?: unknown }).email : undefined;
  return typeof email === "string" && isAdminEmail(env, email) ? email : null;
}

// Fails closed: with no root secret there is nothing to sign with, and an empty key would sign
// with a value anybody knows.
export async function confirmKeys(
  env: Pick<Env, "COOKIE_ENCRYPTION_KEY">,
  label: string,
): Promise<string[]> {
  if (!env.COOKIE_ENCRYPTION_KEY)
    throw new Error("COOKIE_ENCRYPTION_KEY is unset, so no confirmation can be signed or checked");
  return [await hmacSha256Hex(env.COOKIE_ENCRYPTION_KEY, label)];
}
