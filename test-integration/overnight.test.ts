import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { adminAgentForEmail } from "../src/agents";
import { improveStatus } from "../src/improve-run";
import { OVERNIGHT_DECISION_KEY, OVERNIGHT_MODE_KEY, setOvernight } from "../src/overnight";
import { readOvernightDigest, readOvernightPlan } from "../src/overnight-plan";
import { buildServer } from "../src/server";

// The overnight plan and digest against a real D1: the statements run on SQLite, the
// json_extract over job_claims.raw and the UNION subquery are real, and the plan is built
// over rows the queue wrote. The pure rules are in test/overnight.test.ts. job_claims
// refuses DELETE once it holds a row, so nothing here empties tables: every assertion is
// scoped to the namespaces and job ids this file plants.

const ADMIN = adminAgentForEmail("admin@example.com");
const NOW = new Date("2026-10-05T12:00:00.000Z");

let seq = 0;
function fresh(prefix: string): { ns: string; id: (n: number) => string } {
  seq += 1;
  const tag = `${Date.now().toString(16)}${seq.toString(16)}`.slice(-10).padStart(10, "0");
  return { ns: `${prefix}-${tag}`, id: (n) => `job_${tag}${String(n).padStart(2, "0")}` };
}

async function mapNamespace(ns: string, repo: string): Promise<void> {
  await env.DB.prepare("INSERT INTO namespaces (namespace, repos) VALUES (?1, ?2)").bind(ns, JSON.stringify([{ repo, label: "primary" }])).run();
}

async function queue(id: string, ns: string, over: { priority?: number; gate?: number; title?: string } = {}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO jobs (id, namespace, title, body, status, priority, gate_required, posted_by) VALUES (?1, ?2, ?3, 'body', 'queued', ?4, ?5, 'github:sample')`
  )
    .bind(id, ns, over.title ?? `Job ${id}`, over.priority ?? 50, over.gate ?? 0)
    .run();
}

describe("the overnight plan on a real D1", () => {
  it("plans the gate-free queued jobs of a mapped namespace in priority order, skips the rest with reasons, and counts what it read", async () => {
    const { ns, id } = fresh("night");
    await mapNamespace(ns, "example/night");
    await queue(id(1), ns, { priority: 10 });
    await queue(id(2), ns, { priority: 90 });
    await queue(id(3), ns, { gate: 1 });
    await queue(id(4), ns, { title: "LATER (after the reset): something" });
    const plan = await readOvernightPlan(env as never, { namespace: ns }, NOW);
    expect(plan.for_namespace).toBe(ns);
    expect(plan.lanes).toHaveLength(1);
    expect(plan.lanes[0].repo).toBe("example/night");
    expect(plan.lanes[0].jobs.map((j) => j.id)).toEqual([id(2), id(1)]);
    expect(plan.skipped.map((s) => s.id).sort()).toEqual([id(3), id(4)].sort());
    // With no policy document every repo is heavy, said aloud.
    expect(plan.policy).toBe("default");
    expect(plan.queued_read).toBeGreaterThanOrEqual(4);
  });

  it("a parked job is neither planned nor listed as skipped: parking takes it out of the queue the plan reads", async () => {
    const { ns, id } = fresh("parked");
    await mapNamespace(ns, "example/parked");
    await queue(id(1), ns, { priority: 10 });
    await queue(id(2), ns, { priority: 90 });
    await env.DB.prepare("UPDATE jobs SET status = 'parked' WHERE id = ?1").bind(id(2)).run();
    const plan = await readOvernightPlan(env as never, { namespace: ns }, NOW);
    expect(plan.lanes[0].jobs.map((j) => j.id)).toEqual([id(1)]);
    expect(plan.skipped.map((s) => s.id)).not.toContain(id(2));
  });

  it("a namespace with no mapping has its jobs skipped, naming why", async () => {
    const { ns, id } = fresh("nomap");
    await queue(id(1), ns);
    const plan = await readOvernightPlan(env as never, { namespace: ns }, NOW);
    expect(plan.lanes).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/unknown namespace/);
  });

  it("a caller scoped to one namespace reads only that namespace's plan, through the jobs tool", async () => {
    const { ns, id } = fresh("scoped");
    await mapNamespace(ns, "example/scoped");
    await queue(id(1), ns);
    const server = buildServer(env as never, ADMIN);
    const client = new Client({ name: "overnight", version: "1.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      const result = (await client.callTool({ name: "jobs", arguments: { action: "list", view: "plan", namespace: ns } })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError, result.content[0].text).not.toBe(true);
      const plan = JSON.parse(result.content[0].text) as { lanes: Array<{ jobs: Array<{ id: string }> }>; for_namespace: string };
      expect(plan.for_namespace).toBe(ns);
      expect(plan.lanes[0].jobs.map((j) => j.id)).toEqual([id(1)]);
      const bad = (await client.callTool({ name: "jobs", arguments: { action: "list", view: "digest", since: "yesterday" } })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toMatch(/since must be an ISO 8601 time/);
    } finally {
      await client.close();
    }
  });
});

describe("the morning digest on a real D1", () => {
  it("lists finished jobs with usage from telemetry or the agent's report, what blocked, and the pull requests ready", async () => {
    const { ns, id } = fresh("morning");
    const at = "2026-10-05T03:00:00.000Z";
    const since = "2026-10-05T00:00:00.000Z";
    const job = (n: number, status: string, summary: string | null = null) =>
      env.DB.prepare(`INSERT INTO jobs (id, namespace, title, body, status, posted_by, result_summary, updated_at) VALUES (?1, ?2, ?3, 'body', ?4, 'github:sample', ?5, ?6)`).bind(id(n), ns, `Job ${n}`, status, summary, at);
    const outcome = (n: number, cost: number | null) =>
      env.DB.prepare(
        `INSERT INTO job_outcomes (job_id, agent, namespace, blocked_count, resumed_count, duration_minutes, result_kind, verified, recorded_at, cost_usd, active_seconds)
         VALUES (?1, 'agent:sample-driver', ?2, 0, 0, 12, 'pr', '{}', ?3, ?4, ?5)`
      ).bind(id(n), ns, at, cost, cost === null ? null : 300);
    const claim = (n: number, usage: object | null, action = "complete") =>
      env.DB.prepare(`INSERT INTO job_claims (job_id, action, agent, namespace, raw, recorded_at) VALUES (?1, ?2, 'agent:sample-driver', ?3, ?4, ?5)`).bind(id(n), action, ns, JSON.stringify(usage ? { claim: { usage } } : { claim: {} }), at);
    await env.DB.batch([
      job(1, "done"),
      job(2, "done"),
      job(3, "done"),
      job(4, "blocked", "Opened https://github.com/example/sample/pull/41.\n\nRun this: merge it"),
      outcome(1, 2.5),
      outcome(2, null),
      outcome(3, null),
      claim(2, { cost_usd: 1.25, active_seconds: 90 }),
      claim(3, null),
      // The blocked job's two sessions reported usage; claims on a job are summed.
      claim(4, { cost_usd: 0.5 }, "block"),
      env.DB.prepare(`INSERT INTO job_outcome_prs (job_id, pr_url, merged) VALUES (?1, 'https://github.com/example/sample/pull/40', 0)`).bind(id(1)),
      env.DB.prepare(`INSERT INTO job_outcome_prs (job_id, pr_url, merged) VALUES (?1, 'https://github.com/example/sample/pull/39', 1)`).bind(id(1)),
    ]);
    const out = await readOvernightDigest(env as never, { namespace: ns, since }, NOW);
    expect(out.truncated).toEqual([]);
    const by = Object.fromEntries(out.finished.map((j) => [j.id, j]));
    expect([by[id(1)].usage_source, by[id(1)].usage.cost_usd]).toEqual(["telemetry", 2.5]);
    expect([by[id(2)].usage_source, by[id(2)].usage.cost_usd, by[id(2)].usage.active_seconds]).toEqual(["reported", 1.25, 90]);
    expect([by[id(3)].usage_source, by[id(3)].usage.cost_usd]).toEqual(["none", null]);
    expect(out.blocked.map((b) => [b.id, b.usage_source, b.usage.cost_usd])).toEqual([[id(4), "reported", 0.5]]);
    expect(out.blocked[0].pull_requests).toEqual(["https://github.com/example/sample/pull/41"]);
    expect(out.pull_requests_ready.map((p) => [p.url.split("/").pop(), p.state, p.source])).toEqual([
      ["40", "open", "outcome"],
      ["41", "unchecked", "blocked summary"],
    ]);
    expect(out.pull_requests_merged).toBe(1);
    // Per source, never added: the telemetry job's report would not have counted either.
    expect([out.totals.telemetry.jobs, out.totals.telemetry.cost_usd]).toEqual([1, 2.5]);
    expect([out.totals.reported.jobs, out.totals.reported.cost_usd]).toEqual([2, 1.75]);
    expect(out.totals.jobs_without_usage).toBe(1);
  });

  it("a window with nothing in it is empty, not an error", async () => {
    const { ns } = fresh("quiet");
    const out = await readOvernightDigest(env as never, { namespace: ns, since: "2030-01-01T00:00:00.000Z" }, NOW);
    expect(out.finished).toEqual([]);
    expect(out.blocked).toEqual([]);
    expect(out.pull_requests_ready).toEqual([]);
    expect(out.totals.jobs_without_usage).toBe(0);
  });
});

describe("the overnight switch on a real KV", () => {
  it("setOvernight stores the mode and the decision, improve_status reports them, and leaving the subscription removes the record", async () => {
    await env.APP_KV.delete(OVERNIGHT_MODE_KEY);
    await env.APP_KV.delete(OVERNIGHT_DECISION_KEY);
    expect((await improveStatus(env as never, "capsid")).overnight).toEqual({ mode: "off", decision: null });
    const set = await setOvernight(env as never, "access:admin@example.com", NOW, { value: "subscription", reason: "first supervised night" });
    expect(set.mode).toBe("subscription");
    const status = await improveStatus(env as never, "capsid");
    expect(status.overnight.mode).toBe("subscription");
    expect(status.overnight.decision?.decided_on).toBe("2026-10-04");
    expect(status.overnight.decision?.reason).toBe("first supervised night");
    await setOvernight(env as never, "access:admin@example.com", NOW, { value: "off", reason: "done" });
    expect(await env.APP_KV.get(OVERNIGHT_DECISION_KEY)).toBeNull();
    expect((await improveStatus(env as never, "capsid")).overnight).toEqual({ mode: "off", decision: null });
  });
});
