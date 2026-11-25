import assert from "node:assert/strict";
import { test } from "node:test";
import { SCOPE_FLAGS, defaultScopes } from "../src/agents-schema.ts";
import { adminAgentForEmail, grantAgent, type Agent } from "../src/agents.ts";
import { missingForJob, serializeRequiredScopes } from "../src/jobs-schema.ts";

// A job's required scopes are checked at the claim, not discovered when the lease expires.

function driver(mutate: (scopes: ReturnType<typeof defaultScopes>) => void = () => {}): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  mutate(scopes);
  return {
    id: "agent_0123456789ab",
    name: "capsid-driver",
    kind: "driver",
    actor: "agent:capsid-driver",
    scopes,
    admin: false,
    row: null,
  };
}

test("a job with no requirement is claimable by any write-grant driver, which is every job posted so far", () => {
  assert.equal(missingForJob(driver(), "capsid", null), null);
  assert.equal(missingForJob(driver(), "capsid", ""), null);
  assert.equal(missingForJob(driver(), "capsid", "{}"), null);
});

test("a read-only agent cannot claim, even a job that requires nothing", () => {
  const readOnly = driver((s) => {
    s.grants = ["read"];
  });
  assert.match(String(missingForJob(readOnly, "capsid", null)), /requires the write grant/);
});

test("the legacy key and the admin can still claim anything, which is what keeps the queue working today", () => {
  const everything = serializeRequiredScopes({ flags: [...SCOPE_FLAGS] });
  assert.equal(
    missingForJob(grantAgent("write", "opkey:0123456789ab"), "sample", everything),
    null,
  );
  assert.equal(missingForJob(adminAgentForEmail("admin@example.com"), "sample", everything), null);
});
