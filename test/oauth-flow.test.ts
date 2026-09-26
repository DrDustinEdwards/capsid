import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalTag } from "../src/approval.ts";
import { callerIp, checkRate, dcrRedirectRefusal, isLoopbackRedirect, MAX_PER_DAY, MAX_PER_HOUR, REGISTRATION_LIMIT } from "../src/rate-limit.ts";

const checkRegistrationRate = (kv: KVNamespace | undefined, ip: string, now: Date) => checkRate(kv, ip, now, REGISTRATION_LIMIT);
import { fakeKv } from "./fakes.ts";


// The shared KV fake's failure injection is what makes the limiter's fail-open
// paths testable.

const NOW = new Date("2026-08-17T14:30:00.000Z");
const HOUR_KEY = "dcr:rate:h:1.2.3.4:2026-08-17T14";
const DAY_KEY = "dcr:rate:d:1.2.3.4:2026-08-17";

// the /register rate limit

test("a first registration is allowed and both counters start at 1", async () => {
  const kv = fakeKv();
  const verdict = await checkRegistrationRate(kv.kv, "1.2.3.4", NOW);
  assert.deepEqual(verdict, { allowed: true });
  assert.equal(kv.store.get(HOUR_KEY), "1");
  assert.equal(kv.store.get(DAY_KEY), "1");
  // The counters must expire, or the daily bucket becomes permanent.
  assert.deepEqual(kv.puts.map((p) => p.ttl).sort((a, b) => (a ?? 0) - (b ?? 0)), [3600, 86_400]);
});

test("the hourly limit refuses at the threshold, named", async () => {
  const kv = fakeKv({ seed: { [HOUR_KEY]: String(MAX_PER_HOUR), [DAY_KEY]: "40" } });
  const verdict = await checkRegistrationRate(kv.kv, "1.2.3.4", NOW);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.window, "hour");
  assert.equal(verdict.limit, MAX_PER_HOUR);
  assert.equal(verdict.count, MAX_PER_HOUR);
  // A refused call must not advance the counter, or a blocked caller stays blocked
  // for longer every time they retry.
  assert.deepEqual(kv.puts, []);
});

test("the daily limit refuses even when the hour is quiet", async () => {
  const kv = fakeKv({ seed: { [HOUR_KEY]: "1", [DAY_KEY]: String(MAX_PER_DAY) } });
  const verdict = await checkRegistrationRate(kv.kv, "1.2.3.4", NOW);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.window, "day");
  assert.equal(verdict.limit, MAX_PER_DAY);
});

test("the measured 2026-08-09 burst still gets through", async () => {
  // 22 registrations from one IP inside about two hours, a legitimate client retry
  // pattern that the limit must allow.
  const kv = fakeKv();
  for (let i = 0; i < 22; i++) {
    const at = new Date(NOW.getTime() + i * 5 * 60_000); // one every 5 minutes
    const verdict = await checkRegistrationRate(kv.kv, "1.2.3.4", at);
    assert.equal(verdict.allowed, true, `registration ${i + 1} of 22 was refused`);
  }
  assert.equal(Number(kv.store.get(DAY_KEY)), 22);
});

test("the limiter FAILS OPEN when the counter read throws", async () => {
  const kv = fakeKv({ failGet: true });
  const verdict = await checkRegistrationRate(kv.kv, "1.2.3.4", NOW);
  assert.deepEqual(verdict, { allowed: true }, "a KV read failure blocked a registration");
});

test("the limiter FAILS OPEN when the counter write throws", async () => {
  const kv = fakeKv({ failPut: true });
  const verdict = await checkRegistrationRate(kv.kv, "1.2.3.4", NOW);
  assert.deepEqual(verdict, { allowed: true }, "a KV write failure blocked a registration");
});

test("the limiter FAILS OPEN on a corrupt counter value", async () => {
  // Corrupted at the store, not at a key name this test guessed: a change to the
  // key layout must not turn this into a test that passes by reading nothing.
  const kv = fakeKv({ corrupt: "not-a-number" });
  const verdict = await checkRegistrationRate(kv.kv, "1.2.3.4", NOW);
  assert.deepEqual(verdict, { allowed: true });
});

test("counters are per IP and per window", async () => {
  // The bucket is filled by driving the real code, not by seeding a key name this
  // test assumed. A single global bucket would then refuse the second address.
  const kv = fakeKv();
  for (let i = 0; i < MAX_PER_HOUR; i++) await checkRegistrationRate(kv.kv, "1.2.3.4", NOW);
  assert.equal((await checkRegistrationRate(kv.kv, "1.2.3.4", NOW)).allowed, false, "the bucket did not fill");
  assert.equal((await checkRegistrationRate(kv.kv, "9.9.9.9", NOW)).allowed, true, "one address blocked another");
  // And the next hour is a fresh bucket for the blocked address.
  const nextHour = new Date(NOW.getTime() + 3600_000);
  assert.equal((await checkRegistrationRate(kv.kv, "1.2.3.4", nextHour)).allowed, true, "the hour window never rolls");
});

test("callerIp reads CF-Connecting-IP and falls back off the edge", () => {
  assert.equal(callerIp(new Request("https://x/", { headers: { "CF-Connecting-IP": "5.6.7.8" } })), "5.6.7.8");
  assert.equal(callerIp(new Request("https://x/")), "unknown");
});

// Driven in test-integration/oauth-flow.test.ts rather than here: the wiring of this
// limiter into the registration callback (a caller over the limit gets 429 from
// /register); the callback's state handling (a failed token exchange leaves the state
// in place, and a corrupt stored state answers 403, is removed, and never reaches
// GitHub); and the approval cookie's lifetime, its binding to one redirect, the dialog
// listing every registered redirect, and a stale approval for a client that no longer
// resolves.

// The approval cookie: the real function, not a copy, since this is its security property.
test("the tag binds one redirect URI, so approving one does not authorize a sibling", async () => {
  const claudeUri = "https://claude.ai/api/mcp/auth_callback";
  const attackerUri = "https://evil.example/callback";
  const approvedForClaude = await approvalTag("abc", claudeUri);
  // The phishing case: same client, a different redirect. The sibling has its own
  // tag and comes back to the dialog.
  const forAttacker = await approvalTag("abc", attackerUri);
  assert.notEqual(approvedForClaude, forAttacker, "approving one redirect covered a sibling redirect");
  // The exact same URI is stable.
  assert.equal(approvedForClaude, await approvalTag("abc", claudeUri));
  // Two clients with the same redirect do not share an approval.
  assert.notEqual(approvedForClaude, await approvalTag("xyz", claudeUri));
  // The measured shape: id, dot, 16 hex.
  assert.match(approvedForClaude, /^[A-Za-z0-9_-]+\.[0-9a-f]{16}$/);
  assert.equal(await approvalTag("abc", undefined), await approvalTag("abc", ""));
});

// the DCR redirect cap

test("dcrRedirectRefusal refuses more than one non-loopback redirect (old code had no such check)", () => {
  // One non-loopback plus any number of loopbacks: allowed (native client).
  assert.equal(
    dcrRedirectRefusal({ redirect_uris: ["https://claude.ai/cb", "http://127.0.0.1:1/cb", "http://localhost:2/cb"] }),
    null
  );
  // Two non-loopback: refused. This is the registration that carries an attacker's
  // second redirect alongside a legitimate one.
  const refusal = dcrRedirectRefusal({ redirect_uris: ["https://claude.ai/cb", "https://evil.example/cb"] });
  assert.ok(refusal);
  assert.equal(refusal.status, 400);
  assert.match(refusal.description, /at most one non-loopback/);
  // No redirects, or metadata absent: nothing to refuse here.
  assert.equal(dcrRedirectRefusal({}), null);
  assert.equal(dcrRedirectRefusal(null), null);
});

test("isLoopbackRedirect classifies hosts and treats a malformed URI as non-loopback", () => {
  assert.equal(isLoopbackRedirect("http://127.0.0.1:8976/cb"), true);
  assert.equal(isLoopbackRedirect("http://localhost/cb"), true);
  assert.equal(isLoopbackRedirect("http://[::1]:3000/cb"), true);
  assert.equal(isLoopbackRedirect("https://claude.ai/cb"), false);
  assert.equal(isLoopbackRedirect("not a url"), false);
});

// The pinned resource and the redirect cap at registration are driven in
// test-integration/oauth.test.ts: "serves protected-resource and authorization-server
// metadata" and "PLANT: two https redirect_uris are refused at POST /register".
