export interface RateLimitPolicy {
  // Distinct per endpoint so one path cannot spend another's budget.
  prefix: string;
  perHour: number;
  perDay: number;
  label: string;
  // What an unreadable counter means, decided per endpoint. Allowing on every KV
  // failure gives one answer to two different questions, so the judgement is stated
  // on the policy, next to the endpoint it is about, not in the limiter.
  onUnavailable: "allow" | "refuse";
}

export const MAX_PER_HOUR = 30;
export const MAX_PER_DAY = 100;

// Fail open. /register is how a client is enrolled, and only the owner enrolls one.
// Refusing registrations during a KV outage would lock the owner out of reconnecting
// at the moment the platform is already unwell, and a few extra registrations cost a
// few KV rows.
export const REGISTRATION_LIMIT: RateLimitPolicy = {
  prefix: "dcr:rate:",
  perHour: MAX_PER_HOUR,
  perDay: MAX_PER_DAY,
  label: "DCR",
  onUnavailable: "allow",
};

// At most one non-loopback redirect_uri per registered client. Loopback is exempt
// so a native client can cycle ports.
export function isLoopbackRedirect(uri: string): boolean {
  try {
    const host = new URL(uri).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    // Non-loopback, so a malformed entry cannot slip the cap.
    return false;
  }
}

export interface DcrRefusal {
  code: string;
  status: number;
  description: string;
}

export function dcrRedirectRefusal(clientMetadata: unknown): DcrRefusal | null {
  const raw = (clientMetadata as { redirect_uris?: unknown } | null | undefined)?.redirect_uris;
  const uris = Array.isArray(raw) ? raw.filter((u): u is string => typeof u === "string") : [];
  const nonLoopback = uris.filter((u) => !isLoopbackRedirect(u));
  if (nonLoopback.length > 1) {
    return {
      code: "invalid_redirect_uri",
      status: 400,
      description: `A client may register at most one non-loopback redirect_uri; this one declared ${nonLoopback.length}. Register a single redirect, or use loopback addresses for a native client.`,
    };
  }
  return null;
}

export const MAX_REPORTS_PER_HOUR = 300;
export const MAX_REPORTS_PER_DAY = 1000;

// Fail closed: /csp-report is unauthenticated and every accepted report is an R2
// object, so failing open would give anyone an unbounded write path during an outage.
// A dropped report costs one browser diagnostic.
export const CSP_REPORT_LIMIT: RateLimitPolicy = {
  prefix: "csp:rate:",
  perHour: MAX_REPORTS_PER_HOUR,
  perDay: MAX_REPORTS_PER_DAY,
  label: "CSP_REPORT",
  onUnavailable: "refuse",
};

// A refusal is a spent budget or an unreadable one ("unavailable"), and every reader
// must say which rather than print a count that was never measured.
export type RateRefusal =
  | { allowed: false; window: "hour" | "day"; count: number; limit: number }
  | { allowed: false; window: "unavailable"; detail: string };

export type RateVerdict = { allowed: true } | RateRefusal;

function windowKeys(prefix: string, ip: string, now: Date): { hour: string; day: string } {
  const iso = now.toISOString();
  return { hour: `${prefix}h:${ip}:${iso.slice(0, 13)}`, day: `${prefix}d:${ip}:${iso.slice(0, 10)}` };
}

// Every path that cannot read or advance a counter ends here, and the policy's
// `onUnavailable` decides. The log line is the only output on the allow side.
function unavailable(policy: RateLimitPolicy, ip: string, detail: string): RateVerdict {
  console.error(`${policy.label}_RATE_LIMIT_UNAVAILABLE ${detail} for ${ip}, ${policy.onUnavailable === "allow" ? "allowing" : "refusing"}`);
  return policy.onUnavailable === "allow" ? { allowed: true } : { allowed: false, window: "unavailable", detail };
}

export async function checkRate(
  kv: KVNamespace | undefined,
  ip: string,
  now: Date,
  policy: RateLimitPolicy
): Promise<RateVerdict> {
  // A deploy missing APP_KV, named apart from a read failure.
  if (!kv) return unavailable(policy, ip, "no KV binding");

  const keys = windowKeys(policy.prefix, ip, now);
  let hourCount: number;
  let dayCount: number;
  try {
    const [h, d] = await Promise.all([kv.get(keys.hour), kv.get(keys.day)]);
    hourCount = Number(h ?? 0);
    dayCount = Number(d ?? 0);
    if (!Number.isFinite(hourCount) || !Number.isFinite(dayCount)) throw new Error("non-numeric counter");
  } catch (err) {
    return unavailable(policy, ip, `read failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Refuse before the write, or retrying extends the block.
  if (hourCount >= policy.perHour) return { allowed: false, window: "hour", count: hourCount, limit: policy.perHour };
  if (dayCount >= policy.perDay) return { allowed: false, window: "day", count: dayCount, limit: policy.perDay };

  try {
    await Promise.all([
      kv.put(keys.hour, String(hourCount + 1), { expirationTtl: 3600 }),
      kv.put(keys.day, String(dayCount + 1), { expirationTtl: 86_400 }),
    ]);
  } catch (err) {
    // A counter that does not advance is no ceiling, so the policy decides.
    return unavailable(policy, ip, `write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { allowed: true };
}

export function callerIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

// 429, not 204: a dropped report must not look stored. 503 when the rate could not
// be measured, which is a server problem.
export function rateLimitedResponse(verdict: RateRefusal): Response {
  if (verdict.window === "unavailable") {
    return new Response(`rate limiting is unavailable, so reports are refused: ${verdict.detail}`, {
      status: 503,
      headers: { "Content-Type": "text/plain;charset=utf-8", "Retry-After": "60" },
    });
  }
  return new Response(`too many reports: ${verdict.count} in the last ${verdict.window}, limit ${verdict.limit}`, {
    status: 429,
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Retry-After": verdict.window === "hour" ? "3600" : "86400",
    },
  });
}
