import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockJob, claimJob, postJob, resumeJob } from "../src/jobs";
import { legacyAgent, type Agent } from "../src/agents";
import { defaultScopes } from "../src/agents-schema";
import {
  PENDING_START_MINUTES,
  SEAT_START_CAP_KEY,
  SEAT_START_EVENT,
  SEAT_START_KEY,
  sessionsInFlight,
  setSeatStart,
  startSeatSession,
} from "../src/seat-start";

// Starting a Claude Code session on GitHub's runners for one queued job, against a
// real D1, with GitHub stubbed at fetch: the repo's visibility and the dispatch.

const SECRET = "test-root-secret";
const REPO = "example/capsid";
const NOW = new Date("2026-09-26T20:00:00.000Z");
const POSTER = legacyAgent("write", "github:DrDustinEdwards");

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

function seatAgent(): Agent {
  const scopes = defaultScopes(["capsid", "foxing"]);
  scopes.grants = ["read", "write"];
  scopes.flags.can_merge = true;
  return { id: "agent_seat", name: "seat", kind: "seat", actor: "agent:seat", scopes, admin: false, row: null };
}

function scopedAgent(name: string, kind: Agent["kind"]): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  return { id: `agent_${name}`, name, kind, actor: `agent:${name}`, scopes, admin: false, row: null };
}

// A fake GitHub: the repo's visibility, and the dispatches it received.
function github(opts: { private?: boolean; dispatchStatus?: number } = {}) {
  const dispatches: Array<{ event_type: string; client_payload: { job_id: string } }> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === `/repos/${REPO}` && (init?.method ?? "GET") === "GET") return json({ full_name: REPO, private: opts.private ?? false });
    if (url.pathname === `/repos/${REPO}/dispatches`) {
      dispatches.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: opts.dispatchStatus ?? 204 });
    }
    return new Response("not modelled", { status: 404 });
  });
  return dispatches;
}

async function queued(title: string, namespace = "capsid") {
  const posted = await postJob(jobsEnv(), POSTER, NOW, { namespace, title, body: "do the thing" });
  expect(posted.ok, posted.refusal).toBe(true);
  return posted.job!.id;
}

async function seedRunner(name: string) {
  await env.DB.prepare(
    `INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at)
     VALUES (?1, ?2, 'session', ?3, ?4, 'github:DrDustinEdwards', '2026-09-26 00:00:00')`
  )
    .bind(`agent_${name}`, name, `hash-${name}`, JSON.stringify({ namespaces: ["capsid"], repos: [REPO], tools: "*", grants: ["read", "write"], flags: {} }))
    .run();
}

beforeEach(async () => {
  for (const table of ["jobs", "audit_log", "job_outcomes", "agents"]) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
  for (const ns of ["capsid", "foxing"]) {
    await env.DB.prepare("INSERT OR REPLACE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
      .bind(ns, JSON.stringify([{ repo: ns === "capsid" ? REPO : "example/foxing", label: "primary" }]))
      .run();
  }
  await env.APP_KV.delete(SEAT_START_KEY);
  await env.APP_KV.delete(SEAT_START_CAP_KEY);
  // The installation token, cached as the client caches it, so no App JWT is minted.
  await env.APP_KV.put(`gh:token:v3:${REPO}`, "test-token");
  const cached = await env.APP_KV.list({ prefix: "gh:get:" });
  for (const key of cached.keys) await env.APP_KV.delete(key.name);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the switch", () => {
  it("ships off: with the key unset, a start is refused and nothing is dispatched", async () => {
    const dispatches = github();
    const id = await queued("a job");
    const refused = await startSeatSession(jobsEnv(), seatAgent(), NOW, id);
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/switched off/);
    expect(dispatches).toEqual([]);
  });

  it("any value but on is off", async () => {
    const dispatches = github();
    await env.APP_KV.put(SEAT_START_KEY, "yes");
    expect((await startSeatSession(jobsEnv(), seatAgent(), NOW, await queued("a job"))).refusal).toMatch(/switched off/);
    expect(dispatches).toEqual([]);
  });

  it("setSeatStart turns it on, sets the cap, audits both, and refuses other values", async () => {
    expect(await setSeatStart(jobsEnv(), "github:DrDustinEdwards", { value: "on", max_sessions: 2 })).toEqual({ action: "seat_start", enabled: true, max_sessions: 2 });
    const audit = await env.DB.prepare("SELECT actor, params FROM audit_log WHERE action = 'seat-start-set'").first<{ actor: string; params: string }>();
    expect(audit?.actor).toBe("github:DrDustinEdwards");
    expect(JSON.parse(audit!.params)).toEqual({ enabled: true, max_sessions: 2 });
    await expect(setSeatStart(jobsEnv(), "x", { value: "yes" })).rejects.toThrow(/"on" or "off"/);
    await expect(setSeatStart(jobsEnv(), "x", { max_sessions: 3 })).rejects.toThrow(/1 or 2/);
  });
});

describe("a start", () => {
  beforeEach(async () => {
    await env.APP_KV.put(SEAT_START_KEY, "on");
  });

  it("dispatches the job id to the namespace's public repo and records the start", async () => {
    const dispatches = github();
    const id = await queued("a job");
    const started = await startSeatSession(jobsEnv(), seatAgent(), NOW, id);
    expect(started.ok, started.refusal).toBe(true);
    expect(dispatches).toEqual([{ event_type: SEAT_START_EVENT, client_payload: { job_id: id } }]);
    const audit = await env.DB.prepare("SELECT actor, params FROM audit_log WHERE action = 'job-seat-started'").first<{ actor: string; params: string }>();
    expect(audit?.actor).toBe("agent:seat");
    expect(JSON.parse(audit!.params)).toMatchObject({ job_id: id, repo: REPO });
  });

  it("is the seat's act: a driver is refused", async () => {
    const dispatches = github();
    const refused = await startSeatSession(jobsEnv(), scopedAgent("capsid-driver", "driver"), NOW, await queued("a job"));
    expect(refused.refusal).toMatch(/seat's act/);
    expect(dispatches).toEqual([]);
  });

  it("refuses a repo that is not public, read from GitHub at the start", async () => {
    const dispatches = github({ private: true });
    const refused = await startSeatSession(jobsEnv(), seatAgent(), NOW, await queued("a job"));
    expect(refused.refusal).toMatch(/not public/);
    expect(dispatches).toEqual([]);
  });

  it("refuses a namespace not on the list, and a job that is not queued", async () => {
    const dispatches = github();
    expect((await startSeatSession(jobsEnv(), seatAgent(), NOW, await queued("elsewhere", "foxing"))).refusal).toMatch(/not one of the namespaces/);
    const id = await queued("taken");
    await claimJob(jobsEnv(), scopedAgent("capsid-driver", "driver"), NOW, { id });
    expect((await startSeatSession(jobsEnv(), seatAgent(), NOW, id)).refusal).toMatch(/not queued/);
    expect(dispatches).toEqual([]);
  });

  it("one session per repo: a second start while the first is pending is refused", async () => {
    const dispatches = github();
    await env.APP_KV.put(SEAT_START_CAP_KEY, "2");
    expect((await startSeatSession(jobsEnv(), seatAgent(), NOW, await queued("first"))).ok).toBe(true);
    const second = await startSeatSession(jobsEnv(), seatAgent(), NOW, await queued("second"));
    expect(second.refusal).toMatch(/already in flight/);
    expect(dispatches).toHaveLength(1);
  });

  it("a runner's claim counts as in flight; a start older than the window no longer does", async () => {
    github();
    await seedRunner("capsid-runner");
    const id = await queued("worked by a runner");
    await claimJob(jobsEnv(), scopedAgent("capsid-runner", "session"), NOW, { id });
    expect(await sessionsInFlight(jobsEnv(), NOW)).toEqual([{ job_id: id, namespace: "capsid", how: "claimed" }]);

    await env.DB.prepare("DELETE FROM jobs").run();
    const stale = await queued("dispatched long ago");
    await env.DB.prepare("INSERT INTO audit_log (actor, action, namespace, path, params, at) VALUES ('agent:seat', 'job-seat-started', 'capsid', ?1, ?2, ?3)")
      .bind(`jobs/${stale}.md`, JSON.stringify({ job_id: stale }), "2026-09-26 19:00:00")
      .run();
    expect(await sessionsInFlight(jobsEnv(), NOW), `a start more than ${PENDING_START_MINUTES} minutes old still counted`).toEqual([]);
  });
});

describe("a runner's blocked job", () => {
  it("resumes to the queue, not to the runner whose session has ended", async () => {
    await seedRunner("capsid-runner");
    const runner = scopedAgent("capsid-runner", "session");
    const id = await queued("worked by a runner");
    await claimJob(jobsEnv(), runner, NOW, { id });
    await blockJob(jobsEnv(), runner, NOW, id, { reason: "PR open", command: "Merge the PR" });
    const resumed = await resumeJob(jobsEnv(), seatAgent(), NOW, id, "merged");
    expect(resumed.ok, resumed.refusal).toBe(true);
    const row = await env.DB.prepare("SELECT status, claimed_by FROM jobs WHERE id = ?1").bind(id).first<{ status: string; claimed_by: string | null }>();
    expect(row).toEqual({ status: "queued", claimed_by: null });
    expect(resumed.note).toMatch(/seat-started runner/);
  });
});
