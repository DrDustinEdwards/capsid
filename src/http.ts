/** The RATE_LIMITER binding adapter. Plain responses come from site-runtime ./http. */

import type { limit } from "@dustinedwards/site-runtime/rate-limit";

/**
 * The RATE_LIMITER binding as site-runtime's limiter calls it: its RateLimiter's own method on
 * the stub, which the generated binding type does not name.
 */
export function rateLimiter(env: {
  RATE_LIMITER?: DurableObjectNamespace;
}): NonNullable<Parameters<typeof limit>[0]> {
  return env.RATE_LIMITER as unknown as NonNullable<Parameters<typeof limit>[0]>;
}

/** The X-Capsid-Warning header for a warning, cut to the printable ASCII a header can carry; none without one. */
export function warningHeaders(warning: string | null | undefined): Record<string, string> {
  return warning ? { "X-Capsid-Warning": warning.replace(/[^\x20-\x7e]+/g, " ") } : {};
}
