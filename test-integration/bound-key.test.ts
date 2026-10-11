import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import { defaultScopes, serializeScopes } from "../src/agents-schema";
import { resolveAgent } from "../src/agents";

// migrations/0021 and the bound-key resolver against real D1: the column exists, a key
// bound to a claimed job resolves, and the same key stops resolving
// the moment its job leaves that state. test/bound-key.test.ts covers each state
// against the fake; this proves the SQL and the migration.

const KEY = "capsid_runner_" + "c".repeat(64);
const JOB = "job_00000000c0de";
const NAME = `runner-${JOB}-1`;
const NOW = new Date("2026-09-27T12:00:00.000Z");

const bearer = () => new Request("https://capsid.example/ops/mcp", { headers: { Authorization: `Bearer ${KEY}` } });

async function seed(status: string) {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO jobs (id, namespace, title, body, status, posted_by, claimed_by)
       VALUES (?1, 'capsid', 'bound', 'body', ?2, 'github:dustin', ?3)`
    ).bind(JOB, status, `agent:${NAME}`),
    env.DB.prepare(
      `INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at, job_id)
       VALUES ('agent_c0dec0dec0de', ?1, 'session', ?2, ?3, 'github:dustin', '2026-09-27 11:55:00', ?4)`
    ).bind(NAME, await sha256Hex(KEY), serializeScopes(scopes), JOB),
  ]);
}

describe("a runner key bound to one job, on real D1", () => {
  // Storage is shared across this file's tests, so each starts from no seed.
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM agents WHERE name = ?1").bind(NAME),
      env.DB.prepare("DELETE FROM jobs WHERE id = ?1").bind(JOB),
    ]);
  });

  it("resolves while its job is claimed by it, and carries the binding", async () => {
    await seed("claimed");
    const resolved = await resolveAgent(bearer(), env, NOW);
    expect(resolved?.agent.job).toBe(JOB);
  });

  it("stops resolving when its job is done, with no revocation written", async () => {
    await seed("claimed");
    await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE id = ?1").bind(JOB).run();
    expect(await resolveAgent(bearer(), env, NOW)).toBeNull();
    const row = await env.DB.prepare("SELECT revoked_at FROM agents WHERE name = ?1").bind(NAME).first<{ revoked_at: string | null }>();
    expect(row?.revoked_at).toBeNull();
  });

  it("keeps resolving a day later: a claim has no lease to lapse", async () => {
    await seed("claimed");
    expect(await resolveAgent(bearer(), env, new Date(NOW.getTime() + 24 * 3_600_000))).not.toBeNull();
  });
});
