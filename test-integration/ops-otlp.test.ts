import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import { defaultScopes, serializeScopes } from "../src/agents-schema";
import { legacyAgent } from "../src/agents";
import { claimJob, completeJob, postJob } from "../src/jobs";
import { OTLP_LOGS_PATH, OTLP_METRICS_PATH } from "../src/ops-otlp";

// The OTLP receiver through the whole Worker, against a real D1 (migrations/0025):
// who may send, the upsert's delta and cumulative arithmetic, and the per-job totals
// the outcome row takes at complete.

const ORIGIN = "https://capsid.test";
const SECRET = "test-root-secret";
const NOW = new Date("2026-09-29T12:00:00.000Z");
const DRIVER_KEY = "capsid_agent_" + "e".repeat(64);
const READ_ONLY_DRIVER_KEY = "capsid_agent_" + "f".repeat(64);
const RUNNER_KEY = "capsid_agent_" + "a".repeat(64);
const OTHER_DRIVER_KEY = "capsid_agent_" + "b".repeat(64);
const DRIVER_ACTOR = "agent:sample-driver";
const SESSION = "5f1c2d3e-sample-session";

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

async function seedAgent(id: string, name: string, key: string, grants: Array<"read" | "write">, kind = "driver", jobId: string | null = null) {
  const scopes = defaultScopes(["sample"]);
  scopes.grants = grants;
  await env.DB.prepare(
    `INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at, job_id)
     VALUES (?1, ?2, ?3, ?4, ?5, 'github:sample', datetime('now'), ?6)`
  )
    .bind(id, name, kind, await sha256Hex(key), serializeScopes(scopes), jobId)
    .run();
}

async function queued(title: string): Promise<string> {
  const posted = await postJob(jobsEnv(), legacyAgent("write", "github:sample"), NOW, { namespace: "sample", title, body: "do the thing" });
  expect(posted.ok, posted.refusal).toBe(true);
  return posted.job!.id;
}

// The driver claims it under its own actor, which is what resolveSessionCaller looks up.
async function claimedByDriver(title: string): Promise<string> {
  const id = await queued(title);
  const claimed = await claimJob(jobsEnv(), legacyAgent("write", DRIVER_ACTOR), NOW, { namespace: "sample", id });
  expect(claimed.ok, claimed.refusal).toBe(true);
  return id;
}

const s = (key: string, value: string) => ({ key, value: { stringValue: value } });

function metrics(list: unknown[], session = SESSION) {
  return {
    resourceMetrics: [{ resource: { attributes: [s("session.id", session)] }, scopeMetrics: [{ metrics: list }] }],
  };
}
const sum = (name: string, temporality: number, points: unknown[]) => ({ name, sum: { aggregationTemporality: temporality, isMonotonic: true, dataPoints: points } });

async function send(bearer: string | null, body: unknown, opts: { path?: string; gzip?: boolean } = {}): Promise<Response> {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  let payload: BodyInit = text;
  if (opts.gzip) {
    headers["Content-Encoding"] = "gzip";
    payload = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  }
  return SELF.fetch(`${ORIGIN}${opts.path ?? OTLP_METRICS_PATH}`, { method: "POST", headers, body: payload });
}

async function usageRows() {
  const { results } = await env.DB.prepare("SELECT session_id, job_id, metric, kind, model, value FROM session_usage ORDER BY metric, kind, model").all();
  return results;
}

async function outcome(id: string) {
  return env.DB.prepare("SELECT * FROM job_outcomes WHERE job_id = ?1").bind(id).first<Record<string, unknown>>();
}

beforeEach(async () => {
  for (const table of ["session_usage", "agent_sessions", "job_outcomes", "jobs", "agents", "audit_log", "job_outcome_prs"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES ('sample', ?1)")
    .bind(JSON.stringify([{ repo: "example/sample", label: "primary" }]))
    .run();
  await seedAgent("agent_sampledrv01", "sample-driver", DRIVER_KEY, ["read", "write"]);
  await seedAgent("agent_samplero001", "sample-reader", READ_ONLY_DRIVER_KEY, ["read"]);
});

const COST = metrics([sum("claude_code.cost.usage", 1, [{ attributes: [s("model", "claude-sample-1")], asDouble: 0.5 }])]);

describe("who may send", () => {
  it("PLANT: no key is 401 with the capsid-hooks challenge, and nothing is written", async () => {
    const response = await send(null, COST);
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe('Bearer realm="capsid-hooks"');
    expect(await usageRows()).toEqual([]);
  });

  it("PLANT: a read-only key is 403, the legacy one and a read-only driver alike, and nothing is written", async () => {
    for (const key of [env.TEST_OPERATOR_KEYS.read, READ_ONLY_DRIVER_KEY]) {
      const response = await send(key, COST);
      expect(response.status, await response.clone().text()).toBe(403);
    }
    expect(await usageRows()).toEqual([]);
  });

  it("a driver with write is admitted; with no claimed job its usage is recorded against no job", async () => {
    const response = await send(DRIVER_KEY, COST);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({});
    expect(await usageRows()).toEqual([
      { session_id: SESSION, job_id: null, metric: "claude_code.cost.usage", kind: "", model: "claude-sample-1", value: 0.5 },
    ]);
  });

  it("a runner key's usage is recorded against the one job it is bound to", async () => {
    const id = await queued("a runner's job");
    await seedAgent("agent_samplerun01", `runner-${id}-s1`, RUNNER_KEY, ["read", "write"], "session", id);
    const response = await send(RUNNER_KEY, COST);
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await usageRows())[0]).toMatchObject({ job_id: id });
  });

  it("PLANT: a key cannot add usage to another key's session", async () => {
    // The first report claims the session for the driver.
    expect((await send(DRIVER_KEY, COST)).status).toBe(200);
    const owner = await env.DB.prepare("SELECT agent, last_event FROM agent_sessions WHERE session_id = ?1").bind(SESSION).first();
    expect(owner).toEqual({ agent: DRIVER_ACTOR, last_event: "otlp" });

    // A second key with write sends points for the same session id.
    await seedAgent("agent_sampleoth01", "other-driver", OTHER_DRIVER_KEY, ["read", "write"]);
    const response = await send(OTHER_DRIVER_KEY, COST);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { partialSuccess?: { rejectedDataPoints: number; errorMessage: string } };
    expect(body.partialSuccess?.rejectedDataPoints).toBe(1);
    expect(body.partialSuccess?.errorMessage).toMatch(/first reported by another key/);
    // The driver's total is untouched, and the session still names the driver.
    expect(await usageRows()).toEqual([
      { session_id: SESSION, job_id: null, metric: "claude_code.cost.usage", kind: "", model: "claude-sample-1", value: 0.5 },
    ]);
    expect((await env.DB.prepare("SELECT agent FROM agent_sessions WHERE session_id = ?1").bind(SESSION).first())?.agent).toBe(DRIVER_ACTOR);
  });
});

describe("the arithmetic, in SQLite", () => {
  it("delta points add across requests, a cumulative point replaces, and gzip is read", async () => {
    await send(DRIVER_KEY, COST);
    await send(DRIVER_KEY, COST, { gzip: true });
    const tokens = (value: string) =>
      metrics([sum("claude_code.token.usage", 2, [{ attributes: [s("type", "input"), s("model", "claude-sample-1")], asInt: value }])]);
    await send(DRIVER_KEY, tokens("1000"));
    await send(DRIVER_KEY, tokens("1500"));
    const rows = await usageRows();
    expect(rows.find((r) => r.metric === "claude_code.cost.usage")?.value).toBe(1);
    expect(rows.find((r) => r.metric === "claude_code.token.usage")?.value).toBe(1500);
  });

  it("the logs route counts api_error events per session and status, and nothing else", async () => {
    const logs = {
      resourceLogs: [
        {
          resource: { attributes: [s("session.id", SESSION)] },
          scopeLogs: [
            {
              logRecords: [
                { body: { stringValue: "claude_code.api_error" }, attributes: [s("event.name", "api_error"), s("status_code", "529")] },
                { body: { stringValue: "claude_code.api_error" }, attributes: [s("event.name", "api_error"), s("status_code", "529")] },
                { body: { stringValue: "claude_code.user_prompt" }, attributes: [s("event.name", "user_prompt"), s("prompt", "sample")] },
              ],
            },
          ],
        },
      ],
    };
    const response = await send(DRIVER_KEY, logs, { path: OTLP_LOGS_PATH });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await usageRows()).toEqual([
      { session_id: SESSION, job_id: null, metric: "claude_code.api_error", kind: "529", model: "", value: 2 },
    ]);
  });
});

describe("the outcome row", () => {
  it("takes the job's totals at complete", async () => {
    const id = await claimedByDriver("a costed job");
    await send(DRIVER_KEY, COST);
    await send(
      DRIVER_KEY,
      metrics([
        sum("claude_code.token.usage", 1, [
          { attributes: [s("type", "input"), s("model", "claude-sample-1")], asInt: "1200" },
          { attributes: [s("type", "output"), s("model", "claude-sample-1")], asInt: "300" },
        ]),
        sum("claude_code.active_time.total", 1, [
          { attributes: [s("type", "cli")], asDouble: 40 },
          { attributes: [s("type", "user")], asDouble: 20 },
        ]),
      ])
    );
    const done = await completeJob(jobsEnv(), legacyAgent("write", DRIVER_ACTOR), NOW, id, { result_summary: "landed" });
    expect(done.ok, done.refusal).toBe(true);
    const row = await outcome(id);
    expect(row).toMatchObject({
      cost_usd: 0.5,
      tokens_input: 1200,
      tokens_output: 300,
      tokens_cache_read: 0,
      tokens_cache_creation: 0,
      active_seconds: 60,
    });
  });

  it("PLANT: a job with no telemetry records NULL, never 0", async () => {
    // Telemetry sent while the driver held no job is recorded against none, and must
    // not leak into the job it claims next.
    expect((await send(DRIVER_KEY, COST)).status).toBe(200);
    expect((await usageRows()).length).toBe(1);
    const id = await claimedByDriver("an uncosted job");
    const done = await completeJob(jobsEnv(), legacyAgent("write", DRIVER_ACTOR), NOW, id, { result_summary: "landed" });
    expect(done.ok, done.refusal).toBe(true);
    const row = await outcome(id);
    for (const column of ["cost_usd", "tokens_input", "tokens_output", "tokens_cache_read", "tokens_cache_creation", "active_seconds"]) {
      expect(row?.[column], `${column} for a job no telemetry reached`).toBeNull();
    }
  });
});
