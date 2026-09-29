import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { legacyAgent } from "../src/agents";
import { portalSessionCookie } from "../src/portal-auth";
import type { Env } from "../src/env";
import { improveStatus } from "../src/improve-run";
import { MODE_KEY, pausedKey, ROSTER } from "../src/improve-schema";
import { blockJob, claimJob, postJob } from "../src/jobs";
import type { PortalActivity, PortalNamespaces, PortalPerformed, PortalPreview } from "../src/ops-types";
import {
  PORTAL_ACTIONS,
  PORTAL_ACTIVITY_PATH,
  PORTAL_CSRF_HEADER,
  PORTAL_NAMESPACES_PATH,
  PORTAL_PERFORM_PATH,
  PORTAL_PREVIEW_PATH,
} from "../src/portal-actions";
import { SEAT_START_KEY } from "../src/seat-start";

// The Portal's controls through the whole Worker against a real D1 and KV: every action
// previewed, checked to have written nothing, then performed from its token, and the
// rows it wrote read back. The refusals below were carried over from the old page's
// job-action tests when /console was deleted, so none of its cases lost coverage.

const ORIGIN = "https://capsid.test";
const SECRET = "integration-portal-cookie-key";
const CSRF = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const NOW = new Date();
const ACTOR = "access:admin@example.com";
const DRIVER = legacyAgent("write", "agent:capsid-driver");

function workerEnv(): Env {
  return { ...(env as unknown as Env), COOKIE_ENCRYPTION_KEY: SECRET };
}

async function call(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const session = (await portalSessionCookie({ email: "admin@example.com" }, SECRET, new Date())).split(";")[0];
  const headers = new Headers({ Cookie: `${session}; capsid_portal_csrf=${CSRF}`, "Sec-Fetch-Site": "same-origin" });
  if (init.body !== undefined) {
    headers.set(PORTAL_CSRF_HEADER, CSRF);
    headers.set("Content-Type", "application/json");
  }
  const ctx = createExecutionContext();
  const request = new Request(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers,
    redirect: "manual",
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const response = await worker.fetch!(request as never, workerEnv() as never, ctx);
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}

async function jobsEnv() {
  return workerEnv() as unknown as Parameters<typeof postJob>[0];
}

async function postedJob(title: string): Promise<string> {
  const posted = await postJob(await jobsEnv(), legacyAgent("write", "github:DrDustinEdwards"), NOW, { namespace: "capsid", title, body: "do the thing", gate_required: true });
  expect(posted.ok, posted.refusal).toBe(true);
  return posted.job!.id;
}

async function claimedJob(title: string, by = DRIVER): Promise<string> {
  const id = await postedJob(title);
  const claimed = await claimJob(await jobsEnv(), by, NOW, { id });
  expect(claimed.ok, claimed.refusal).toBe(true);
  return id;
}

async function blockedJob(title: string, by = DRIVER): Promise<string> {
  const id = await claimedJob(title, by);
  const blocked = await blockJob(await jobsEnv(), by, NOW, id, { reason: "waiting on the push", command: "git push -u origin feat/x" });
  expect(blocked.ok, blocked.refusal).toBe(true);
  return id;
}

async function job(id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<Record<string, unknown>>();
}

async function auditRows(): Promise<Array<{ id: number; actor: string; action: string; params: string }>> {
  const { results } = await env.DB.prepare("SELECT id, actor, action, params FROM audit_log ORDER BY id").all<{ id: number; actor: string; action: string; params: string }>();
  return results ?? [];
}

const KEYS = [MODE_KEY, SEAT_START_KEY, ...ROSTER.map(pausedKey)];

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("DELETE FROM audit_log").run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
  await env.DB.prepare("DELETE FROM agents").run();
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
    .bind("capsid", JSON.stringify([{ repo: "example/capsid", label: "primary" }]))
    .run();
  for (const key of KEYS) await env.APP_KV.delete(key);
});

// Each action: its params, the state it starts from, and what the perform must leave.
type Case = { params: () => Promise<Record<string, string>>; after: (params: Record<string, string>) => Promise<void> };

const CASES: Record<string, Case> = {
  pause: {
    params: async () => ({ namespace: "foxing", reason: "holdout rebuild" }),
    after: async () => expect(await env.APP_KV.get(pausedKey("foxing"))).toBe("holdout rebuild"),
  },
  unpause: {
    params: async () => {
      await env.APP_KV.put(pausedKey("capsid"), "an old reason");
      return { namespace: "capsid" };
    },
    after: async () => expect(await env.APP_KV.get(pausedKey("capsid"))).toBeNull(),
  },
  mode: {
    params: async () => ({ value: "off" }),
    after: async () => expect(await env.APP_KV.get(MODE_KEY)).toBe("off"),
  },
  seat_start: {
    params: async () => ({ value: "off" }),
    after: async () => expect(await env.APP_KV.get(SEAT_START_KEY)).toBe("off"),
  },
  resume_job: {
    params: async () => ({ id: await blockedJob("a blocked job"), reason: "I ran the push myself" }),
    after: async ({ id }) => {
      const stored = await job(id);
      expect(stored?.status).toBe("claimed");
      expect(stored?.claimed_by, "the lease goes back to the driver that blocked it").toBe("agent:capsid-driver");
    },
  },
  release_job: {
    params: async () => ({ id: await claimedJob("a claim whose holder went away"), reason: "no session is running" }),
    after: async ({ id }) => {
      const stored = await job(id);
      expect(stored?.status).toBe("queued");
      expect(stored?.claimed_by).toBeNull();
    },
  },
  fail_job: {
    params: async () => ({ id: await blockedJob("a job to fail"), reason: "superseded" }),
    after: async ({ id }) => expect((await job(id))?.status).toBe("failed"),
  },
  revoke_agent: {
    params: async () => {
      await env.DB.prepare(
        `INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at)
         VALUES ('agent_sample00001', 'sample-driver', 'driver', ?1, ?2, 'github:sample', '2026-09-11 00:00:00')`
      )
        .bind("e".repeat(64), JSON.stringify({ namespaces: ["capsid"], repos: "*", tools: "*", grants: ["read"], flags: {} }))
        .run();
      return { name: "sample-driver" };
    },
    after: async () => {
      const row = await env.DB.prepare("SELECT revoked_at FROM agents WHERE name = 'sample-driver'").first<{ revoked_at: string | null }>();
      expect(row?.revoked_at).not.toBeNull();
    },
  },
};

describe("every action, previewed then performed through the Worker", () => {
  it("covers the allow-list, eight actions", () => {
    expect(Object.keys(CASES).sort()).toEqual([...PORTAL_ACTIONS].sort());
    expect(Object.keys(CASES).length).toBe(8);
  });

  for (const action of PORTAL_ACTIONS) {
    it(`${action}: the preview writes nothing, and the perform writes the rows the preview listed`, async () => {
      const params = await CASES[action].params();
      const auditBefore = await auditRows();
      const kvBefore = await Promise.all(KEYS.map((k) => env.APP_KV.get(k)));
      const jobBefore = params.id ? await job(params.id) : null;

      const previewed = await call(PORTAL_PREVIEW_PATH, { method: "POST", body: { action, params } });
      expect(previewed.status, await previewed.clone().text()).toBe(200);
      const preview = (await previewed.json()) as PortalPreview;
      expect(await auditRows(), "the preview wrote an audit row").toEqual(auditBefore);
      expect(await Promise.all(KEYS.map((k) => env.APP_KV.get(k))), "the preview wrote to KV").toEqual(kvBefore);
      if (params.id) expect(await job(params.id), "the preview moved the job").toEqual(jobBefore);

      const performed = await call(PORTAL_PERFORM_PATH, { method: "POST", body: { token: preview.token } });
      expect(performed.status, await performed.clone().text()).toBe(200);
      const body = (await performed.json()) as PortalPerformed;
      expect(body.action).toBe(action);
      expect(body.warning).toBeNull();
      expect(body.feed.csrf).toBe(CSRF);
      expect(body.feed.live.namespaces.map((n) => n.name)).toEqual([...ROSTER]);
      await CASES[action].after(params);

      // The rows written are the rows the preview said would be. A job transition
      // writes its action twice, once for the job and once for its mirror document, so
      // the comparison is of distinct "<action> by <actor>" lines.
      const written = (await auditRows()).filter((r) => !auditBefore.some((b) => b.id === r.id));
      expect([...new Set(written.map((r) => `${r.action} by ${r.actor}`))].sort()).toEqual([...preview.audit].sort());
      const click = written.find((r) => r.action === `portal-${action}`);
      expect(click?.actor).toBe(ACTOR);
    });
  }
});

describe("the job actions against real D1", () => {
  it("resume: the preview says the queue, and why, when the job was blocked by a shared identity, and the perform sends it there", async () => {
    const id = await blockedJob("blocked by a shared identity", legacyAgent("write", "access:someone@example.com"));
    const previewed = await call(PORTAL_PREVIEW_PATH, { method: "POST", body: { action: "resume_job", params: { id, reason: "approved" } } });
    const preview = (await previewed.json()) as PortalPreview;
    expect(preview.changes[0]).toMatch(/blocked -> queued/);
    expect(preview.changes[0]).toMatch(/shared identity/);
    const performed = await call(PORTAL_PERFORM_PATH, { method: "POST", body: { token: preview.token } });
    expect(performed.status, await performed.clone().text()).toBe(200);
    expect((await job(id))?.status).toBe("queued");
  });

  it("a second perform of the same token is refused by the transition, not the token, and writes no click row", async () => {
    const id = await blockedJob("resumed twice");
    const preview = (await (await call(PORTAL_PREVIEW_PATH, { method: "POST", body: { action: "resume_job", params: { id, reason: "approved" } } })).json()) as PortalPreview;
    expect((await call(PORTAL_PERFORM_PATH, { method: "POST", body: { token: preview.token } })).status).toBe(200);
    const clicks = (await auditRows()).filter((r) => r.action === "portal-resume_job").length;
    const again = await call(PORTAL_PERFORM_PATH, { method: "POST", body: { token: preview.token } });
    expect(again.status).toBe(400);
    expect(await again.text()).toMatch(/not blocked/);
    expect((await auditRows()).filter((r) => r.action === "portal-resume_job").length).toBe(clicks);
  });

  it("fail: a job id that does not exist is refused, rather than reported as a no-op that worked", async () => {
    await blockedJob("some other job");
    const res = await call(PORTAL_PREVIEW_PATH, { method: "POST", body: { action: "fail_job", params: { id: "job_missing", reason: "x" } } });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/no job job_missing/);
  });

  it("fail and resume need a reason, say so, and write nothing", async () => {
    const id = await blockedJob("needs a reason");
    await env.DB.prepare("DELETE FROM audit_log").run();
    for (const action of ["fail_job", "resume_job"]) {
      const res = await call(PORTAL_PREVIEW_PATH, { method: "POST", body: { action, params: { id } } });
      expect(res.status, `${action} without a reason`).toBe(400);
      expect(await res.text()).toMatch(/reason|what you approved/i);
    }
    expect(await auditRows()).toEqual([]);
    expect((await job(id))?.status).toBe("blocked");
  });

  it("resume REFUSES a job whose body was edited after it was signed, at perform, and the job stays blocked", async () => {
    // A blocked job can be edited while it waits for a human, so resume re-verifies the
    // signature, and the Portal must show that refusal rather than report success.
    const id = await blockedJob("edited while blocked");
    const preview = (await (await call(PORTAL_PREVIEW_PATH, { method: "POST", body: { action: "resume_job", params: { id, reason: "approved" } } })).json()) as PortalPreview;
    await env.DB.prepare("UPDATE jobs SET body = ?2 WHERE id = ?1").bind(id, "---\ncapsid-task-signature: deadbeef\n---\ntampered").run();
    const res = await call(PORTAL_PERFORM_PATH, { method: "POST", body: { token: preview.token } });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/signature|does not match its body/i);
    expect((await job(id))?.status).not.toBe("claimed");
    expect((await auditRows()).some((r) => r.action === "portal-resume_job"), "a refused resume wrote a click row").toBe(false);
  });

  it("release: the preview refuses a blocked job, and fail refuses a finished one", async () => {
    const blocked = await blockedJob("still blocked");
    const release = await call(PORTAL_PREVIEW_PATH, { method: "POST", body: { action: "release_job", params: { id: blocked, reason: "x" } } });
    expect(release.status).toBe(400);
    expect(await release.text()).toMatch(/not claimed/);
    await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE id = ?1").bind(blocked).run();
    const fail = await call(PORTAL_PREVIEW_PATH, { method: "POST", body: { action: "fail_job", params: { id: blocked, reason: "x" } } });
    expect(fail.status).toBe(400);
    expect(await fail.text()).toMatch(/already done/);
  });
});

describe("the Portal's reads", () => {
  it("namespaces reports what improve_status reports, for every roster namespace", async () => {
    await env.APP_KV.put(pausedKey("foxing"), "looking at a regression");
    const response = await call(PORTAL_NAMESPACES_PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as PortalNamespaces;
    expect(body.namespaces.map((n) => n.namespace)).toEqual([...ROSTER]);
    expect(body.namespaces.find((n) => n.namespace === "foxing")?.paused).toBe("looking at a regression");
    const status = await improveStatus(workerEnv());
    for (const ns of status.namespaces) {
      const served = body.namespaces.find((n) => n.namespace === ns.namespace)!;
      expect(served.totals).toEqual(ns.totals);
      expect(served.skills).toEqual(ns.skills);
      expect(served.jobs.queued).toBe(ns.jobs.queued);
    }
  });

  it("activity is the filtered, bounded audit read, newest first, with ISO times", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('agent:sample', 'write', 'sample', 'a.md', '{}')"),
      env.DB.prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('agent:other', 'write', 'sample', 'b.md', '{}')"),
      env.DB.prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('agent:sample', 'write', 'capsid', 'c.md', '{}')"),
    ]);
    const response = await call(`${PORTAL_ACTIVITY_PATH}?namespace=sample&actor=agent:sample`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as PortalActivity;
    expect(body.filter).toEqual({ namespace: "sample", actor: "agent:sample" });
    expect(body.limit).toBe(50);
    expect(body.rows.map((r) => r.path)).toEqual(["a.md"]);
    expect(body.rows[0].at).toMatch(/T.*Z$/);
    const all = (await (await call(PORTAL_ACTIVITY_PATH)).json()) as PortalActivity;
    expect(all.rows.map((r) => r.path)).toEqual(["c.md", "b.md", "a.md"]);
  });
});
