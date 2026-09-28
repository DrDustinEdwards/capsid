import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalTag } from "../src/approval.ts";
import { callerIp } from "../src/rate-limit.ts";

// The /register rate limit and its redirect cap went with DCR (design PR 4 of
// capsid/research/design-capsid-access-login.md). The limiter itself is still the one
// /csp-report uses, and test/csp-rate-limit.test.ts drives it.

test("callerIp reads CF-Connecting-IP and falls back off the edge", () => {
  assert.equal(callerIp(new Request("https://x/", { headers: { "CF-Connecting-IP": "5.6.7.8" } })), "5.6.7.8");
  assert.equal(callerIp(new Request("https://x/")), "unknown");
});

// Driven in test-integration/oauth-flow.test.ts rather than here: the callback's state
// handling (a failed token exchange leaves the state in place, and a corrupt stored
// state answers 403, is removed, and never reaches Access); and the approval cookie's
// lifetime, its binding to one redirect, the dialog listing every redirect the
// client's metadata document names, and a stale approval for a client that no longer
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
