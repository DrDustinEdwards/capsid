import { logEvent } from "@dustinedwards/site-runtime/log";

// Best-effort, not exact. Each check reads both KV counters, compares, then writes
// count + 1, with no compare-and-swap, so concurrent requests can read the same count
// and a burst can pass somewhat over perHour or perDay. KV is also eventually
// consistent across locations. A limit here bounds abuse in bulk; nothing may rely on
// it as an exact ceiling.
export interface RateLimitPolicy {
  // Distinct per endpoint so one path cannot spend another's budget.
  prefix: string;
  perHour: number;
  perDay: number;
  label: string;
  // What an unreadable counter means, decided per endpoint. Allowing on every KV
  // failure gives one answer to two different questions, so the judgment is stated
  // on the policy, next to the endpoint it is about, not in the limiter.
  onUnavailable: "allow" | "refuse";
}

export const MAX_REPORTS_PER_HOUR = 300;
export const MAX_REPORTS_PER_DAY = 1000;

// Fail closed: /csp-report is unauthenticated and every accepted report writes log
// lines, so failing open would let anyone fill the logs during an outage. A dropped
// report costs one browser diagnostic, and the browser still gets its 204.
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
  const event = `${policy.label}_RATE_LIMIT_UNAVAILABLE`;
  logEvent(event, {
    message: `${event} ${detail} for ${ip}, ${policy.onUnavailable === "allow" ? "allowing" : "refusing"}`,
  }, { level: "error" });
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
// be measured, which is a server problem. `noun` names what the endpoint counts.
export function rateLimitedResponse(verdict: RateRefusal, noun = "reports"): Response {
  if (verdict.window === "unavailable") {
    return new Response(`rate limiting is unavailable, so ${noun} are refused: ${verdict.detail}`, {
      status: 503,
      headers: { "Content-Type": "text/plain;charset=utf-8", "Retry-After": "60" },
    });
  }
  return new Response(`too many ${noun}: ${verdict.count} in the last ${verdict.window}, limit ${verdict.limit}`, {
    status: 429,
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Retry-After": verdict.window === "hour" ? "3600" : "86400",
    },
  });
}
