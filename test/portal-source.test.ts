import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceAddress } from "../src/portal-auth.ts";

// The address a Portal click came from (src/portal-auth.ts, sourceAddress), recorded in
// its audit row. Cloudflare's edge sets CF-Connecting-IP; anything that is not an
// address is recorded as null rather than stored as given.

const from = (value: string | null) => sourceAddress(new Request("https://capsid.example/portal/api/actions/perform", { headers: value === null ? {} : { "CF-Connecting-IP": value } }));

test("an IPv4 or IPv6 address is recorded as sent", () => {
  for (const ip of ["203.0.113.7", "2001:db8::7", "::1", "2001:0db8:0000:0000:0000:ff00:0042:8329", " 198.51.100.4 "]) {
    assert.equal(from(ip), ip.trim(), ip);
  }
});

test("PLANT: anything else is null, never stored as given", () => {
  for (const junk of [null, "", "abc", "deadbeef", "1.2.3.4; DROP TABLE audit_log", "<script>", "203.0.113.7, 10.0.0.1", "x".repeat(60)]) {
    assert.equal(from(junk), null, String(junk));
  }
});
