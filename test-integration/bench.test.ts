import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BENCH_ENABLED_KEY, BENCH_MAX_RUNNING, BENCH_REPEATS } from "../src/bench";

// The paired comparison's three signed endpoints (src/bench.ts) against a real D1 and
// KV: the task freeze, the off switch, the running cap's single-statement INSERT, the
// close-once UPDATE and the triggers of migrations/0047 are only true of real SQLite.
// The bench key is the BENCH_SECRET the config binds, used as is; ROOT signs the
// improve-key request the wrong-key test sends.

const ROOT = "integration-root-secret-not-a-real-one";

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const benchKey = async () => "integration-bench-secret-not-a-real-one";

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
    // Earlier tests may hold slots; fill whatever is left, then expect a refusal. A
    // planted arm, so the per-task repeat cap does not refuse first.
    for (let i = 0; i <= BENCH_MAX_RUNNING; i++) {
      const response = await start(task_id, "check-gold");
      if (response.status === 429) break;
      expect(response.status).toBe(200);
      opened.push(((await response.json()) as { run_id: string }).run_id);
    }
    expect((await start(task_id, "check-gold")).status).toBe(429);
    const running = await env.DB.prepare("SELECT COUNT(*) AS n FROM bench_runs WHERE status = 'running'").first<{ n: number }>();
    expect(running?.n).toBe(BENCH_MAX_RUNNING);
    // Close every running row, this test's and earlier ones', so later tests start clean.
    const { results } = await env.DB.prepare("SELECT id FROM bench_runs WHERE status = 'running'").all<{ id: string }>();
    for (const row of results) expect((await score(row.id, { environment: { ok: false, reason: "test cleanup" } })).status).toBe(200);
    expect((await start(task_id)).status).toBe(200);
    await env.DB.prepare("UPDATE bench_runs SET status = 'unjudged', unjudged_reason = 'test cleanup' WHERE status = 'running'").run();
  });

  it("give each model arm its slots per task, rerun a slot only after an unjudged attempt, and never cap the planted arms", async () => {
    await env.APP_KV.put(BENCH_ENABLED_KEY, "on");
    const task_id = await registerTask();
    const startSlot = async (arm = "baseline") => {
      const response = await start(task_id, arm);
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as { run_id: string; slot: number; attempt: number };
    };
    // Slot 1 comes back unjudged, so its rerun is the next start; slot 2 scores.
    const first = await startSlot();
    expect(first).toMatchObject({ slot: 1, attempt: 1 });
    expect((await score(first.run_id, { environment: { ok: false, reason: "machine failure" } })).status).toBe(200);
    const rerun = await startSlot();
    expect(rerun).toMatchObject({ slot: 1, attempt: 2 });
    expect((await score(rerun.run_id, { hidden: counts(2, 3), claimed_done: true })).status).toBe(200);
    const second = await startSlot();
    expect(second).toMatchObject({ slot: 2, attempt: 1 });
    expect((await score(second.run_id, { hidden: counts(1, 3), claimed_done: true })).status).toBe(200);
    // Slot 3 is still running, so it holds its slot and nothing else may start.
    const third = await startSlot();
    expect(third).toMatchObject({ slot: 3, attempt: 1 });
    const full = await start(task_id);
    expect(full.status).toBe(409);
    expect(await full.text()).toMatch(/has used its baseline runs/);
    // The other arm on the same task has its own slots, and the planted arms none.
    expect(await startSlot("treatment")).toMatchObject({ slot: 1, attempt: 1 });
    await env.DB.prepare("UPDATE bench_runs SET status = 'unjudged', unjudged_reason = 'test cleanup' WHERE status = 'running'").run();
    for (let i = 0; i < BENCH_REPEATS + 1; i++) {
      const planted = await start(task_id, "check-gold");
      expect(planted.status).toBe(200);
      expect(await planted.json()).not.toHaveProperty("slot");
    }
    await env.DB.prepare("UPDATE bench_runs SET status = 'unjudged', unjudged_reason = 'test cleanup' WHERE status = 'running'").run();
  });

  it("close a stale running row as unjudged before its rerun opens, and refuse its late score", async () => {
    await env.APP_KV.put(BENCH_ENABLED_KEY, "on");
    const task_id = await registerTask();
    const stale = await startOk(task_id);
    await env.DB.prepare("UPDATE bench_runs SET started_at = '2026-01-01T00:00:00Z' WHERE id = ?1").bind(stale).run();
    const rerun = await start(task_id);
    expect(await rerun.json()).toMatchObject({ slot: 1, attempt: 2 });
    const row = await env.DB.prepare("SELECT status, unjudged_reason FROM bench_runs WHERE id = ?1").bind(stale).first<{ status: string; unjudged_reason: string }>();
    expect(row?.status).toBe("unjudged");
    expect(row?.unjudged_reason).toMatch(/stale window/);
    expect((await score(stale, { hidden: counts(2, 3), claimed_done: true })).status).toBe(409);
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

  it("read the treatment's claim from the report, not from its job row", async () => {
    await env.APP_KV.put(BENCH_ENABLED_KEY, "on");
    const task_id = await registerTask();
    const run_id = await startOk(task_id, "treatment");
    const job = "job_0123456789ab";
    await env.DB.prepare(
      "INSERT INTO jobs (id, namespace, title, body, status, posted_by, claimed_by) VALUES (?1, 'bench', ?2, 'body', 'failed', 'github:sample', 'agent:bench')"
    )
      .bind(job, `bench ${task_id} ${run_id}`)
      .run();
    // The report's claim file says done and the job says failed: the claim is done, and
    // with the hidden tests failing, a false claim.
    const response = await score(run_id, { hidden: counts(0, 3), claimed_done: true, capsid_job_id: job });
    expect(await response.json()).toMatchObject({ status: "scored", claimed_done: true, false_claim: true });
  });

  it("score a stop on an error the first time, and move on to the next slot", async () => {
    await env.APP_KV.put(BENCH_ENABLED_KEY, "on");
    const task_id = await registerTask();
    const first = await startOk(task_id);
    expect(await (await score(first, { hidden: counts(0, 3), claimed_done: false, stopped_on_error: true })).json()).toMatchObject({
      status: "scored",
      claimed_done: false,
      resolved: false,
    });
    expect(await (await start(task_id)).json()).toMatchObject({ slot: 2, attempt: 1 });
  });

  it("keep a task with a run frozen against deletion", async () => {
    await env.APP_KV.put(BENCH_ENABLED_KEY, "on");
    const task_id = await registerTask();
    const run_id = await startOk(task_id);
    await score(run_id, { environment: { ok: false, reason: "test cleanup" } });
    await expect(env.DB.prepare("DELETE FROM bench_tasks WHERE task_id = ?1").bind(task_id).run()).rejects.toThrow(/frozen/);
  });

  // Last, because it leaves this hour an outage hour for the rest of the file.
  it("start no model run in an outage hour", async () => {
    await env.APP_KV.put(BENCH_ENABLED_KEY, "on");
    const task_id = await registerTask();
    // Other tests in this file end runs this hour too, so add error stops until at
    // least half of this hour's ended model runs stopped on an error.
    const hour = new Date().toISOString().slice(0, 13);
    const so_far = await env.DB.prepare(
      `SELECT COUNT(*) AS ended, SUM(CASE WHEN json_extract(report, '$.stopped_on_error') = 1 THEN 1 ELSE 0 END) AS errors
       FROM bench_runs WHERE arm IN ('baseline', 'treatment') AND substr(finished_at, 1, 13) = ?1`
    )
      .bind(hour)
      .first<{ ended: number; errors: number | null }>();
    const ended = so_far?.ended ?? 0;
    const errors = so_far?.errors ?? 0;
    const needed = Math.max(ended - 2 * errors, 4 - ended, 0);
    for (let i = 0; i < needed; i++) {
      const other = await startOk(await registerTask());
      await score(other, { hidden: counts(0, 3), claimed_done: false, stopped_on_error: true });
    }
    const refused = await start(task_id);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toMatch(/outage hour/);
  });
});
