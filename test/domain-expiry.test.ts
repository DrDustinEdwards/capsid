import assert from "node:assert/strict";
import { test } from "node:test";
import { BOOTSTRAP_URL, expirationOf, expiryFindings, expiryKey, rdapBase, readExpiries, registrableDomain } from "../src/domain-expiry.ts";
import { owningCheck } from "../src/watcher.ts";
import { fakeKv } from "./fakes.ts";

// Domain registration expiry by RDAP (job_5ac1139641e0, design-portal-insight.md section 5).
// Sample domains on example TLDs only; the RDAP answers are fixtures in RFC 9083's shape.

const NOW = new Date("2026-10-10T12:00:00.000Z");
const DAY = 86_400_000;
const inDays = (d: number) => new Date(NOW.getTime() + d * DAY + 3_600_000).toISOString();
const BOOTSTRAP = { services: [[["example", "test"], ["https://rdap.example.org/"]], [["other"], ["http://insecure.example.net/"]]] };

test("a site's registrable domain, and none for a hosting suffix or an address", () => {
  assert.equal(registrableDomain("https://www.sample.example"), "sample.example");
  assert.equal(registrableDomain("https://sample.example"), "sample.example");
  assert.equal(registrableDomain("https://sample.dustin-edwards.workers.dev"), null);
  assert.equal(registrableDomain("https://sample.vercel.app"), null);
  assert.equal(registrableDomain("https://192.0.2.1"), null);
  assert.equal(registrableDomain("not a url"), null);
});

test("the bootstrap names the TLD's https RDAP base, and the answer's expiration event is read", () => {
  assert.equal(rdapBase(BOOTSTRAP, "sample.example"), "https://rdap.example.org/");
  assert.equal(rdapBase(BOOTSTRAP, "sample.other"), null, "an http-only base is not used");
  assert.equal(rdapBase(BOOTSTRAP, "sample.none"), null);
  assert.equal(expirationOf({ events: [{ eventAction: "registration", eventDate: "2020-01-01T00:00:00Z" }, { eventAction: "expiration", eventDate: "2026-12-27T22:31:59Z" }] }), "2026-12-27T22:31:59.000Z");
  assert.equal(expirationOf({ events: [] }), null);
});

test("PLANT: a finding inside 30 days, a new one inside 7, none before, both owned by the domains check", () => {
  const found = expiryFindings(
    [
      { domain: "far.example", expires: inDays(88) },
      { domain: "month.example", expires: inDays(29) },
      { domain: "week.example", expires: inDays(6) },
      { domain: "gone.example", expires: inDays(-3) },
    ],
    NOW
  );
  assert.deepEqual(found.map((f) => f.fingerprint), ["domain-expiry-30d-month-example", "domain-expiry-7d-week-example", "domain-expiry-7d-gone-example"]);
  assert.match(found[0].title, /month\.example's registration expires in 29 days/);
  assert.match(found[2].title, /expired 3 days ago/);
  for (const f of found) assert.equal(owningCheck(f.fingerprint), "domains");
});

test("PLANT: an expiry read in the last day is served from KV, with no RDAP call; a failed read is reported, not guessed", async () => {
  const kv = fakeKv({}).kv;
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url === BOOTSTRAP_URL) return Response.json(BOOTSTRAP);
    if (url === "https://rdap.example.org/domain/sample.example") return Response.json({ events: [{ eventAction: "expiration", eventDate: inDays(20) }] });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const first = await readExpiries(kv, ["sample.example", "missing.example"], fetchImpl, NOW);
  assert.deepEqual(first.expiries, [{ domain: "sample.example", expires: inDays(20) }]);
  assert.deepEqual(first.failed.map((f) => f.domain), ["missing.example"]);
  assert.match(first.failed[0].error, /answered 404/);
  assert.equal(calls.length, 3, "the bootstrap once, then one call per domain");
  assert.ok(await kv.get(expiryKey("sample.example")));
  calls.length = 0;
  const second = await readExpiries(kv, ["sample.example"], fetchImpl, NOW);
  assert.deepEqual(second.expiries, first.expiries);
  assert.deepEqual(calls, [], "the day's cached answer was fetched again");
});
