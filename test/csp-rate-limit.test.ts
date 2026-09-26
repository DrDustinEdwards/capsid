import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CSP_REPORT_LIMIT,
  checkRate,
  MAX_REPORTS_PER_DAY,
  MAX_REPORTS_PER_HOUR,
  rateLimitedResponse,
  REGISTRATION_LIMIT,
} from "../src/rate-limit.ts";

const checkCspReportRate = (kv: KVNamespace | undefined, ip: string, now: Date) => checkRate(kv, ip, now, CSP_REPORT_LIMIT);
const checkRegistrationRate = (kv: KVNamespace | undefined, ip: string, now: Date) => checkRate(kv, ip, now, REGISTRATION_LIMIT);
import { fakeKv } from "./fakes.ts";

// An app-level rate limit on /csp-report. Cloudflare rate limiting rules are a zone
// feature and do not apply to *.workers.dev, so the limit lives in the Worker,
// reusing the limiter /register has. Every accepted report becomes an R2 object.
//
// Every test is about one of two properties: the limit fires, and it says why it
// fired. This endpoint refuses on a KV failure, and a refusal that cannot be told
// apart from a spent budget cannot be diagnosed during the outage that caused it.
//
// node --test cannot load src/routes.ts (it pulls in `cloudflare:workers`), so the
// limiter and the response are tested directly as modules.


const NOW = new Date("2026-08-17T12:00:00Z");
const IP = "203.0.113.7";
const HOUR_KEY = `${CSP_REPORT_LIMIT.prefix}h:${IP}:2026-08-17T12`;
const DAY_KEY = `${CSP_REPORT_LIMIT.prefix}d:${IP}:2026-08-17`;

test("an ordinary report is allowed, and both windows advance with an expiry", async () => {
  const kv = fakeKv();
  const verdict = await checkCspReportRate(kv.kv, IP, NOW);
  assert.equal(verdict.allowed, true);
  assert.equal(kv.store.get(HOUR_KEY), "1");
  assert.equal(kv.store.get(DAY_KEY), "1");
  // Without the TTLs the daily bucket becomes permanent.
  assert.deepEqual(kv.puts.map((p) => p.ttl).sort((a, b) => (a ?? 0) - (b ?? 0)), [3600, 86_400]);
});

test("the hourly limit fires AT the threshold, and the refusal names it", async () => {
  const kv = fakeKv({ seed: { [HOUR_KEY]: String(MAX_REPORTS_PER_HOUR), [DAY_KEY]: "5" } });
  const verdict = await checkCspReportRate(kv.kv, IP, NOW);
  assert.equal(verdict.allowed, false, "the hourly limit did not fire at the threshold");
  assert.equal(verdict.window, "hour");
  assert.equal(verdict.limit, MAX_REPORTS_PER_HOUR);
  assert.equal(verdict.count, MAX_REPORTS_PER_HOUR);
  // A refused call must not advance the counter, or a blocked caller extends their
  // own block by retrying.
  assert.deepEqual(kv.puts, [], "a refused report advanced the counter");
  assert.equal(kv.store.get(HOUR_KEY), String(MAX_REPORTS_PER_HOUR));
});

test("one under the threshold still passes", async () => {
  // A limiter that refused at limit-1 would pass the test above.
  const kv = fakeKv({ seed: { [HOUR_KEY]: String(MAX_REPORTS_PER_HOUR - 1) } });
  const verdict = await checkCspReportRate(kv.kv, IP, NOW);
  assert.equal(verdict.allowed, true, "the limit fired one call early");
  assert.equal(kv.store.get(HOUR_KEY), String(MAX_REPORTS_PER_HOUR));
});

test("the daily limit fires even when the hour is quiet", async () => {
  const kv = fakeKv({ seed: { [HOUR_KEY]: "1", [DAY_KEY]: String(MAX_REPORTS_PER_DAY) } });
  const verdict = await checkCspReportRate(kv.kv, IP, NOW);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.window, "day");
  assert.equal(verdict.limit, MAX_REPORTS_PER_DAY);
  assert.deepEqual(kv.puts, [], "a refused report advanced the counter");
});

// What an unreadable counter means, per endpoint. /csp-report is unauthenticated and
// every accepted report becomes an R2 object, so failing open during a KV outage would
// hand an anonymous caller an unbounded write path to R2. /register fails open, as
// stated on REGISTRATION_LIMIT: refusing there locks the owner out of reconnecting.
// The two directions are planted separately.

test("PLANT: a KV read that throws REFUSES a csp report, and says it could not measure", async () => {
  const kv = fakeKv({ failGet: true });
  const verdict = await checkCspReportRate(kv.kv, IP, NOW);
  assert.equal(verdict.allowed, false, "a KV read failure left the unauthenticated R2 write path unbounded");
  assert.equal(verdict.window, "unavailable", "the refusal was reported as a spent budget rather than an unmeasured one");
});

test("PLANT: a KV write that throws REFUSES too, because the ceiling stops advancing", async () => {
  // The read succeeded, but a counter that does not advance means every later call
  // in the window reads the same low number.
  const kv = fakeKv({ failPut: true });
  assert.equal((await checkCspReportRate(kv.kv, IP, NOW)).allowed, false);
});

test("PLANT: a non-numeric counter REFUSES, and is not written back", async () => {
  // Every comparison with NaN is false, so without the finite check the limiter would
  // store the literal "NaN" and disable the limit for that caller for the window.
  const kv = fakeKv({ corrupt: "banana" });
  assert.equal((await checkCspReportRate(kv.kv, IP, NOW)).allowed, false);
  assert.deepEqual(kv.puts, [], "a corrupt counter was incremented, poisoning the key for the whole window");
});

test("PLANT: no KV binding REFUSES, and is REPORTED as a binding problem", async () => {
  // The read try/catch already refuses an absent binding, so `allowed` alone proves
  // nothing about the explicit guard. The guard's purpose is the diagnosis: "no KV
  // binding" names a deploy missing APP_KV rather than quoting a TypeError.
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  try {
    assert.equal((await checkCspReportRate(undefined, IP, NOW)).allowed, false, "a missing KV binding left the endpoint unbounded");
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1, `expected one log line, got: ${errors.join(" | ")}`);
  assert.match(errors[0], /CSP_REPORT_RATE_LIMIT_UNAVAILABLE no KV binding/, `wrong diagnosis: ${errors[0]}`);
  assert.match(errors[0], /refusing/, "the log claimed the report was allowed through");
  assert.doesNotMatch(errors[0], /read failed/, "a missing binding was reported as a KV read failure");
});

test("an unavailable refusal answers 503 and not 429", async () => {
  // A 429 would tell the caller it had sent too many when nobody counted anything.
  const kv = fakeKv({ failGet: true });
  const verdict = await checkCspReportRate(kv.kv, IP, NOW);
  assert.equal(verdict.allowed, false);
  const response = rateLimitedResponse(verdict);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.match(await response.text(), /rate limiting is unavailable/);
});

// /register fails open.

test("THE OTHER DIRECTION: every KV failure still ALLOWS a registration", async () => {
  // An outage must not lock the owner out of reconnecting. Each path is driven,
  // because they fail in different places.
  for (const [name, kv] of [
    ["read throws", fakeKv({ failGet: true }).kv],
    ["write throws", fakeKv({ failPut: true }).kv],
    ["corrupt counter", fakeKv({ corrupt: "banana" }).kv],
    ["no binding", undefined],
  ] as const) {
    assert.equal((await checkRegistrationRate(kv, IP, NOW)).allowed, true, `a registration was refused when ${name}`);
  }
});

test("the two endpoints give OPPOSITE answers to the same KV failure", async () => {
  // Asserted together so a refactor that collapsed the policies into one rule fails.
  assert.equal((await checkCspReportRate(fakeKv({ failGet: true }).kv, IP, NOW)).allowed, false);
  assert.equal((await checkRegistrationRate(fakeKv({ failGet: true }).kv, IP, NOW)).allowed, true);
});

test("csp reports and registrations count in separate buckets", async () => {
  // One prefix per endpoint. Sharing would let CSP traffic exhaust the registration
  // budget.
  const kv = fakeKv();
  await checkCspReportRate(kv.kv, IP, NOW);
  await checkRegistrationRate(kv.kv, IP, NOW);
  const keys = [...kv.store.keys()];
  assert.equal(keys.filter((k) => k.startsWith("csp:rate:")).length, 2, `csp keys missing: ${keys.join(", ")}`);
  assert.equal(keys.filter((k) => k.startsWith("dcr:rate:")).length, 2, `dcr keys missing: ${keys.join(", ")}`);
});

test("a report from another IP does not spend this one's budget", async () => {
  const kv = fakeKv({ seed: { [HOUR_KEY]: String(MAX_REPORTS_PER_HOUR) } });
  assert.equal((await checkCspReportRate(kv.kv, "198.51.100.4", NOW)).allowed, true, "the limit is not per caller");
  assert.equal((await checkCspReportRate(kv.kv, IP, NOW)).allowed, false);
});

test("a report in the next hour is not blocked by this hour's count", async () => {
  // Fixed windows keyed by the clock. Without this the block would never lift.
  const kv = fakeKv({ seed: { [HOUR_KEY]: String(MAX_REPORTS_PER_HOUR) } });
  assert.equal((await checkCspReportRate(kv.kv, IP, NOW)).allowed, false);
  assert.equal((await checkCspReportRate(kv.kv, IP, new Date("2026-08-17T13:00:00Z"))).allowed, true);
});

test("a rate-limited caller gets a 429 with a usable Retry-After, not a 204", async () => {
  // 204 is this endpoint's normal answer; a dropped report must not read as stored.
  const hourly = rateLimitedResponse({ allowed: false, window: "hour", count: 300, limit: 300 });
  assert.equal(hourly.status, 429, "a dropped report was reported as accepted");
  assert.equal(hourly.headers.get("Retry-After"), "3600");
  assert.match(await hourly.text(), /too many reports: 300 in the last hour, limit 300/);

  // The Retry-After follows the window that fired.
  const daily = rateLimitedResponse({ allowed: false, window: "day", count: 1000, limit: 1000 });
  assert.equal(daily.headers.get("Retry-After"), "86400");
});

// That the handler checks the limit before it reads the body or writes to R2 is proven
// against the real Worker in test-integration/csp-report.test.ts.


test("the csp thresholds are clear of real volume, and the day allows more than an hour", async () => {
  // The busiest measured day had 15 reports. The hourly bound is set from what must
  // not break (a CSP debugging session), not from that traffic.
  assert.ok(MAX_REPORTS_PER_HOUR > 15 * 15, "the hourly bound is no longer clear of the busiest measured day");
  assert.ok(MAX_REPORTS_PER_DAY > MAX_REPORTS_PER_HOUR, "the daily bound must allow more than a single hour");
});
