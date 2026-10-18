import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BENCH_ENABLED_KEY, BENCH_MAX_RUNNING } from "../src/bench";

// The paired comparison's three signed endpoints (src/bench.ts) against a real D1 and
// KV: the task freeze, the off switch, the running cap's single-statement INSERT, the
// close-once UPDATE and the triggers of migrations/0047 are only true of real SQLite.
// The key is derived here the way the Worker derives it, from the root the config binds.

const ROOT = "integration-root-secret-not-a-real-one";

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The derivation as src/improve-scorer.ts spells it: a contract with the bench repo.
const benchKey = () => hmacHex(ROOT, "capsid-bench:v1");

async function post(path: string, body: Record<string, unknown>, key?: string) {
  const text = JSON.stringify({ jti: crypto.randomUUID(), ...body });
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return SELF.fetch(`https://capsid.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bench-Timestamp": ts, "X-Bench-Signature": await hmacHex(key ?? (await benchKey()), `${ts}.${text}`) },
    body: text,
  });
}

let n = 0;
async function registerTask(over: Record<string, unknown> = {}): Promise<string> {
  const task_id = `sample__repo-${++n}-${crypto.randomUUID().slice(0, 8)}`;
  const response = await post("/bench/tasks", {
    task: { task_id, source: "swe-rebench", split: "pilot", repo: "sample/repo", issue_created_at: "2026-07-15T00:00:00Z", fail_to_pass_count: 2, pass_to_pass_count: 3, ...over },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return task_id;
}

async function start(task_id: string, arm = "baseline"): Promise<Response> {
  return post("/bench/start", { task_id, arm, gh_run: "123.1" });
}

async function startOk(task_id: string, arm = "baseline"): Promise<string> {
  const response = await start(task_id, arm);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { run_id: string }).run_id;
}

const counts = (f2p: number, p2p: number, f2pTotal = 2, p2pTotal = 3) => ({
  fail_to_pass: { total: f2pTotal, passed: f2p },
  pass_to_pass: { total: p2pTotal, passed: p2p },
});

async function score(run_id: string, body: Record<string, unknown>) {
  return post("/bench/score", { run_id, ...body });
}

describe("bench endpoints", () => {
  it("refuse a request signed with an improve score key", async () => {
    const scoreKey = await hmacHex(ROOT, "capsid-improve-score:v1:capsid");
    const response = await post("/bench/start", { task_id: "x", arm: "baseline", gh_run: "1.1" }, scoreKey);
    expect(response.status).toBe(401);
  });

  it("register a task once: the same registration again is a no-op, a different one is refused", async () => {
    const task_id = await registerTask();
    const same = await post("/bench/tasks", {
      task: { task_id, source: "swe-rebench", split: "pilot", repo: "sample/repo", issue_created_at: "2026-07-15T00:00:00Z", fail_to_pass_count: 2, pass_to_pass_count: 3 },
    });
    expect(await same.json()).toMatchObject({ registered: false });
    const changed = await post("/bench/tasks", {
      task: { task_id, source: "swe-rebench", split: "pilot", repo: "sample/repo", issue_created_at: "2026-07-15T00:00:00Z", fail_to_pass_count: 1, pass_to_pass_count: 3 },
    });
    expect(changed.status).toBe(409);
    expect(await changed.text()).toMatch(/fail_to_pass_count/);
  });

  it("start nothing unless bench:enabled reads exactly on", async () => {
    const task_id = await registerTask();
    await env.APP_KV.delete(BENCH_ENABLED_KEY);
    expect((await start(task_id)).status).toBe(403);
    await env.APP_KV.put(BENCH_ENABLED_KEY, "true");
    expect((await start(task_id)).status).toBe(403);
    await env.APP_KV.put(BENCH_ENABLED_KEY, "on");
    expect((await start(task_id)).status).toBe(200);
  });

  it("hold at most the cap of runs at once, and free a slot when one closes", async () => {
    await env.APP_KV.put(BENCH_ENABLED_KEY, "on");
    const task_id = await registerTask();
    const opened: string[] = [];
    // Earlier tests may hold slots; fill whatever is left, then expect a refusal.
    for (let i = 0; i <= BENCH_MAX_RUNNING; i++) {
      const response = await start(task_id);
      if (response.status === 429) break;
      expect(response.status).toBe(200);
      opened.push(((await response.json()) as { run_id: string }).run_id);
    }
    expect((await start(task_id)).status).toBe(429);
    const running = await env.DB.prepare("SELECT COUNT(*) AS n FROM bench_runs WHERE status = 'running'").first<{ n: number }>();
    expect(running?.n).toBe(BENCH_MAX_RUNNING);
    // Close every running row, this test's and earlier ones', so later tests start clean.
    const { results } = await env.DB.prepare("SELECT id FROM bench_runs WHERE status = 'running'").all<{ id: string }>();
    for (const row of results) expect((await score(row.id, { environment: { ok: false, reason: "test cleanup" } })).status).toBe(200);
    expect((await start(task_id)).status).toBe(200);
    await env.DB.prepare("UPDATE bench_runs SET status = 'unjudged', unjudged_reason = 'test cleanup' WHERE status = 'running'").run();
  });

  it("score a baseline: a done claim with a failing hidden test is a false claim, and a run closes once", async () => {
    await env.APP_KV.put(BENCH_ENABLED_KEY, "on");
    const task_id = await registerTask();
    const run_id = await startOk(task_id);
    const response = await score(run_id, { hidden: counts(1, 3), claimed_done: true, usage: { model: "claude-sonnet-5-5", cost_usd: 1.25, turns: 40 } });
    expect(await response.json()).toMatchObject({ status: "scored", claimed_done: true, resolved: false, false_claim: true });
    const row = await env.DB.prepare("SELECT status, false_claim, resolved, cost_usd, turns FROM bench_runs WHERE id = ?1").bind(run_id).first();
    expect(row).toMatchObject({ status: "scored", false_claim: 1, resolved: 0, cost_usd: 1.25, turns: 40 });
    expect((await score(run_id, { hidden: counts(2, 3), claimed_done: true })).status).toBe(409);
    // The trigger holds even against a direct write.
    await expect(env.DB.prepare("UPDATE bench_runs SET false_claim = 0 WHERE id = ?1").bind(run_id).run()).rejects.toThrow(/never changes/);
  });

  it("leave a run unjudged when the hidden suite's size disagrees with the registered size", async () => {
    await env.APP_KV.put(BENCH_ENABLED_KEY, "on");
    const run_id = await startOk(await registerTask());
    const response = await score(run_id, { hidden: counts(1, 3, 1, 3), claimed_done: true });
    expect(await response.json()).toMatchObject({ status: "unjudged" });
    const row = await env.DB.prepare("SELECT false_claim, resolved, unjudged_reason FROM bench_runs WHERE id = ?1").bind(run_id).first();
    expect(row).toMatchObject({ false_claim: null, resolved: null });
  });

  it("read the treatment's claim from its own job row, not from the report", async () => {
    await env.APP_KV.put(BENCH_ENABLED_KEY, "on");
    const task_id = await registerTask();
    const run_id = await startOk(task_id, "treatment");
    const job = "job_0123456789ab";
    await env.DB.prepare(
      "INSERT INTO jobs (id, namespace, title, body, status, posted_by, claimed_by) VALUES (?1, 'bench', ?2, 'body', 'failed', 'github:sample', 'agent:bench')"
    )
      .bind(job, `bench ${task_id} ${run_id}`)
      .run();
    // The report says done; the job says failed, so this is no claim and no false claim.
    const response = await score(run_id, { hidden: counts(0, 3), claimed_done: true, capsid_job_id: job });
    expect(await response.json()).toMatchObject({ status: "scored", claimed_done: false, false_claim: false });
  });

  it("keep a task with a run frozen against deletion", async () => {
    await env.APP_KV.put(BENCH_ENABLED_KEY, "on");
    const task_id = await registerTask();
    const run_id = await startOk(task_id);
    await score(run_id, { environment: { ok: false, reason: "test cleanup" } });
    await expect(env.DB.prepare("DELETE FROM bench_tasks WHERE task_id = ?1").bind(task_id).run()).rejects.toThrow(/frozen/);
  });
});
