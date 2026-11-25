// The tool-call log's signing key (site-runtime audit-log 0.85, AUDIT_SIGNING_KEY), derived from
// COOKIE_ENCRYPTION_KEY under its own label, as the Portal's idle key is (portal-auth.ts), so
// Capsid holds no second secret.
import type { Env } from "./env";

// Without COOKIE_ENCRYPTION_KEY there is no key, and audit-log refuses to write rather than sign
// under a known string.
export function withAuditKey<E extends Pick<Env, "COOKIE_ENCRYPTION_KEY">>(
  env: E,
): E & { AUDIT_SIGNING_KEY?: string } {
  return env.COOKIE_ENCRYPTION_KEY
    ? { ...env, AUDIT_SIGNING_KEY: `audit-signing-key.${env.COOKIE_ENCRYPTION_KEY}` }
    : env;
}
