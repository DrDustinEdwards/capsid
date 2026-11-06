import assert from "node:assert/strict";
import { test } from "node:test";
import { tlsAlerts } from "../src/tls-expiry.ts";
import { domainAlerts } from "../src/domain-expiry.ts";

const NOW = new Date("2026-10-31T12:00:00Z");
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000 + 3_600_000).toISOString();

test("a certificate alerts once at 21 days and again at 3, under a new key each time; one further out is quiet", () => {
  const read = (days: number) => ({ read_at: NOW.toISOString(), hosts: [{ host: "sample.example.com", expires: at(days) }], failed: [] });
  assert.deepEqual(tlsAlerts(read(22), NOW), []);
  const early = tlsAlerts(read(21), NOW);
  const late = tlsAlerts(read(3), NOW);
  assert.match(early[0]!.key, /^tls-21d:sample\.example\.com:/);
  assert.match(late[0]!.key, /^tls-3d:sample\.example\.com:/);
  assert.equal(tlsAlerts(null, NOW).length, 0);
});

test("a domain registration pushes once at 30 days and again at 7, keyed by its date", () => {
  const read = (days: number) => ({ read_at: NOW.toISOString(), domains: [{ domain: "example.com", expires: at(days) }] });
  assert.deepEqual(domainAlerts(read(31), NOW), []);
  assert.match(domainAlerts(read(30), NOW)[0]!.key, /^domain-30d:example\.com:/);
  assert.match(domainAlerts(read(7), NOW)[0]!.key, /^domain-7d:example\.com:/);
  assert.equal(domainAlerts(undefined, NOW).length, 0);
});
