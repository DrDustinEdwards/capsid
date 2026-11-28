import type { limit } from "@dustinedwards/site-runtime/rate-limit";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function rateLimiter(env: {
  RATE_LIMITER?: DurableObjectNamespace;
}): NonNullable<Parameters<typeof limit>[0]> {
  return env.RATE_LIMITER as unknown as NonNullable<Parameters<typeof limit>[0]>;
}

/**
 * The X-Capsid-Warning header for a warning, cut to the printable ASCII a header can carry; none
 * without one.
 */
export function warningHeaders(warning: string | null | undefined): Record<string, string> {
  return warning ? { "X-Capsid-Warning": warning.replace(/[^\x20-\x7e]+/g, " ") } : {};
}
