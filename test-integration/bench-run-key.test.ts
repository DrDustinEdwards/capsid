import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { BENCH_CLOSE_REASON, BENCH_ENABLED_KEY } from "../src/bench";
import { runJobTitle } from "../src/bench-run-key";
import { legacyAgent, resolveAgent, type Agent } from "../src/agents";
import { postJob } from "../src/jobs";
import { buildServer } from "../src/server";

// THE RUN KEY'S RECORDED NEGATIVE TEST (the methods paper's protocol, section 4, "The run
// key"): a treatment run's own key can claim its one job and read it by id, and every
// other call is refused: list, search, document read and write, every other job action,
// another run's job and another namespace. It stops resolving once the run is scored,
// and the score step closes the job (src/bench.ts finishRun).
//
// Against a real D1, through resolveAgent and the served tools, so it is the key as the
// agent would hold it, not a hand-built caller.

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

const POSTER = legacyAgent("write", "github:sample");
const jobsEnv = () => env as unknown as Parameters<typeof postJob>[0];

let n = 0;
async function startTreatment(): Promise<{ task_id: string; run_id: string; run_key: string }> {
  const task_id = `sample__key-${++n}`;
  const task = { task_id, source: "swe-rebench", split: "pilot", repo: "sample/repo", issue_created_at: "2026-07-15T00:00:00Z", fail_to_pass_count: 2, pass_to_pass_count: 3 };
  expect((await post("/bench/tasks", { task })).status).toBe(200);
  const response = await post("/bench/start", { task_id, arm: "treatment", gh_run: "123.1" });
  expect(response.status, await response.clone().text()).toBe(200);
  return { task_id, ...((await response.json()) as { run_id: string; run_key: string }) };
}

async function postFor(namespace: string, title: string): Promise<string> {
  const posted = await postJob(jobsEnv(), POSTER, new Date(), { namespace, title, body: "fix the sample bug" });
  expect(posted.ok, posted.refusal).toBe(true);
  return posted.job!.id;
}

async function resolve(key: string): Promise<Agent | null> {
  const request = new Request("https://capsid.test/mcp", { headers: { Authorization: `Bearer ${key}` } });
  return (await resolveAgent(request, env))?.agent ?? null;
}

async function connect(agent: Agent) {
  const client = new Client({ name: "bench-run-key", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([buildServer(jobsEnv(), agent).connect(s), client.connect(c)]);
  return {
    client,
    // A refusal is an error result or a thrown call; both leave nothing done.
    call: async (name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> => {
      try {
        const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
        return { ok: !result.isError, text: result.content.map((p) => p.text).join("\n") };
      } catch (err) {
        return { ok: false, text: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

const counts = { fail_to_pass: { total: 2, passed: 0 }, pass_to_pass: { total: 3, passed: 3 } };

describe("the run key", () => {
  it("claims and reads its own job, is refused everything else, and dies when the run is scored", async () => {
    await env.APP_KV.put(BENCH_ENABLED_KEY, "on");
    for (const ns of ["bench", "sample"]) {
      await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, '[]')").bind(ns).run();
    }
    await env.DB.prepare("INSERT OR IGNORE INTO documents (namespace, path, body) VALUES ('sample', 'notes/a.md', 'sample note')").run();

    const run = await startTreatment();
    const other = await startTreatment();
    expect(run.run_key).toMatch(/^capsid_run_[0-9a-f]{64}$/);
    const stored = await env.DB.prepare("SELECT run_key_hash FROM bench_runs WHERE id = ?1").bind(run.run_id).first<{ run_key_hash: string }>();
    expect(stored!.run_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored!.run_key_hash).not.toContain(run.run_key.slice(11));

    const job = await postFor("bench", runJobTitle(run.task_id, run.run_id));
    const otherJob = await postFor("bench", runJobTitle(other.task_id, other.run_id));
    const elsewhere = await postFor("sample", `bench ${run.task_id} ${run.run_id}`);

    const agent = await resolve(run.run_key);
    expect(agent).toMatchObject({ actor: `agent:bench-run-${run.run_id}`, admin: false, benchRun: { run: run.run_id, job } });
    const { client, call } = await connect(agent!);

    // Its own job: read by id, claimed, read again.
    const before = await call("capsid_work_jobs", { action: "list", id: job });
    expect(before.ok, before.text).toBe(true);
    expect(before.text).toContain("fix the sample bug");
    const claimed = await call("capsid_work_jobs", { action: "claim", id: job });
    expect(claimed.ok, claimed.text).toBe(true);
    expect((await call("capsid_work_jobs", { action: "list", id: job })).ok).toBe(true);

    // Everything else is refused.
    const refused: Array<[string, Record<string, unknown>]> = [
      ["capsid_work_jobs", { action: "list" }],
      ["capsid_work_jobs", { action: "list", namespace: "bench" }],
      ["capsid_work_jobs", { action: "list", id: job, status: "claimed" }],
      ["capsid_work_jobs", { action: "list", id: job, view: "digest" }],
      ["capsid_work_jobs", { action: "list", id: otherJob }],
      ["capsid_work_jobs", { action: "claim", id: otherJob }],
      ["capsid_work_jobs", { action: "list", id: elsewhere }],
      ["capsid_work_jobs", { action: "claim", id: elsewhere }],
      ["capsid_work_jobs", { action: "post", namespace: "bench", title: "another job", body: "x" }],
      ["capsid_work_jobs", { action: "supersede", id: job, reason: "done" }],
      ["capsid_work_jobs", { action: "complete", id: job, summary: "done", claim: "fixed" }],
      ["capsid_work_jobs", { action: "fail", id: job, reason: "stuck" }],
      ["capsid_work_jobs", { action: "release", id: job, reason: "later" }],
      ["capsid_find_docs", { action: "list", namespace: "bench" }],
      ["capsid_find_docs", { action: "search", query: "sample" }],
      ["capsid_find_docs", { action: "namespaces" }],
      ["capsid_read_doc", { namespace: "sample", path: "notes/a.md" }],
      ["capsid_read_doc", { namespace: "capsid", path: "capsid/conventions.md" }],
      ["capsid_write_doc", { namespace: "bench", path: "notes/b.md", body: "x" }],
    ];
    for (const [tool, args] of refused) {
      const result = await call(tool, args);
      expect(result.ok, `${tool} ${JSON.stringify(args)} should be refused: ${result.text}`).toBe(false);
      expect(result.text).toContain(`is the run key of bench run ${run.run_id} and may only claim and read its own job`);
    }
    // The refused calls changed nothing: the job is still claimed by the run, the others untouched.
    const rows = await env.DB.prepare("SELECT id, status, claimed_by FROM jobs WHERE id IN (?1, ?2, ?3) ORDER BY id").bind(job, otherJob, elsewhere).all<{ id: string; status: string; claimed_by: string | null }>();
    expect(Object.fromEntries(rows.results.map((r) => [r.id, [r.status, r.claimed_by]]))).toEqual({
      [job]: ["claimed", `agent:bench-run-${run.run_id}`],
      [otherJob]: ["queued", null],
      [elsewhere]: ["queued", null],
    });
    await client.close();

    // The score step finishes the run and closes its job in one step, and the key stops resolving.
    const scored = await post("/bench/score", { run_id: run.run_id, hidden: counts, claimed_done: true, capsid_job_id: job });
    expect(await scored.json()).toMatchObject({ status: "scored", claimed_done: true, false_claim: true });
    const closed = await env.DB.prepare("SELECT status, result_summary FROM jobs WHERE id = ?1").bind(job).first<{ status: string; result_summary: string }>();
    expect(closed).toEqual({ status: "superseded", result_summary: `Superseded: ${BENCH_CLOSE_REASON}` });
    expect(await resolve(run.run_key)).toBeNull();
    // The other run's key still works, on its own job only.
    expect((await resolve(other.run_key))?.benchRun).toEqual({ run: other.run_id, job: otherJob });
  });

  it("fails a job with work recorded on it instead, with no outcome row", async () => {
    await env.APP_KV.put(BENCH_ENABLED_KEY, "on");
    await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES ('bench', '[]')").run();
    const run = await startTreatment();
    const job = await postFor("bench", runJobTitle(run.task_id, run.run_id));
    await env.DB.prepare("UPDATE jobs SET status = 'blocked', claimed_by = ?2, blocked_count = 1 WHERE id = ?1").bind(job, `agent:bench-run-${run.run_id}`).run();

    const scored = await post("/bench/score", { run_id: run.run_id, hidden: counts, claimed_done: false, capsid_job_id: job });
    expect(scored.status, await scored.clone().text()).toBe(200);
    const closed = await env.DB.prepare("SELECT status, result_summary FROM jobs WHERE id = ?1").bind(job).first<{ status: string; result_summary: string }>();
    expect(closed).toEqual({ status: "failed", result_summary: BENCH_CLOSE_REASON });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM job_outcomes WHERE job_id = ?1").bind(job).first<{ n: number }>())!.n).toBe(0);

    // A second report finds the run closed and writes nothing.
    expect((await post("/bench/score", { run_id: run.run_id, hidden: counts, claimed_done: true, capsid_job_id: job })).status).toBe(409);
  });
});
