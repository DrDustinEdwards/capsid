import assert from "node:assert/strict";
import { test } from "node:test";
import { tlsAlerts } from "../src/tls-expiry.ts";

const NOW = new Date("2026-10-31T12:00:00Z");
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000 + 3_600_000).toISOString();

test("a certificate alerts once at 14 days and again at 3, under a new key each time; one further out is quiet", () => {
  const read = (days: number) => ({ read_at: NOW.toISOString(), hosts: [{ host: "sample.example.com", expires: at(days) }], failed: [] });
  assert.deepEqual(tlsAlerts(read(15), NOW), []);
  const early = tlsAlerts(read(14), NOW);
  const late = tlsAlerts(read(3), NOW);
  assert.match(early[0]!.key, /^tls-14d:sample\.example\.com:/);
  assert.match(late[0]!.key, /^tls-3d:sample\.example\.com:/);
  assert.equal(tlsAlerts(null, NOW).length, 0);
});
