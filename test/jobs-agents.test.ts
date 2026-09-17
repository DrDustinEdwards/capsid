import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SCOPE_FLAGS, defaultScopes } from "../src/agents-schema.ts";
import { adminAgent, legacyAgent, type Agent } from "../src/agents.ts";
import { missingForJob, parseRequiredScopes, serializeRequiredScopes } from "../src/jobs-schema.ts";

// GROUP 5: THE QUEUE ASKS WHAT A DRIVER CAN DO BEFORE HANDING IT THE WORK.
//
// The claim used to authorize on one question: does this caller hold the write grant.
// Every driver did, because there was one headless credential and it could do
// everything. A job whose work ends in a merge was claimed by whoever asked first, and
// the mismatch surfaced four hours later when the lease expired, or did not surface at
// all because the driver could do it and nobody had decided that it should.

const MIGRATION = readFileSync(join(import.meta.dirname, "..", "migrations", "0009_jobs_required_scopes.sql"), "utf8");

function driver(mutate: (scopes: ReturnType<typeof defaultScopes>) => void = () => {}): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  mutate(scopes);
  return { id: "agent_0123456789ab", name: "capsid-driver", kind: "driver", actor: "agent:capsid-driver", scopes, admin: false, row: null };
}

test("the migration adds the column the queue reads, and says null means no requirement", () => {
  assert.match(MIGRATION, /ALTER TABLE jobs ADD COLUMN required_scopes TEXT/);
  assert.match(MIGRATION, /NULL MEANS NO REQUIREMENT/i, "a nullable column with no stated meaning is a column two readers will disagree about");
});

test("a job with no requirement is claimable by any write-grant driver, which is every job posted so far", () => {
  assert.equal(missingForJob(driver(), "capsid", null), null);
  assert.equal(missingForJob(driver(), "capsid", ""), null);
  assert.equal(missingForJob(driver(), "capsid", "{}"), null);
});

test("a job requiring a flag refuses a driver without it, by name", () => {
  const required = serializeRequiredScopes({ flags: ["can_merge"] });
  const refusal = missingForJob(driver(), "capsid", required);
  assert.match(String(refusal), /can_merge/);
  // And the same driver holding the flag is not refused: the innocent direction.
  const merger = driver((s) => {
    s.flags.can_merge = true;
  });
  assert.equal(missingForJob(merger, "capsid", required), null);
});

test("a job in a namespace the driver is not scoped to is refused at the claim", () => {
  const refusal = missingForJob(driver(), "foxing", null);
  assert.match(String(refusal), /not scoped to the 'foxing' namespace/);
});

test("a read-only agent cannot claim, even a job that requires nothing", () => {
  const readOnly = driver((s) => {
    s.grants = ["read"];
  });
  assert.match(String(missingForJob(readOnly, "capsid", null)), /requires the write grant/);
});

test("the legacy key and the admin can still claim anything, which is what keeps the queue working today", () => {
  const everything = serializeRequiredScopes({ flags: [...SCOPE_FLAGS] });
  assert.equal(missingForJob(legacyAgent("write", "opkey:0123456789ab"), "foxhound", everything), null);
  assert.equal(missingForJob(adminAgent("DrDustinEdwards"), "foxhound", everything), null);
});

test("a required_scopes blob that cannot be read is CORRUPT, and refuses rather than demanding nothing", () => {
  // Reversed 2026-09-17 (AUDIT-2026-09-16.md). This used to fail open, and a job whose
  // requirement had been damaged was leased to any driver. The claim now marks such a
  // job failed, so the stranding the old ruling feared cannot happen either.
  for (const bad of ["{", "[]", "null", '{"flags":"can_merge"}', '{"flags":["can_fly","can_merge"]}']) {
    const parsed = parseRequiredScopes(bad);
    assert.equal(parsed.ok, false, `${bad} parsed as a requirement`);
    const refusal = missingForJob(driver(), "capsid", bad);
    assert.ok(refusal, `${bad} was treated as no requirement`);
    assert.match(refusal, /required_scopes/);
  }
  // None is still none.
  assert.deepEqual(parseRequiredScopes(null), { ok: true, value: { flags: [] } });
  assert.deepEqual(parseRequiredScopes('{"flags":["can_merge"]}'), { ok: true, value: { flags: ["can_merge"] } });
  assert.deepEqual(parseRequiredScopes("{}"), { ok: true, value: { flags: [] } });
});

// That the claim checks scopes before it takes the lease is proven against SQLite in
// test-integration/job-required-scopes.test.ts: a refused job STAYS QUEUED.


// That agent, OAuth and operator-key identities can each hold a lease is proven by
// claiming with all three against SQLite in test-integration/jobs.test.ts.

