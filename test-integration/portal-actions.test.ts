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
import { BREAKER_THRESHOLD_KEY, breakerResetKey } from "../src/job-breaker";

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

const KEYS = [MODE_KEY, SEAT_START_KEY, BREAKER_THRESHOLD_KEY, ...ROSTER.map(pausedKey), ...ROSTER.map(breakerResetKey)];

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("DELETE FROM audit_log").run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
  await env.DB.prepare("DELETE FROM agents").run();
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
    .bind("capsid", JSON.stringify([{ repo: "example/capsid", label: "primary" }]))
    .run();
  // A registered namespace with no site row, for site_add.
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
    .bind("sample", JSON.stringify([{ repo: "example/sample", label: "primary" }]))
    .run();
  await env.DB.prepare("DELETE FROM ops_sites WHERE namespace = 'sample'").run();
  await env.DB.prepare("DELETE FROM ops_packages").run();
  for (const key of KEYS) await env.APP_KV.delete(key);
});

async function packageRow(name: string) {
  return env.DB.prepare("SELECT * FROM ops_packages WHERE name = ?1").bind(name).first<Record<string, unknown>>();
}

async function siteRow(namespace: string) {
  return env.DB.prepare("SELECT * FROM ops_sites WHERE namespace = ?1").bind(namespace).first<Record<string, unknown>>();
}

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
      return { namespace: "capsid", reason: "the regression is fixed" };
    },
    after: async () => expect(await env.APP_KV.get(pausedKey("capsid"))).toBeNull(),
  },
  mode: {
    params: async () => ({ value: "off", reason: "stop the loop" }),
    after: async () => expect(await env.APP_KV.get(MODE_KEY)).toBe("off"),
  },
  seat_start: {
    params: async () => ({ value: "off", reason: "no session should start" }),
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
  site_add: {
    params: async () => ({ namespace: "sample", name: "Sample", origin: "https://sample.example.com", health_path: "/health", platform: "cloudflare" }),
    after: async () => expect(await siteRow("sample")).toMatchObject({ origin: "https://sample.example.com", health_path: "/health", platform: "cloudflare", revision: 1 }),
  },
  site_edit: {
    params: async () => {
      const row = await siteRow("germomics");
      return { namespace: "germomics", revision: String(row?.revision), name: "Germomics", origin: "https://germomics.com", health_path: "/api/health", platform: "cloudflare" };
    },
    after: async ({ revision }) => expect(await siteRow("germomics")).toMatchObject({ health_path: "/api/health", revision: Number(revision) + 1 }),
  },
  site_remove: {
    params: async () => {
      const row = await siteRow("txasm");
      return { namespace: "txasm", revision: String(row?.revision) };
    },
    after: async () => expect(await siteRow("txasm")).toBeNull(),
  },
  reset_breaker: {
    params: async () => ({ namespace: "capsid" }),
    after: async () => expect(await env.APP_KV.get(breakerResetKey("capsid"))).not.toBeNull(),
  },
  package_add: {
    params: async () => ({ name: "sample-pkg", repo: "example-org/sample-pkg", formerly: "sample-old" }),
    after: async () => expect(await packageRow("sample-pkg")).toMatchObject({ repo: "example-org/sample-pkg", formerly: "sample-old", revision: 1 }),
  },
  package_edit: {
    params: async () => {
      await env.DB.prepare("INSERT INTO ops_packages (name, repo) VALUES ('sample-pkg', 'example-org/sample-pkg')").run();
      return { name: "sample-pkg", revision: "1", repo: "example-org/sample-pkg", formerly: "sample-old" };
    },
    after: async () => expect(await packageRow("sample-pkg")).toMatchObject({ formerly: "sample-old", revision: 2 }),
  },
  package_remove: {
    params: async () => {
      await env.DB.prepare("INSERT INTO ops_packages (name) VALUES ('sample-pkg')").run();
      return { name: "sample-pkg", revision: "1" };
    },
    after: async () => expect(await packageRow("sample-pkg")).toBeNull(),
  },
};

describe("every action, previewed then performed through the Worker", () => {
  it("covers the allow-list, fifteen actions", () => {
    expect(Object.keys(CASES).sort()).toEqual([...PORTAL_ACTIONS].sort());
    expect(Object.keys(CASES).length).toBe(15);
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

describe("the automation switches against real D1 and KV", () => {
  it("unpause, mode and seat_start refuse a missing reason at preview, as pause does, and write nothing", async () => {
    await env.APP_KV.put(pausedKey("capsid"), "an old reason");
    const auditBefore = await auditRows();
    const kvBefore = await Promise.all(KEYS.map((k) => env.APP_KV.get(k)));
    for (const [action, params] of [
      ["pause", { namespace: "foxing" }],
      ["unpause", { namespace: "capsid" }],
      ["mode", { value: "off" }],
      ["seat_start", { value: "on" }],
    ] as const) {
      const res = await call(PORTAL_PREVIEW_PATH, { method: "POST", body: { action, params } });
      expect(res.status, `${action} without a reason`).toBe(400);
      expect(await res.text()).toMatch(new RegExp(`^${action} needs a reason`));
    }
    expect(await auditRows()).toEqual(auditBefore);
    expect(await Promise.all(KEYS.map((k) => env.APP_KV.get(k)))).toEqual(kvBefore);
  });

  it("a switch and its Undo write their own click rows: portal-seat_start, then portal-undo-seat_start, each with its reason", async () => {
    const flip = async (params: Record<string, string>) => {
      const preview = (await (await call(PORTAL_PREVIEW_PATH, { method: "POST", body: { action: "seat_start", params } })).json()) as PortalPreview;
      const performed = await call(PORTAL_PERFORM_PATH, { method: "POST", body: { token: preview.token } });
      expect(performed.status, await performed.clone().text()).toBe(200);
      return preview;
    };
    await flip({ value: "on", reason: "queued jobs are waiting" });
    expect(await env.APP_KV.get(SEAT_START_KEY)).toBe("on");
    const undo = await flip({ value: "off", reason: "Undo: queued jobs are waiting", undo: "true" });
    expect(undo.audit).toContain(`portal-undo-seat_start by ${ACTOR}`);
    expect(await env.APP_KV.get(SEAT_START_KEY)).toBe("off");
    const clicks = (await auditRows()).filter((r) => r.action.endsWith("seat_start"));
    expect(clicks.map((r) => r.action)).toEqual(["portal-seat_start", "portal-undo-seat_start"]);
    expect(JSON.parse(clicks[0].params)).toMatchObject({ reason: "queued jobs are waiting" });
    expect(JSON.parse(clicks[0].params).undo).toBeUndefined();
    expect(JSON.parse(clicks[1].params)).toMatchObject({ reason: "Undo: queued jobs are waiting", undo: true });
  });
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

describe("the site actions against real D1", () => {
  it("a site edit previewed, then edited elsewhere, is refused at perform and the row keeps the other edit", async () => {
    const row = await siteRow("foxing");
    const params = { namespace: "foxing", revision: String(row?.revision), name: "Foxing", origin: "https://foxing.app", health_path: "/health", platform: "cloudflare" };
    const preview = (await (await call(PORTAL_PREVIEW_PATH, { method: "POST", body: { action: "site_edit", params } })).json()) as PortalPreview;
    await env.DB.prepare("UPDATE ops_sites SET name = 'Foxing (renamed)', revision = revision + 1 WHERE namespace = 'foxing'").run();
    const res = await call(PORTAL_PERFORM_PATH, { method: "POST", body: { token: preview.token } });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/changed since the preview/);
    expect(await siteRow("foxing")).toMatchObject({ name: "Foxing (renamed)", health_path: null });
    expect((await auditRows()).some((r) => r.action === "portal-site_edit"), "a refused edit wrote a click row").toBe(false);
  });

  it("add refuses an unregistered namespace and a bad origin at preview, with the reason, writing nothing", async () => {
    const auditBefore = await auditRows();
    const unregistered = await call(PORTAL_PREVIEW_PATH, { method: "POST", body: { action: "site_add", params: { namespace: "nobody", origin: "https://nobody.example.com", platform: "cloudflare" } } });
    expect(unregistered.status).toBe(400);
    expect(await unregistered.text()).toMatch(/not a registered namespace/);
    const http = await call(PORTAL_PREVIEW_PATH, { method: "POST", body: { action: "site_add", params: { namespace: "sample", origin: "http://sample.example.com", platform: "cloudflare" } } });
    expect(http.status).toBe(400);
    expect(await http.text()).toMatch(/must start with https/);
    expect(await siteRow("sample")).toBeNull();
    expect(await auditRows()).toEqual(auditBefore);
  });

  it("the feed carries the configuration, and a perform's feed shows the change", async () => {
    const row = await siteRow("julieedwards");
    const preview = (await (await call(PORTAL_PREVIEW_PATH, { method: "POST", body: { action: "site_remove", params: { namespace: "julieedwards", revision: String(row?.revision) } } })).json()) as PortalPreview;
    expect(preview.changes.join(" ")).toMatch(/still registered|remove julieedwards/);
    const performed = (await (await call(PORTAL_PERFORM_PATH, { method: "POST", body: { token: preview.token } })).json()) as PortalPerformed;
    expect(performed.feed.live.sites.some((s) => s.namespace === "julieedwards")).toBe(false);
    expect(performed.feed.live.sites.some((s) => s.namespace === "capsid")).toBe(true);
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

describe("GET /portal/api/packages/history", () => {
  it("answers only for a configured package, so the route cannot fetch an arbitrary name from npm", async () => {
    const res = await call("/portal/api/packages/history?name=left-pad");
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/left-pad is not a configured package/);
    expect((await call("/portal/api/packages/history")).status).toBe(400);
  });
});
