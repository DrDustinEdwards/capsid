import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { blockJob, claimJob, postJob } from "../src/jobs";
import { autoResumeJob, MERGE_RESUME_ACTOR } from "../src/jobs-seat";
import { mergeResumeTick } from "../src/merge-resume";
import { readJob } from "../src/jobs-transition";
import { legacyAgent, type Agent } from "../src/agents";
import { defaultScopes } from "../src/agents-schema";

// The stale-jobs step (capsid/decisions.md, 2026-10-03, D1 to D3): a blocked job whose
// pull requests merged goes back to its holder, or to the queue when the holder cannot
// act, and is never completed. GitHub is not reachable from the test runtime, so the
// merge read is exercised by what happens when it fails; autoResumeJob takes the fact
// the read produces.

const SECRET = "test-root-secret";
const ADMIN = legacyAgent("write", "github:DrDustinEdwards");
const NOW = new Date("2026-10-08T06:00:00.000Z");
const LATER = new Date("2026-10-08T07:00:00.000Z");
const NOTE = "PR #9 merged at abc1234; confirm the deploy and complete with your claim";

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

function driverAgent(actor = "agent:capsid-driver"): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  return { id: `agent_${actor.length}`, name: actor.slice("agent:".length), kind: "driver", actor, scopes, admin: false, row: null };
}

async function post(title: string): Promise<string> {
  const posted = await postJob(jobsEnv(), ADMIN, NOW, { namespace: "capsid", title, body: "do the thing", gate_required: true });
  expect(posted.ok, posted.refusal).toBe(true);
  return posted.job!.id;
}

async function blockedBy(holder: Agent, title: string, summaryReason = "waiting on the merge"): Promise<string> {
  const id = await post(title);
  expect((await claimJob(jobsEnv(), holder, NOW, { id })).ok).toBe(true);
  expect((await blockJob(jobsEnv(), holder, NOW, id, { reason: summaryReason, command: "Merge PR 9" })).ok).toBe(true);
  return id;
}

async function row(id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<Record<string, unknown>>();
}

async function touches(id: string) {
  const { results } = await env.DB.prepare("SELECT kind, actor, actor_kind FROM job_touches WHERE job_id = ?1 AND actor = ?2 ORDER BY id")
    .bind(id, MERGE_RESUME_ACTOR)
    .all<{ kind: string; actor: string; actor_kind: string }>();
  return results ?? [];
}

beforeEach(async () => {
  for (const table of ["jobs", "audit_log", "job_outcomes", "job_touches", "agents"]) await env.DB.prepare(`DELETE FROM ${table}`).run().catch(() => undefined);
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
    .bind("capsid", JSON.stringify([{ repo: "example/capsid", label: "primary" }]))
    .run();
});

describe("autoResumeJob", () => {
  it("returns a blocked job to its holder with a system touch and the note, and does not complete it", async () => {
    const driver = driverAgent();
    const id = await blockedBy(driver, "merged and waiting");
    const job = (await readJob(env.DB, id))!;

    const out = await autoResumeJob(jobsEnv(), LATER, job, NOTE);
    expect(out).toEqual({ resumed: true, to: "holder" });
    const r = await row(id);
    expect(r?.status).toBe("claimed");
    expect(r?.claimed_by).toBe("agent:capsid-driver");
    expect(r?.resumed_count).toBe(1);
    expect(await touches(id)).toEqual([
      { kind: "resume", actor: MERGE_RESUME_ACTOR, actor_kind: "system" },
      { kind: "note", actor: MERGE_RESUME_ACTOR, actor_kind: "system" },
    ]);
    const outcomes = await env.DB.prepare("SELECT COUNT(*) AS n FROM job_outcomes WHERE job_id = ?1").bind(id).first<{ n: number }>();
    expect(outcomes?.n).toBe(0);
  });

  it("queues the job when its holder is revoked", async () => {
    const driver = driverAgent();
    const id = await blockedBy(driver, "holder revoked");
    await env.DB.prepare("INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, revoked_at) VALUES (?1, ?2, 'driver', ?3, ?4, 'github:sample', ?5)")
      .bind("agent_revoked1", "capsid-driver", "hash", JSON.stringify(driver.scopes), LATER.toISOString())
      .run();
    const out = await autoResumeJob(jobsEnv(), LATER, (await readJob(env.DB, id))!, NOTE);
    expect(out).toEqual({ resumed: true, to: "queue" });
    const r = await row(id);
    expect(r?.status).toBe("queued");
    expect(r?.claimed_by).toBeNull();
  });

  it("queues the job when its holder holds another claim", async () => {
    const driver = driverAgent();
    const id = await blockedBy(driver, "holder busy");
    expect((await claimJob(jobsEnv(), driver, NOW, { id: await post("the driver moved on") })).ok).toBe(true);
    const out = await autoResumeJob(jobsEnv(), LATER, (await readJob(env.DB, id))!, NOTE);
    expect(out.to).toBe("queue");
    expect((await row(id))?.status).toBe("queued");
  });

  it("writes nothing when the job moved after it was read", async () => {
    const driver = driverAgent();
    const id = await blockedBy(driver, "moved first");
    const stale = (await readJob(env.DB, id))!;
    await env.DB.prepare("UPDATE jobs SET updated_at = '2026-10-08T06:30:00.000Z' WHERE id = ?1").bind(id).run();
    expect(await autoResumeJob(jobsEnv(), LATER, stale, NOTE)).toEqual({ resumed: false, to: "holder" });
    expect((await row(id))?.status).toBe("blocked");
    expect(await touches(id)).toEqual([]);
  });
});

describe("mergeResumeTick", () => {
  it("leaves a blocked job alone when its pull request cannot be read as merged", async () => {
    const driver = driverAgent();
    const id = await post("names an unreadable pull request");
    expect((await claimJob(jobsEnv(), driver, NOW, { id })).ok).toBe(true);
    expect((await blockJob(jobsEnv(), driver, NOW, id, { reason: "PR https://github.com/example/capsid/pull/9 is open", command: "Merge PR 9" })).ok).toBe(true);
    const report = await mergeResumeTick(jobsEnv(), LATER);
    expect(report.looked).toBe(1);
    expect(report.resumed).toEqual([]);
    expect((await row(id))?.status).toBe("blocked");
  });

  it("does not look at a blocked job that names no pull request", async () => {
    await blockedBy(driverAgent(), "no pull request named");
    expect((await mergeResumeTick(jobsEnv(), LATER)).looked).toBe(0);
  });

  it("skips a job it already resumed once", async () => {
    const driver = driverAgent();
    const id = await post("blocks again after the merge");
    expect((await claimJob(jobsEnv(), driver, NOW, { id })).ok).toBe(true);
    expect((await blockJob(jobsEnv(), driver, NOW, id, { reason: "PR https://github.com/example/capsid/pull/9", command: "Merge PR 9" })).ok).toBe(true);
    await autoResumeJob(jobsEnv(), LATER, (await readJob(env.DB, id))!, NOTE);
    expect((await blockJob(jobsEnv(), driver, LATER, id, { reason: "PR https://github.com/example/capsid/pull/9 deployed? no", command: "wrangler deploy" })).ok).toBe(true);
    expect((await mergeResumeTick(jobsEnv(), LATER)).looked).toBe(0);
  });
});
