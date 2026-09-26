import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleConsoleAction } from "../src/console-actions";
import { consoleSessionCookie } from "../src/console-auth";
import { blockJob, claimJob, postJob } from "../src/jobs";
import { legacyAgent } from "../src/agents";

// The console's two job actions, end to end, against a real D1. The job is posted,
// claimed and blocked through the real queue, the console action runs the real
// resumeJob and adminFailJob, and every assertion reads the jobs and audit_log rows back.

const SECRET = "console-test-cookie-secret";
const SIGNING = "improve-score-root-secret";
const CSRF = "11111111-2222-3333-4444-555555555555";
const NOW = new Date("2026-09-11T15:00:00Z");
const DRIVER = legacyAgent("write", "opkey:aaaabbbbcccc");

function consoleEnv(db: D1Database = env.DB) {
  return { ...env, DB: db, COOKIE_ENCRYPTION_KEY: SECRET, IMPROVE_SCORE_SECRET: SIGNING } as unknown as Parameters<typeof handleConsoleAction>[1];
}

async function post(fields: Record<string, string>, confirm = true): Promise<Request> {
  const session = (await consoleSessionCookie({ login: "DrDustinEdwards", id: 7 }, SECRET, NOW)).split(";")[0];
  return new Request("https://capsid.example/console", {
    method: "POST",
    headers: {
      Cookie: `${session}; capsid_console_csrf=${CSRF}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ ...fields, csrf: CSRF, ...(confirm ? { confirm: "yes" } : {}) }).toString(),
  });
}

async function blockedJob(title = "a blocked job"): Promise<string> {
  const jobsEnv = consoleEnv() as unknown as Parameters<typeof postJob>[0];
  const posted = await postJob(jobsEnv, legacyAgent("write", "github:DrDustinEdwards"), NOW, {
    namespace: "capsid",
    title,
    body: "do the thing",
    gate_required: true,
  });
  expect(posted.ok, posted.refusal).toBe(true);
  const id = posted.job!.id;
  const claimed = await claimJob(jobsEnv, DRIVER, NOW, { id });
  expect(claimed.ok, claimed.refusal).toBe(true);
  const blocked = await blockJob(jobsEnv, DRIVER, NOW, id, { reason: "waiting on the push", command: "git push -u origin feat/x" });
  expect(blocked.ok, blocked.refusal).toBe(true);
  return id;
}

async function row(id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<Record<string, unknown>>();
}

async function audits(): Promise<Array<{ actor: string; action: string; params: string }>> {
  const { results } = await env.DB.prepare("SELECT actor, action, params FROM audit_log ORDER BY id").all<{
    actor: string;
    action: string;
    params: string;
  }>();
  return results ?? [];
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("DELETE FROM audit_log").run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
    .bind("capsid", JSON.stringify([{ repo: "example/capsid", label: "primary" }]))
    .run();
});

describe("fail_job", () => {
  it("marks a blocked job failed and writes BOTH audit rows", async () => {
    const id = await blockedJob();
    const res = await handleConsoleAction(await post({ action: "fail_job", id, reason: "superseded" }), consoleEnv(), NOW);
    expect(res.status, await res.clone().text()).toBe(303);
    expect((await row(id))?.status).toBe("failed");
    const rows = await audits();
    // The transition's own row, and the console's row naming the human.
    expect(rows.some((r) => r.action === "job-admin-fail" && r.params.includes(id))).toBe(true);
    const click = rows.find((r) => r.action === "console-fail_job");
    expect(click?.actor).toBe("github:DrDustinEdwards");
    expect(click?.params).toContain(id);
  });

  it("refuses a job that is already finished, and writes no audit row", async () => {
    const id = await blockedJob();
    await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE id = ?1").bind(id).run();
    await env.DB.prepare("DELETE FROM audit_log").run();
    const res = await handleConsoleAction(await post({ action: "fail_job", id, reason: "too late" }), consoleEnv(), NOW);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/already done/);
    expect(await audits(), "a refused fail wrote an audit row").toEqual([]);
    expect((await row(id))?.status).toBe("done");
  });

  it("refuses a job id that does not exist, rather than reporting a no-op as success", async () => {
    await blockedJob();
    const res = await handleConsoleAction(await post({ action: "fail_job", id: "job_missing", reason: "x" }), consoleEnv(), NOW);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/no job job_missing/);
  });

  it("needs a reason too", async () => {
    const id = await blockedJob();
    const res = await handleConsoleAction(await post({ action: "fail_job", id, reason: "" }), consoleEnv(), NOW);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/reason/i);
    expect((await row(id))?.status).toBe("blocked");
  });
});

describe("resume_job", () => {
  it("moves a blocked job back to claimed and audits the approval reason", async () => {
    const id = await blockedJob();
    const res = await handleConsoleAction(await post({ action: "resume_job", id, reason: "I ran the push myself" }), consoleEnv(), NOW);
    expect(res.status, await res.clone().text()).toBe(303);
    const stored = await row(id);
    expect(stored?.status).toBe("claimed");
    // The admin's resume returns the lease to the driver that blocked it.
    expect(stored?.claimed_by).toBe("opkey:aaaabbbbcccc");
    const rows = await audits();
    expect(rows.some((r) => r.action === "job-resumed" && r.params.includes(id))).toBe(true);
    const click = rows.find((r) => r.action === "console-resume_job");
    expect(click, "the click was not audited").toBeTruthy();
    expect(click?.actor).toBe("github:DrDustinEdwards");
    expect(click?.params).toContain("I ran the push myself");
  });

  it("REFUSES a job whose body was edited after it was signed", async () => {
    // A blocked job can be edited while it waits for a human, so resume re-verifies,
    // and the console must surface the refusal rather than redirecting as though it worked.
    const id = await blockedJob();
    await env.DB.prepare("UPDATE jobs SET body = ?2 WHERE id = ?1").bind(id, "---\ncapsid-task-signature: deadbeef\n---\ntampered").run();
    const res = await handleConsoleAction(await post({ action: "resume_job", id, reason: "approved" }), consoleEnv(), NOW);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/signature|does not match its body/i);
    expect((await row(id))?.status).not.toBe("claimed");
  });

  it("needs an approval reason, and says why", async () => {
    const id = await blockedJob();
    await env.DB.prepare("DELETE FROM audit_log").run();
    const res = await handleConsoleAction(await post({ action: "resume_job", id, reason: "  " }), consoleEnv(), NOW);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/what you approved/i);
    expect(await audits()).toEqual([]);
    expect((await row(id))?.status).toBe("blocked");
  });

  it("the confirmation says the job goes back to the driver that blocked it, and writes nothing", async () => {
    // resumeJob is called without take, so the lease returns to the blocked job's own
    // claimant. The consent text must describe that, not a lease the admin never gets.
    const id = await blockedJob();
    await env.DB.prepare("DELETE FROM audit_log").run();
    const before = await row(id);
    const res = await handleConsoleAction(await post({ action: "resume_job", id, reason: "approved" }, false), consoleEnv(), NOW);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toMatch(/takes the lease|under your own login/i);
    expect(html).toMatch(/driver that blocked it/i);
    expect(await audits(), "the confirmation step wrote an audit row").toEqual([]);
    expect(await row(id), "the confirmation step moved the job").toEqual(before);
  });

  it("a failed click audit AFTER the resume committed redirects with a warning, not a 400 saying nothing changed", async () => {
    const id = await blockedJob();
    // Every batch after the job has left blocked is the console's own audit row: fail it.
    const failing = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        if ((await row(id))?.status === "claimed") throw new Error("D1_ERROR: simulated audit insert failure");
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;
    const res = await handleConsoleAction(await post({ action: "resume_job", id, reason: "approved" }), consoleEnv(failing), NOW);
    expect((await row(id))?.status, "the resume should have committed").toBe("claimed");
    expect(res.status, "a committed action must not report failure").toBe(303);
    expect(res.headers.get("Location")).toBe("/console");
    expect(res.headers.get("X-Capsid-Warning") ?? "").toMatch(/audit/i);
    expect(await res.text()).toMatch(/resume_job completed/);
    expect((await audits()).some((r) => r.action === "console-resume_job")).toBe(false);
  });
});

describe("release_job", () => {
  it("returns a claimed job to the queue and writes both audit rows", async () => {
    const jobsEnv = consoleEnv() as unknown as Parameters<typeof postJob>[0];
    const posted = await postJob(jobsEnv, legacyAgent("write", "github:DrDustinEdwards"), NOW, {
      namespace: "capsid",
      title: "a claim whose holder went away",
      body: "do the thing",
    });
    const id = posted.job!.id;
    expect((await claimJob(jobsEnv, DRIVER, NOW, { id })).ok).toBe(true);

    const res = await handleConsoleAction(await post({ action: "release_job", id, reason: "no session is running" }), consoleEnv(), NOW);
    expect(res.status, await res.clone().text()).toBe(303);
    const stored = await row(id);
    expect(stored?.status).toBe("queued");
    expect(stored?.claimed_by).toBeNull();
    const rows = await audits();
    expect(rows.some((r) => r.action === "job-released" && r.params.includes("opkey:aaaabbbbcccc"))).toBe(true);
    const click = rows.find((r) => r.action === "console-release_job");
    expect(click?.actor).toBe("github:DrDustinEdwards");
    expect(click?.params).toContain("no session is running");
  });

  it("refuses a blocked job, which is resumed rather than released", async () => {
    const id = await blockedJob();
    const res = await handleConsoleAction(await post({ action: "release_job", id, reason: "x" }), consoleEnv(), NOW);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/not claimed/);
    expect((await row(id))?.status).toBe("blocked");
  });
});
