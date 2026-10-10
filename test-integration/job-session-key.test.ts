import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import { defaultScopes, serializeScopes } from "../src/agents-schema";
import { claimJob, failJob, postJob } from "../src/jobs";
import { legacyAgent, resolveAgent } from "../src/agents";

// Per-job keys for unattended drivers (OWASP item 5, src/job-session-key.ts) on real D1:
// the key is inserted in the claim's own guarded batch, it resolves bound to its job, the
// driver's held claims count it through the LIKE on claimed_by, and failing the job revokes
// it by job_id. test/job-session-key.test.ts covers the refusals against the fake.

const SECRET = "test-root-secret";
const KEY = "capsid_agent_" + "e".repeat(64);
const NAME = "session-driver";
const NOW = new Date("2026-10-10T09:00:00.000Z");
const jobsEnv = () => ({ ...env, IMPROVE_SCORE_SECRET: SECRET }) as unknown as Parameters<typeof postJob>[0];
const bearer = (key: string) => new Request("https://capsid.example/ops/mcp", { headers: { Authorization: `Bearer ${key}` } });

describe("a job handed to a session key, on real D1", () => {
  it("mints the key in the claim, counts it against the driver, and revokes it when the job fails", async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)").bind("capsid", JSON.stringify([{ repo: "example/capsid", label: "primary" }])).run();
    const scopes = defaultScopes(["capsid"]);
    scopes.grants = ["read", "write"];
    await env.DB.prepare(
      "INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at) VALUES ('agent_eeeeeeeeeeee', ?1, 'driver', ?2, ?3, 'github:dustin', '2026-10-01 00:00:00')"
    )
      .bind(NAME, await sha256Hex(KEY), serializeScopes(scopes))
      .run();
    const driver = (await resolveAgent(bearer(KEY), env, NOW))!.agent;
    const admin = legacyAgent("write", "github:DrDustinEdwards");
    const first = (await postJob(jobsEnv(), admin, NOW, { namespace: "capsid", title: "session key one", body: "b" })).job!.id;
    const second = (await postJob(jobsEnv(), admin, NOW, { namespace: "capsid", title: "session key two", body: "b" })).job!.id;

    const claimed = await claimJob(jobsEnv(), driver, NOW, { id: first, sessionKey: true });
    expect(claimed.ok, JSON.stringify(claimed)).toBe(true);
    const minted = claimed.session_key!;
    const stored = await env.DB.prepare("SELECT kind, job_id, created_by FROM agents WHERE name = ?1").bind(minted.name).first();
    expect(stored).toEqual({ kind: "session", job_id: first, created_by: `agent:${NAME}` });
    const session = (await resolveAgent(bearer(minted.key), env, NOW))!.agent;
    expect(session.job).toBe(first);

    const blocked = await claimJob(jobsEnv(), driver, NOW, { id: second });
    expect(blocked.ok).toBe(false);

    const failed = await failJob(jobsEnv(), session, NOW, first, "could not finish");
    expect(failed.ok, JSON.stringify(failed)).toBe(true);
    const after = await env.DB.prepare("SELECT revoked_at FROM agents WHERE name = ?1").bind(minted.name).first<{ revoked_at: string | null }>();
    expect(after?.revoked_at).not.toBeNull();
    expect(await resolveAgent(bearer(minted.key), env, NOW)).toBeNull();
  });
});
