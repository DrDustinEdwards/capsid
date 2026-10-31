/**
 * The plain responses Capsid answers with: text and JSON, never cached. One copy, so a header
 * added here reaches every answer. A response with its own caching (public-data.ts) or its own
 * content type builds its own Response.
 */

import type { limit } from "@dustinedwards/site-runtime/rate-limit";

const TEXT = "text/plain;charset=utf-8";
const JSON_TYPE = "application/json";

/** A plain-text answer, never cached. `extra` adds or overrides headers. */
export function textResponse(message: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(message, { status, headers: { "Content-Type": TEXT, "Cache-Control": "no-store", ...extra } });
}

/** A JSON answer, never cached. `extra` adds or overrides headers. */
export function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": JSON_TYPE, "Cache-Control": "no-store", ...extra } });
}

/**
 * The RATE_LIMITER binding as site-runtime's limiter calls it: its RateLimiter's own method on
 * the stub, which the generated binding type does not name.
 */
export function rateLimiter(env: { RATE_LIMITER?: DurableObjectNamespace }): NonNullable<Parameters<typeof limit>[0]> {
  return env.RATE_LIMITER as unknown as NonNullable<Parameters<typeof limit>[0]>;
}
