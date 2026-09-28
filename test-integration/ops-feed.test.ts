import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { consoleSessionCookie } from "../src/console-auth";
import type { Env } from "../src/env";
import { RESUME_MARKER } from "../src/jobs";
import { OPS_FEED_PATH, OPS_FEED_READS, OPS_REFRESH_PATH, opsFeed } from "../src/ops-feed";
import type { OpsFeed } from "../src/ops-types";
import { WATCHER_ACTOR } from "../src/watcher";

// The Watch Floor feed against a real D1 and KV: which rows each list keeps, and how
// many reads one request costs (src/ops-feed.ts states the count; this counts).

const ORIGIN = "https://capsid.test";
const SECRET = "integration-console-cookie-key";
const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const iso = (ms: number) => ago(ms).toISOString();
const sqlite = (ms: number) => ago(ms).toISOString().slice(0, 19).replace("T", " ");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function seedJob(id: string, over: { title?: string; status?: string; posted_by?: string; updated_at?: string; result_summary?: string | null }) {
  await env.DB.prepare(
    `INSERT INTO jobs (id, namespace, title, body, status, posted_by, result_summary, created_at, updated_at)
     VALUES (?1, 'sample', ?2, 'lorem body', ?3, ?4, ?5, ?6, ?6)`
  )
    .bind(id, over.title ?? `a job ${id}`, over.status ?? "queued", over.posted_by ?? "github:sample", over.result_summary ?? null, over.updated_at ?? iso(HOUR))
    .run();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM jobs"),
    env.DB.prepare("DELETE FROM job_outcome_prs"),
    env.DB.prepare("DELETE FROM audit_log WHERE action IN ('job-seat-started', 'runner-key-minted')"),
  ]);
  await seedJob("job_00000000000a", { status: "queued", updated_at: iso(10 * DAY) });
  await seedJob("job_00000000000b", {
    status: "blocked",
    result_summary: `waiting on the push\n\n${RESUME_MARKER}\n\n    git push -u origin feat/x`,
    updated_at: iso(5 * DAY),
  });
  // Ended inside the last day, once in each timestamp form the jobs table holds.
  await seedJob("job_00000000000c", { status: "done", updated_at: iso(2 * HOUR) });
  await seedJob("job_00000000000d", { status: "failed", updated_at: sqlite(3 * HOUR), posted_by: WATCHER_ACTOR, title: "Watcher: CI red [ci-red-abc1234]" });
  // Ended before it: left out, in both forms.
  await seedJob("job_00000000000e", { status: "done", updated_at: iso(3 * DAY) });
  await seedJob("job_00000000000f", { status: "superseded", updated_at: sqlite(2 * DAY) });

  await env.DB.batch([
    env.DB.prepare("INSERT INTO job_outcome_prs (job_id, pr_url, merged, recorded_at) VALUES ('job_00000000000c', 'https://github.com/example/sample/pull/1', 1, ?1)").bind(sqlite(DAY)),
    env.DB.prepare("INSERT INTO job_outcome_prs (job_id, pr_url, merged, recorded_at) VALUES ('job_00000000000c', 'https://github.com/example/sample/pull/2', NULL, ?1)").bind(sqlite(2 * HOUR)),
    env.DB.prepare("INSERT INTO job_outcome_prs (job_id, pr_url, merged, recorded_at) VALUES ('job_00000000000e', 'https://github.com/example/sample/pull/0', 0, ?1)").bind(sqlite(10 * DAY)),
  ]);
  // A start two days ago, outside the pending window, so sessionsInFlight reads no job.
  const start = await env.DB.prepare(
    `INSERT INTO audit_log (actor, action, namespace, path, params, at) VALUES ('access:admin@example.com', 'job-seat-started', 'sample', 'jobs/job_00000000000c.md', ?1, ?2) RETURNING id`
  )
    .bind(JSON.stringify({ job_id: "job_00000000000c", repo: "example/sample" }), sqlite(2 * DAY))
    .first<{ id: number }>();
  await env.DB.prepare(
    `INSERT INTO audit_log (actor, action, namespace, path, params, at) VALUES ('github-oidc:example/sample@77.1', 'runner-key-minted', 'sample', 'jobs/job_00000000000c.md', ?1, ?2)`
  )
    .bind(JSON.stringify({ job_id: "job_00000000000c", start_audit_id: start!.id, run_id: "77", run_url: "https://github.com/example/sample/actions/runs/77" }), sqlite(2 * DAY - 60_000))
    .run();
});

// The Worker's env, with every D1 prepare and APP_KV get counted.
function counted(): { env: Env; reads: { d1: string[]; kv: string[] } } {
  const reads = { d1: [] as string[], kv: [] as string[] };
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => (reads.d1.push(sql.replace(/\s+/g, " ").slice(0, 60)), target.prepare(sql));
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const kv = new Proxy(env.APP_KV, {
    get(target, prop) {
      if (prop === "get") return (key: string) => (reads.kv.push(key), target.get(key));
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { env: { ...(env as unknown as Env), DB: db, APP_KV: kv }, reads };
}

describe("the feed against real D1", () => {
  it("PLANT: one feed costs the reads src/ops-feed.ts states, and no more", async () => {
    const { env: e, reads } = counted();
    await opsFeed(e, NOW);
    expect(reads.d1.length, `D1 statements:\n${reads.d1.join("\n")}`).toBe(OPS_FEED_READS.d1);
    expect(reads.kv.length, `KV gets: ${reads.kv.join(", ")}`).toBe(OPS_FEED_READS.kv);
    // The count does not grow with the data: twice the jobs, the same reads.
    for (let i = 0; i < 6; i++) await seedJob(`job_1000000000${i}0`, { status: "queued" });
    const again = counted();
    await opsFeed(again.env, NOW);
    expect(again.reads.d1.length).toBe(OPS_FEED_READS.d1);
  });

  it("lists every open job and every job that ended in the last day, and nothing older", async () => {
    const feed = await opsFeed(env as unknown as Env, NOW);
    expect(feed.live.jobs.map((j) => j.id).sort()).toEqual(["job_00000000000a", "job_00000000000b", "job_00000000000c", "job_00000000000d"]);
    const blocked = feed.live.jobs.find((j) => j.id === "job_00000000000b")!;
    expect(blocked.waits_on).toBe("waiting on the push");
    expect(blocked.command).toBe("git push -u origin feat/x");
    const finding = feed.live.jobs.find((j) => j.id === "job_00000000000d")!;
    expect(finding.finding).toEqual({ fingerprint: "ci-red-abc1234" });
    expect(finding.updated_at, "a datetime('now') value is handed over as ISO").toMatch(/T.*Z$/);
  });

  it("lists pull requests from the last seven days with their three merge states, and the week's seat starts with their runs", async () => {
    const feed = await opsFeed(env as unknown as Env, NOW);
    expect(feed.live.prs.map((p) => [p.pr_url, p.merged])).toEqual([
      ["https://github.com/example/sample/pull/2", null],
      ["https://github.com/example/sample/pull/1", true],
    ]);
    expect(feed.live.seat_start.recent).toEqual([
      expect.objectContaining({ job_id: "job_00000000000c", namespace: "sample", run_id: 77, run_url: "https://github.com/example/sample/actions/runs/77" }),
    ]);
    expect(feed.live.seat_start.in_flight).toBe(0);
    expect(feed.cloudflare_configured).toBe(false);
    expect(feed.refresh_allowed_at).toBeNull();
  });
});

async function signedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const cookie = (await consoleSessionCookie({ email: "admin@example.com" }, SECRET, new Date())).split(";")[0];
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookie);
  const ctx = createExecutionContext();
  const response = await worker.fetch!(new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" }) as never, { ...env, COOKIE_ENCRYPTION_KEY: SECRET } as never, ctx);
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}

describe("the feed's routes through the Worker", () => {
  it("serves a signed-in administrator the feed, uncached", async () => {
    const response = await signedFetch(OPS_FEED_PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const feed = (await response.json()) as OpsFeed;
    expect(feed.live.jobs.length).toBe(4);
  });

  it("refuses a bearer with 403 and sends an anonymous caller to sign in", async () => {
    for (const [path, method] of [[OPS_FEED_PATH, "GET"], [OPS_REFRESH_PATH, "POST"]] as const) {
      const bearer = await SELF.fetch(`${ORIGIN}${path}`, { method, headers: { Authorization: "Bearer capsid_agent_x", "X-Capsid-Ops": "refresh" } });
      expect(bearer.status, path).toBe(403);
      const anonymous = await SELF.fetch(`${ORIGIN}${path}`, { method, headers: { "X-Capsid-Ops": "refresh" }, redirect: "manual" });
      expect(anonymous.status, path).toBe(302);
    }
  });

  it("refuses a signed-in refresh without the same-origin header, before any pass", async () => {
    const response = await signedFetch(OPS_REFRESH_PATH, { method: "POST" });
    expect(response.status).toBe(403);
    expect(await env.APP_KV.get("ops:refresh:last")).toBeNull();
  });

  it("/console.json answers 301 to /console/json, and /console/json is behind the gate", async () => {
    const moved = await SELF.fetch(`${ORIGIN}/console.json?namespace=sample`, { redirect: "manual" });
    expect(moved.status).toBe(301);
    expect(moved.headers.get("Location")).toBe("/console/json?namespace=sample");
    const anonymous = await SELF.fetch(`${ORIGIN}/console/json`, { redirect: "manual" });
    expect(anonymous.status).toBe(302);
    const signed = await signedFetch("/console/json");
    expect(signed.status).toBe(200);
    expect(((await signed.json()) as { viewer: string }).viewer).toBe("admin@example.com");
  });
});
