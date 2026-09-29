import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import { defaultScopes, serializeScopes } from "../src/agents-schema";
import type { Env } from "../src/env";
import { opsFeed } from "../src/ops-feed";
import { HOOK_MAX_BYTES, OPS_HOOKS_PATH } from "../src/ops-hooks";

// The hook receiver through the whole Worker, on real D1 (src/ops-hooks.ts,
// migrations/0025): who may post, the job a session binds to, the needs_input cycle, a
// StopFailure incident, SessionEnd, the size cap, and the feed's live sessions.

const ORIGIN = "https://capsid.test";
const DRIVER_KEY = "capsid_agent_" + "1".repeat(64);
const RO_DRIVER_KEY = "capsid_agent_" + "2".repeat(64);
const CRON_KEY = "capsid_agent_" + "3".repeat(64);
const REVOKED_KEY = "capsid_agent_" + "4".repeat(64);
const RUNNER_KEY = "capsid_runner_" + "5".repeat(64);
const OTHER_DRIVER_KEY = "capsid_agent_" + "6".repeat(64);

const DRIVER_JOB = "job_0000000a0b01";
const SECOND_JOB = "job_0000000a0b02";
const RUNNER_JOB = "job_0000000a0b03";
const RUNNER_NAME = `runner-${RUNNER_JOB}-s1`;

const SESSION = "5e55a0a1-0000-4000-8000-0000000000b1";
const RUNNER_SESSION = "5e55a0a1-0000-4000-8000-0000000000b2";

const HOUR = 3_600_000;
const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

async function agentRow(id: string, name: string, kind: string, key: string, grants: string[], extra: { revoked?: boolean; job?: string } = {}) {
  const scopes = defaultScopes(["sample"]);
  scopes.grants = grants as typeof scopes.grants;
  return env.DB.prepare(
    `INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at, revoked_at, job_id)
     VALUES (?1, ?2, ?3, ?4, ?5, 'github:sample', ?6, ?7, ?8)`
  ).bind(id, name, kind, await sha256Hex(key), serializeScopes(scopes), new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace("T", " "), extra.revoked ? "2026-09-01 00:00:00" : null, extra.job ?? null);
}

function job(id: string, status: string, claimedBy: string | null) {
  return env.DB.prepare(
    `INSERT INTO jobs (id, namespace, title, body, status, posted_by, claimed_by, lease_expires)
     VALUES (?1, 'sample', 'a sample job ' || ?1, 'lorem body', ?2, 'github:sample', ?3, ?4)`
  ).bind(id, status, claimedBy, claimedBy ? iso(-2 * HOUR) : null);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM agents"),
    env.DB.prepare("DELETE FROM jobs"),
    env.DB.prepare("DELETE FROM agent_sessions"),
    env.DB.prepare("DELETE FROM session_events"),
  ]);
  await env.DB.batch([
    await agentRow("agent_hook00000001", "sample-driver", "driver", DRIVER_KEY, ["read", "write"]),
    await agentRow("agent_hook00000002", "sample-ro-driver", "driver", RO_DRIVER_KEY, ["read"]),
    await agentRow("agent_hook00000003", "sample-cron", "cron", CRON_KEY, ["read", "write"]),
    await agentRow("agent_hook00000004", "sample-revoked-driver", "driver", REVOKED_KEY, ["read", "write"], { revoked: true }),
    await agentRow("agent_hook00000005", RUNNER_NAME, "session", RUNNER_KEY, ["read", "write"], { job: RUNNER_JOB }),
    await agentRow("agent_hook00000006", "sample-b-driver", "driver", OTHER_DRIVER_KEY, ["read", "write"]),
    job(DRIVER_JOB, "claimed", "agent:sample-driver"),
    job(SECOND_JOB, "queued", null),
    job(RUNNER_JOB, "claimed", `agent:${RUNNER_NAME}`),
  ]);
});

function hook(key: string | null, body: Record<string, unknown> | string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${OPS_HOOKS_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function ok(key: string, body: Record<string, unknown>): Promise<void> {
  const response = await hook(key, body);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.text()).toBe("");
}

interface SessionRow {
  session_id: string;
  agent: string;
  job_id: string | null;
  namespace: string | null;
  needs_input: number;
  last_event: string;
  last_notification_type: string | null;
  last_failure: string | null;
  ended_at: string | null;
  end_reason: string | null;
}

const session = (id = SESSION) => env.DB.prepare("SELECT * FROM agent_sessions WHERE session_id = ?1").bind(id).first<SessionRow>();
const sessionCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_sessions").first<{ n: number }>())!.n;
const eventCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM session_events").first<{ n: number }>())!.n;

const start = (id = SESSION) => ({ session_id: id, hook_event_name: "SessionStart", source: "startup", model: "claude-sample-model" });
const notify = (type: string) => ({ session_id: SESSION, hook_event_name: "Notification", notification_type: type, title: "Sample", message: "Claude needs your permission" });

describe("who may post hooks", () => {
  it("PLANT: no key, a revoked key, a read-only key and a non-driver agent are refused, and nothing is written", async () => {
    const none = await hook(null, start());
    expect(none.status).toBe(401);
    expect(none.headers.get("WWW-Authenticate")).toBe('Bearer realm="capsid-hooks"');
    expect((await hook(REVOKED_KEY, start())).status, "a revoked driver key").toBe(401);
    expect((await hook(env.TEST_OPERATOR_KEYS.read, start())).status, "the legacy read-only key").toBe(403);
    const ro = await hook(RO_DRIVER_KEY, start());
    expect(ro.status, "a driver minted read-only").toBe(403);
    expect(await ro.text()).toMatch(/write grant/);
    const cron = await hook(CRON_KEY, start());
    expect(cron.status, "a cron agent").toBe(403);
    expect(await cron.text()).toMatch(/not a driver or a runner/);
    expect(await sessionCount()).toBe(0);
    expect(await eventCount()).toBe(0);
  });

  it("the admin's write key is admitted, for testing, and binds to no job", async () => {
    await ok(env.TEST_OPERATOR_KEYS.write, start());
    const row = await session();
    expect(row?.agent).toMatch(/^opkey:/);
    expect(row?.job_id).toBeNull();
  });

  it("PLANT: a runner key binds its session and every event to its own job", async () => {
    await ok(RUNNER_KEY, start(RUNNER_SESSION));
    const row = await session(RUNNER_SESSION);
    expect(row?.agent).toBe(`agent:${RUNNER_NAME}`);
    expect(row?.job_id).toBe(RUNNER_JOB);
    expect(row?.namespace).toBe("sample");
    const event = await env.DB.prepare("SELECT job_id, agent, event, subtype FROM session_events WHERE session_id = ?1").bind(RUNNER_SESSION).first();
    expect(event).toEqual({ job_id: RUNNER_JOB, agent: `agent:${RUNNER_NAME}`, event: "SessionStart", subtype: "startup" });
  });

  it("a driver binds to the one job it holds claimed, and the session keeps that job when the driver moves on", async () => {
    await ok(DRIVER_KEY, start());
    expect((await session())?.job_id).toBe(DRIVER_JOB);
    await env.DB.batch([
      env.DB.prepare("UPDATE jobs SET status = 'done', claimed_by = NULL WHERE id = ?1").bind(DRIVER_JOB),
      env.DB.prepare("UPDATE jobs SET status = 'claimed', claimed_by = 'agent:sample-driver' WHERE id = ?1").bind(SECOND_JOB),
    ]);
    await ok(DRIVER_KEY, { session_id: SESSION, hook_event_name: "Stop" });
    expect((await session())?.job_id, "a session keeps the job it was first bound to").toBe(DRIVER_JOB);
  });

  it("a driver holding no job, or two, binds to none", async () => {
    await env.DB.prepare("UPDATE jobs SET status = 'claimed', claimed_by = 'agent:sample-driver' WHERE id = ?1").bind(SECOND_JOB).run();
    await ok(DRIVER_KEY, start());
    expect((await session())?.job_id).toBeNull();
  });

  it("another key cannot write to a session it did not start", async () => {
    await ok(DRIVER_KEY, start());
    const response = await hook(OTHER_DRIVER_KEY, { session_id: SESSION, hook_event_name: "SessionEnd", reason: "other" });
    expect(response.status).toBe(409);
    expect((await session())?.ended_at).toBeNull();
    expect(await eventCount()).toBe(1);
  });
});

describe("what a session records", () => {
  it("needs_input is set by a waiting Notification, kept through another Notification, and cleared by a later event or agent_completed", async () => {
    await ok(DRIVER_KEY, start());
    expect((await session())?.needs_input).toBe(0);
    await ok(DRIVER_KEY, notify("permission_prompt"));
    expect(await session()).toMatchObject({ needs_input: 1, last_event: "Notification", last_notification_type: "permission_prompt" });
    await ok(DRIVER_KEY, notify("auth_success"));
    expect((await session())?.needs_input, "a Notification that is not about input leaves it").toBe(1);
    await ok(DRIVER_KEY, { session_id: SESSION, hook_event_name: "Stop" });
    expect((await session())?.needs_input).toBe(0);
    await ok(DRIVER_KEY, notify("idle_prompt"));
    expect((await session())?.needs_input).toBe(1);
    await ok(DRIVER_KEY, notify("agent_completed"));
    expect((await session())?.needs_input).toBe(0);
    expect(await eventCount()).toBe(6);
  });

  it("a StopFailure on a rate limit is the session's failure and a feed incident, until a turn ends normally", async () => {
    await ok(DRIVER_KEY, start());
    await ok(DRIVER_KEY, { session_id: SESSION, hook_event_name: "StopFailure", error: "rate_limit", last_assistant_message: "API Error: 429 " + "x".repeat(600), prompt: "never kept" });
    expect((await session())?.last_failure).toBe("rate_limit");
    const event = await env.DB.prepare("SELECT subtype, detail FROM session_events WHERE event = 'StopFailure'").first<{ subtype: string; detail: string }>();
    expect(event?.subtype).toBe("rate_limit");
    const detail = JSON.parse(event!.detail) as { error: string };
    expect(detail.error.startsWith("API Error: 429")).toBe(true);
    expect(detail.error.length).toBe(300);
    expect(event!.detail).not.toContain("never kept");
    let feed = await opsFeed(env as unknown as Env, new Date());
    expect(feed.live.sessions.find((s) => s.session_id === SESSION)).toMatchObject({ last_failure: "rate_limit", incident: "failure", job_id: DRIVER_JOB });
    await ok(DRIVER_KEY, { session_id: SESSION, hook_event_name: "Stop" });
    expect((await session())?.last_failure).toBeNull();
    feed = await opsFeed(env as unknown as Env, new Date());
    expect(feed.live.sessions.find((s) => s.session_id === SESSION)?.incident).toBeNull();
  });

  it("SessionEnd ends the session, and the feed stops listing it", async () => {
    await ok(DRIVER_KEY, start());
    await ok(DRIVER_KEY, { session_id: SESSION, hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
    const row = await session();
    expect(row?.ended_at).not.toBeNull();
    expect(row?.end_reason).toBe("prompt_input_exit");
    const feed = await opsFeed(env as unknown as Env, new Date());
    expect(feed.live.sessions.map((s) => s.session_id)).not.toContain(SESSION);
  });

  it("a body over 64KB is refused with 413 and nothing is written", async () => {
    const response = await hook(DRIVER_KEY, { ...start(), prompt: "x".repeat(HOOK_MAX_BYTES) });
    expect(response.status).toBe(413);
    expect(await sessionCount()).toBe(0);
  });

  it("an event this receiver does not record is refused with 400", async () => {
    const response = await hook(DRIVER_KEY, { session_id: SESSION, hook_event_name: "PreToolUse", tool_input: { command: "ls" } });
    expect(response.status).toBe(400);
    expect(await sessionCount()).toBe(0);
  });

  it("each call prunes session events older than 30 days, a bounded batch at a time", async () => {
    const old = iso(40 * 24 * HOUR);
    await env.DB.batch(
      Array.from({ length: 3 }, () =>
        env.DB.prepare("INSERT INTO session_events (session_id, job_id, agent, event, subtype, detail, at) VALUES ('old-session', NULL, 'agent:sample-driver', 'Stop', NULL, NULL, ?1)").bind(old)
      )
    );
    await ok(DRIVER_KEY, start());
    const left = await env.DB.prepare("SELECT session_id FROM session_events").all<{ session_id: string }>();
    expect(left.results.map((r) => r.session_id)).toEqual([SESSION]);
  });
});

describe("the feed's live sessions", () => {
  it("lists unended sessions seen in the last day, newest first, with a long wait for input as an incident", async () => {
    await ok(DRIVER_KEY, start());
    await ok(DRIVER_KEY, notify("permission_prompt"));
    await ok(RUNNER_KEY, start(RUNNER_SESSION));
    // The driver's session has waited fifteen minutes; a third session went quiet two days ago.
    await env.DB.batch([
      env.DB.prepare("UPDATE agent_sessions SET last_event_at = ?1 WHERE session_id = ?2").bind(iso(15 * 60_000), SESSION),
      env.DB.prepare(
        `INSERT INTO agent_sessions (session_id, agent, started_at, last_event_at, last_event, updated_at)
         VALUES ('5e55a0a1-0000-4000-8000-0000000000b3', 'agent:sample-driver', ?1, ?1, 'Stop', ?1)`
      ).bind(iso(48 * HOUR)),
    ]);
    const feed = await opsFeed(env as unknown as Env, new Date());
    expect(feed.live.sessions.map((s) => s.session_id)).toEqual([RUNNER_SESSION, SESSION]);
    expect(feed.live.sessions[1]).toMatchObject({ needs_input: true, incident: "waiting", last_notification_type: "permission_prompt", job_id: DRIVER_JOB });
    expect(feed.live.sessions[0]).toMatchObject({ needs_input: false, incident: null, job_id: RUNNER_JOB });
  });
});
