export interface RateLimitPolicy {
  // Distinct per endpoint so one path cannot spend another's budget.
  prefix: string;
  perHour: number;
  perDay: number;
  label: string;
  // WHAT AN UNREADABLE COUNTER MEANS HERE, per endpoint (audit 2026-09-16, defect 7).
  // Every KV failure returned `allowed` for both endpoints, which is one answer to
  // two different questions. Stated on the policy rather than decided in the limiter,
  // so the reasoning sits next to the endpoint it is a judgement about.
  onUnavailable: "allow" | "refuse";
}

export const MAX_PER_HOUR = 30;
export const MAX_PER_DAY = 100;

// FAIL OPEN, DELIBERATELY. /register is how a client is enrolled, and the only
// person who enrolls one here is the owner. A KV outage that refused registrations
// would lock Dustin out of reconnecting his own server at exactly the moment the
// platform is already unwell, and the cost of letting a few extra registrations
// through during an outage is a few extra KV rows.
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
    // An unparseable URI counts as non-loopback, so a malformed entry cannot slip
    // the cap.
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

// FAIL CLOSED, and this REVERSES the rule this module shipped with. The old comment
// argued that the thing guarded is hearing about violations, so every failure had to
// let the report through. The trade is the other way round: /csp-report is
// unauthenticated and every accepted report becomes an R2 object, so a KV outage that
// fails open hands an unauthenticated caller an unbounded write path to R2, while a
// report dropped during an outage costs one browser diagnostic nobody was waiting on.
// Ruled 2026-09-16 (audit defect 7).
export const CSP_REPORT_LIMIT: RateLimitPolicy = {
  prefix: "csp:rate:",
  perHour: MAX_REPORTS_PER_HOUR,
  perDay: MAX_REPORTS_PER_DAY,
  label: "CSP_REPORT",
  onUnavailable: "refuse",
};

// A refusal is either a spent budget or a budget nobody could read. The second
// carries "unavailable" in the same field, so every reader has to say which it is
// rather than printing a count that was never measured.
export type RateRefusal =
  | { allowed: false; window: "hour" | "day"; count: number; limit: number }
  | { allowed: false; window: "unavailable"; detail: string };

export type RateVerdict = { allowed: true } | RateRefusal;

function windowKeys(prefix: string, ip: string, now: Date): { hour: string; day: string } {
  const iso = now.toISOString();
  return { hour: `${prefix}h:${ip}:${iso.slice(0, 13)}`, day: `${prefix}d:${ip}:${iso.slice(0, 10)}` };
}

// WHAT A FAILURE MEANS IS THE POLICY'S CALL, not this function's. Every path that
// cannot read or advance a counter ends here, and the endpoint's own `onUnavailable`
// decides. The log line is written either way, because on the allow side it is the
// only output there is.
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
  // Named separately from a read failure: this one is a deploy missing APP_KV, and
  // reporting it as a KV read error sends the reader to KV health instead.
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
    // A write that did not land means the counter does not advance, so the ceiling
    // stops being a ceiling for the rest of the window. Same question, same answer:
    // the endpoint's policy decides.
    return unavailable(policy, ip, `write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { allowed: true };
}

export function callerIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

// 429, not 204: a dropped report must not look stored. 503 for the other refusal,
// because "we could not measure your rate" is a server problem and a 429 would tell
// the caller it had sent too many when nobody counted.
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
