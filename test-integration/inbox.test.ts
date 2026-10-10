import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import { defaultScopes, serializeScopes } from "../src/agents-schema";
import { legacyAgent } from "../src/agents";
import { blockJob, claimJob, postJob } from "../src/jobs";
import { improveStatus } from "../src/improve-run";
import type { Inbox } from "../src/inbox";

// "What needs Dustin, per app" (job_84e901d8eb71), driven through the whole Worker with the
// credentials a caller would present: GET /ops/inbox, and the same answer in improve_status.
// Everything planted is sample data: namespace "sample", example.com.

const ORIGIN = "https://capsid.test";
const DRIVER_KEY = "capsid_agent_" + "d".repeat(64);
const SECRET = "test-root-secret";
const ADMIN = legacyAgent("write", "github:DrDustinEdwards");
const DRIVER = legacyAgent("write", "agent:driver-aaaa");
const NOW = new Date("2026-10-08T12:00:00.000Z");
const PR = "https://github.com/example-org/sample/pull/42";

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

async function inboxAs(bearer: string | null): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/ops/inbox`, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });
}

async function blocked(namespace: string, title: string, reason: string, question = false): Promise<string> {
  const posted = await postJob(jobsEnv(), ADMIN, NOW, { namespace, title, body: "do the thing" });
  expect(posted.ok, posted.refusal).toBe(true);
  const id = posted.job!.id;
  expect((await claimJob(jobsEnv(), DRIVER, NOW, { id })).ok).toBe(true);
  const out = question ? await blockJob(jobsEnv(), DRIVER, NOW, id, { reason, question: true }) : await blockJob(jobsEnv(), DRIVER, NOW, id, { reason, command: "Merge it" });
  expect(out.ok, out.refusal).toBe(true);
  return id;
}

const snapshot = {
  version: 1,
  pass_at: "2026-10-08T11:55:00.000Z",
  pass_ms: 10,
  cadence_min: 30,
  checks: [],
  health: null,
  mirror: null,
  ci: [{ namespace: "capsid", latest: { head_sha: "abcdef1234567", status: "completed", conclusion: "failure", created_at: "2026-10-08T10:00:00.000Z", url: "https://github.com/example-org/sample/actions/runs/1" } }],
  site_map: null,
  sites: [
    { namespace: "sample", name: "Sample", origin: "https://sample.example.com", health_path: null, platform: "cloudflare", state: "down", http_status: null, latency_ms: null, sha: null, error: "timeout", checked_at: "2026-10-08T11:55:00.000Z", ring: "0", ring_slot: 1 },
  ],
};

beforeEach(async () => {
  for (const table of ["jobs", "audit_log", "job_outcomes", "agents"]) await env.DB.prepare(`DELETE FROM ${table}`).run().catch(() => undefined);
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
  for (const ns of ["capsid", "sample"]) {
    await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)").bind(ns, JSON.stringify([{ repo: "example-org/sample", label: "primary" }])).run();
  }
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  await env.DB.prepare(
    `INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at)
     VALUES ('agent_driver000001', 'capsid-driver', 'driver', ?1, ?2, 'github:dustin', '2026-09-11 00:00:00')`
  )
    .bind(await sha256Hex(DRIVER_KEY), serializeScopes(scopes))
    .run();
  await env.APP_KV.put("ops:snapshot", JSON.stringify(snapshot));
  await env.APP_KV.put("improve:awaiting-seat", JSON.stringify([{ namespace: "capsid", repo: "example-org/sample", number: 7, failed: "paths_not_refused", why: "touches a protected path", at: "2026-10-08T09:00:00.000Z" }]));
});

describe("GET /ops/inbox", () => {
  it("answers 401 to a request with no credential", async () => {
    expect((await inboxAs(null)).status).toBe(401);
  });

  it("gives a one-namespace driver its own app only, with every source counted and the pull request as the link", async () => {
    await blocked("capsid", "Add the health route", `Merge ${PR} once CI is green`);
    await blocked("sample", "Not for this driver", "needs the seat");
    const response = await inboxAs(DRIVER_KEY);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=30");
    expect(response.headers.get("Access-Control-Allow-Origin"), "a server reads this, so no CORS").toBeNull();
    const body = (await response.json()) as Inbox;
    expect(body.apps.map((a) => a.namespace)).toEqual(["capsid"]);
    const app = body.apps[0];
    expect(app.items.map((i) => i.kind).sort()).toEqual(["blocked-job", "ci", "pr"]);
    expect(app.count).toBe(3);
    expect(app.severity).toBe("needs-you");
    expect(app.items.find((i) => i.kind === "blocked-job")?.link).toBe(PR);
    expect(app.items.find((i) => i.kind === "pr")?.link).toBe("https://github.com/example-org/sample/pull/7");
    expect(JSON.stringify(body), "another namespace's job title leaked to a scoped caller").not.toContain("Not for this driver");
    expect(body.count).toBe(3);
  });

  it("gives the admin every app: a question and a down site under a namespace with no site row, and quiet configured apps at none", async () => {
    await blocked("sample", "Choose a name", "Which name do you want?", true);
    const response = await inboxAs(env.TEST_OPERATOR_KEYS.write);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as Inbox;
    const sample = body.apps.find((a) => a.namespace === "sample");
    expect(sample?.items.map((i) => i.kind).sort()).toEqual(["question", "site-down"]);
    expect(sample?.severity).toBe("needs-you");
    const quiet = body.apps.find((a) => a.namespace === "dustinedwards");
    expect(quiet, "a configured app with nothing waiting still appears").toBeDefined();
    expect(quiet).toMatchObject({ count: 0, severity: "none", items: [] });
    expect(body.count).toBe(body.apps.reduce((n, a) => n + a.count, 0));
  });

  it("a site that is down and nothing else is failing, not needs-you", async () => {
    const response = await inboxAs(env.TEST_OPERATOR_KEYS.write);
    const body = (await response.json()) as Inbox;
    expect(body.apps.find((a) => a.namespace === "sample")).toMatchObject({ count: 1, severity: "failing" });
  });

  it("an unreadable awaiting-seat list and snapshot do not fail the inbox, they read as nothing", async () => {
    await env.APP_KV.put("improve:awaiting-seat", "not json");
    await env.APP_KV.put("ops:snapshot", "{{{");
    await blocked("capsid", "Still counted", "needs the seat");
    const response = await inboxAs(DRIVER_KEY);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Inbox;
    expect(body.apps[0].items.map((i) => i.kind)).toEqual(["blocked-job"]);
  });
});

describe("improve_status carries the same answer per namespace", () => {
  it("needs_dustin matches what the route serves for that namespace", async () => {
    await blocked("capsid", "Add the health route", `Merge ${PR}`);
    const status = await improveStatus(jobsEnv(), "capsid");
    const capsid = status.namespaces.find((n) => n.namespace === "capsid");
    expect(capsid?.needs_dustin.count).toBe(3);
    expect(capsid?.needs_dustin.severity).toBe("needs-you");
  });
});

// What an app reports about itself (src/inbox-report.ts; Dustin's answers 2026-10-10),
// posted with the app's own key and read back through GET /ops/inbox and improve_status.
describe("POST /ops/inbox/report", () => {
  const CAPSID_ORIGIN = "https://capsid.dustin-edwards.workers.dev";
  const report = (bearer: string | null, body: unknown) =>
    SELF.fetch(`${ORIGIN}/ops/inbox/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });
  const drafts = { namespace: "capsid", items: [{ title: "Four AI drafts wait for review", link: `${CAPSID_ORIGIN}/drafts` }] };

  beforeEach(async () => {
    for (const { name } of (await env.APP_KV.list({ prefix: "inbox:report" })).keys) await env.APP_KV.delete(name);
  });

  it("answers 401 with no key and 403 to a key reporting for a namespace it does not hold, storing nothing", async () => {
    expect((await report(null, drafts)).status).toBe(401);
    const other = await report(DRIVER_KEY, { namespace: "sample", items: [{ title: "Not mine" }] });
    expect(other.status, await other.clone().text()).toBe(403);
    expect(await env.APP_KV.get("inbox:report:sample")).toBeNull();
  });

  it("stores the app's report, which the inbox counts as needs-you and improve_status fences as external", async () => {
    const posted = await report(DRIVER_KEY, drafts);
    expect(posted.status, await posted.clone().text()).toBe(200);
    const body = (await (await inboxAs(DRIVER_KEY)).json()) as Inbox;
    const item = body.apps[0].items.find((i) => i.kind === "report");
    expect(item).toMatchObject({ title: "Four AI drafts wait for review", link: `${CAPSID_ORIGIN}/drafts` });
    expect(body.apps[0].severity).toBe("needs-you");
    const status = await improveStatus(jobsEnv(), "capsid");
    const relayed = status.namespaces.find((n) => n.namespace === "capsid")?.needs_dustin.items.find((i) => i.kind === "report");
    expect(relayed?.title).toBe("~~~external source=inbox-report ref=capsid\nFour AI drafts wait for review\n~~~");
  });

  it("refuses a second report inside the minute, and a link off the app's own origin", async () => {
    const offOrigin = await report(DRIVER_KEY, { namespace: "capsid", items: [{ title: "x", link: "https://elsewhere.example.com/" }] });
    expect(offOrigin.status).toBe(400);
    expect((await report(DRIVER_KEY, drafts)).status).toBe(200);
    const again = await report(DRIVER_KEY, { namespace: "capsid", items: [] });
    expect(again.status).toBe(429);
    const body = (await (await inboxAs(DRIVER_KEY)).json()) as Inbox;
    expect(body.apps[0].items.some((i) => i.kind === "report"), "the refused report replaced the stored one").toBe(true);
  });

  it("a report over 6 hours old no longer counts", async () => {
    const old = new Date(Date.now() - (6 * 3600 + 60) * 1000).toISOString();
    await env.APP_KV.put("inbox:report:capsid", JSON.stringify({ namespace: "capsid", reported_at: old, reported_by: "agent:capsid-driver", items: [{ title: "stale", kind: "report", link: null, since: old }] }));
    const body = (await (await inboxAs(DRIVER_KEY)).json()) as Inbox;
    expect(body.apps[0].items.some((i) => i.kind === "report")).toBe(false);
  });
});
