import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BENCH_ENABLED_KEY } from "../src/bench";

// The registration lock (src/bench.ts drawRefusal, handleBenchDraw; migrations/0049)
// against a real D1. Its own file, because a recorded registration changes what every
// later start in the same storage may do: test-integration/bench.test.ts runs its pilot
// tasks with no registration.

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function post(path: string, body: Record<string, unknown>) {
  const text = JSON.stringify({ jti: crypto.randomUUID(), ...body });
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return SELF.fetch(`https://capsid.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bench-Timestamp": ts, "X-Bench-Signature": await hmacHex("integration-bench-secret-not-a-real-one", `${ts}.${text}`) },
    body: text,
  });
}

let n = 0;
async function registerTask(split: string): Promise<string> {
  const task_id = `sample__draw-${++n}`;
  const response = await post("/bench/tasks", {
    task: { task_id, source: "swe-rebench", split, repo: "sample/repo", issue_created_at: "2026-07-15T00:00:00Z", fail_to_pass_count: 2, pass_to_pass_count: 3 },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return task_id;
}

const REG = { registration_sha256: "a".repeat(64), frame_sha256: "b".repeat(64), seed: "20261019" };
const draw = (from: number, tasks: string[], registration = REG) => post("/bench/draw", { registration, from, tasks });
const start = (task_id: string, arm = "baseline") => post("/bench/start", { task_id, arm, gh_run: "123.1" });

describe("the registration lock", () => {
  it("starts a pilot or excluded task before the registration and refuses a full task until it is on the recorded draw", async () => {
    await env.APP_KV.put(BENCH_ENABLED_KEY, "on");
    const pilot = await registerTask("pilot");
    const excluded = await registerTask("excluded");
    const [a, b, c, off] = [await registerTask("full"), await registerTask("full"), await registerTask("full"), await registerTask("full")];
    expect((await start(pilot)).status).toBe(200);
    expect((await start(excluded)).status).toBe(200);
    const early = await start(a);
    expect(early.status).toBe(409);
    expect(await early.text()).toMatch(/no registration is recorded/);
    // A planted arm calls no model and is never locked.
    expect((await start(a, "check-gold")).status).toBe(200);

    // A pilot task cannot be drawn, and a refused batch appends nothing.
    expect((await draw(1, [a, pilot])).status).toBe(409);
    expect((await draw(1, [a, b])).status).toBe(200);
    // The same batch again is a no-op; a different task at a recorded position is refused.
    expect(await (await draw(1, [a, b])).json()).toMatchObject({ added: 0, size: 2 });
    expect((await draw(1, [b, a])).status).toBe(409);
    // Appending goes on from the end, and a gap is refused.
    expect((await draw(4, [c])).status).toBe(409);
    expect(await (await draw(2, [b, c])).json()).toMatchObject({ added: 1, size: 3 });
    // Another registration is refused.
    expect((await draw(4, [off], { ...REG, seed: "1" })).status).toBe(409);

    expect((await start(a)).status).toBe(200);
    // Past the lock, the order rule answers: c's treatment waits for its baseline.
    const outOfOrder = await start(c, "treatment");
    expect(outOfOrder.status).toBe(409);
    expect(await outOfOrder.text()).toMatch(/slots run baseline, treatment/);
    const undrawn = await start(off);
    expect(undrawn.status).toBe(409);
    expect(await undrawn.text()).toMatch(/not on the draw/);
    const late = await start(pilot);
    expect(late.status).toBe(409);
    expect(await late.text()).toMatch(/pilot runs end/);
    expect((await start(excluded)).status).toBe(409);

    // Once a drawn task has a model run, the draw cannot shrink and the registration stays.
    await expect(env.DB.prepare("DELETE FROM bench_draw WHERE task_id = ?1").bind(b).run()).rejects.toThrow(/cannot shrink/);
    await expect(env.DB.prepare("DELETE FROM bench_registration").run()).rejects.toThrow(/frozen/);
    await expect(env.DB.prepare("UPDATE bench_draw SET task_id = ?1 WHERE position = 1").bind(off).run()).rejects.toThrow(/insert-only/);
  });
});
