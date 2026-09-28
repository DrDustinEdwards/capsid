import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server";
import { adminAgentForEmail, legacyAgent, type Agent } from "../src/agents";
import { blockJob, claimJob, postJob } from "../src/jobs";

// THE SEAT'S QUEUE ACTIONS AS access:<email>, through the real jobs tool, against a
// real D1. Since the MCP login moved to Cloudflare Access (#185), the admin reaches the
// queue as `access:<email>`. The queue recorded leases only for github:, opkey: and
// agent: actors, so the seat's resume of job_195c11e2667b was refused on 2026-09-28:
// "'access:...' is not a caller identity this queue can hold a lease for". Each seat
// action is driven here as that identity.

const SECRET = "test-root-secret";
const ADMIN_EMAIL = "admin@example.com";
const SEAT_ACTOR = `access:${ADMIN_EMAIL}`;
const SEAT = adminAgentForEmail(ADMIN_EMAIL);
const DRIVER = legacyAgent("write", "agent:access-seat-driver");
const NOW = new Date("2026-09-28T01:00:00.000Z");

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as never;
}

// One call to the jobs tool, as `agent`, through an MCP client on the real server.
async function jobsTool(agent: Agent, args: Record<string, unknown>): Promise<{ ok: boolean; refusal?: string; job?: Record<string, unknown> }> {
  const server = buildServer(jobsEnv(), agent);
  const client = new Client({ name: "access-seat", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const result = (await client.callTool({ name: "jobs", arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  await client.close();
  const text = result.content[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, refusal: text };
  }
}

let n = 0;
// A job posted by the driver, so the seat's own actions are the ones under test.
async function driverJob(): Promise<string> {
  n += 1;
  const posted = await postJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid", title: `access seat job ${n}`, body: "Do the sample work." });
  if (!posted.ok) throw new Error(`setup post failed: ${JSON.stringify(posted)}`);
  return String((posted as { job: { id: string } }).job.id);
}

async function claimedByDriver(): Promise<string> {
  const id = await driverJob();
  const claimed = await claimJob(jobsEnv(), DRIVER, NOW, { id });
  if (!claimed.ok) throw new Error(`setup claim failed: ${JSON.stringify(claimed)}`);
  return id;
}

async function blockedByDriver(): Promise<string> {
  const id = await claimedByDriver();
  const blocked = await blockJob(jobsEnv(), DRIVER, NOW, id, { reason: "gate", command: "npm run deploy" });
  if (!blocked.ok) throw new Error(`setup block failed: ${JSON.stringify(blocked)}`);
  return id;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM jobs").run();
  // jobs post requires a registered namespace.
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)").bind("capsid", JSON.stringify([{ repo: "example/capsid", label: "primary" }])).run();
});

const row = (id: string) => env.DB.prepare("SELECT status, claimed_by, posted_by FROM jobs WHERE id = ?1").bind(id).first<Record<string, string>>();

describe(`the seat as ${SEAT_ACTOR}, through the jobs tool`, () => {
  it("the admin agent speaks access:<email>", () => {
    expect(SEAT.actor).toBe(SEAT_ACTOR);
    expect(SEAT.admin).toBe(true);
  });

  it("post: the job is recorded as posted by access:<email>", async () => {
    const result = await jobsTool(SEAT, { action: "post", namespace: "capsid", title: "posted by the access seat", body: "Sample work." });
    expect(result.ok, result.refusal).toBe(true);
    expect((await row(String(result.job?.id)))?.posted_by).toBe(SEAT_ACTOR);
  });

  it("claim: the seat can hold a lease as access:<email>", async () => {
    const id = await driverJob();
    const result = await jobsTool(SEAT, { action: "claim", id });
    expect(result.ok, result.refusal).toBe(true);
    expect((await row(id))?.claimed_by).toBe(SEAT_ACTOR);
  });

  it("resume: the seat resumes a job the driver blocked", async () => {
    const id = await blockedByDriver();
    const result = await jobsTool(SEAT, { action: "resume", id, reason: "approved by the seat" });
    expect(result.ok, result.refusal).toBe(true);
    expect((await row(id))?.status).toBe("claimed");
  });

  it("resume with take: the seat takes the lease as access:<email>", async () => {
    const id = await blockedByDriver();
    const result = await jobsTool(SEAT, { action: "resume", id, reason: "the seat takes it", take: true });
    expect(result.ok, result.refusal).toBe(true);
    expect((await row(id))?.claimed_by).toBe(SEAT_ACTOR);
  });

  it("supersede: the seat withdraws a queued job", async () => {
    const id = await driverJob();
    const result = await jobsTool(SEAT, { action: "supersede", id, reason: "replaced" });
    expect(result.ok, result.refusal).toBe(true);
    expect((await row(id))?.status).toBe("superseded");
  });

  it("release: the seat returns the driver's claim to the queue", async () => {
    const id = await claimedByDriver();
    const result = await jobsTool(SEAT, { action: "release", id, reason: "the driver is not coming back" });
    expect(result.ok, result.refusal).toBe(true);
    expect((await row(id))?.status).toBe("queued");
  });

  it("fail: the seat fails a job the driver holds", async () => {
    const id = await claimedByDriver();
    const result = await jobsTool(SEAT, { action: "fail", id, reason: "cannot be done" });
    expect(result.ok, result.refusal).toBe(true);
    expect((await row(id))?.status).toBe("failed");
  });

  it("start: the seat passes the seat check, and is refused only because the switch is off", async () => {
    const id = await driverJob();
    const result = await jobsTool(SEAT, { action: "start", id });
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/switched off/);
    expect(result.refusal).not.toMatch(/cannot start a session|not a caller identity/);
  });
});
