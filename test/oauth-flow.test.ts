import assert from "node:assert/strict";
import { test } from "node:test";
import { callerIp } from "../src/rate-limit.ts";

// The /register check and its rate limit are site-runtime's mcp-login (registrationRefusal,
// registrationLimited), tested there and driven through the Worker in
// test-integration/oauth.test.ts. The consent dialog and the callback's state handling are
// driven in test-integration/oauth-flow.test.ts.

test("callerIp reads CF-Connecting-IP and falls back off the edge", () => {
  assert.equal(callerIp(new Request("https://x/", { headers: { "CF-Connecting-IP": "5.6.7.8" } })), "5.6.7.8");
  assert.equal(callerIp(new Request("https://x/")), "unknown");
});
