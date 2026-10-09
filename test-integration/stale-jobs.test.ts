import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Agent } from "../src/agents";
import { defaultScopes } from "../src/agents-schema";
import { MERGE_RESUME_ACTOR } from "../src/jobs-seat";
import { mergeResumeTick } from "../src/merge-resume";
import worker from "../src/index";
import type { Env } from "../src/env";
import type { PortalStale } from "../src/ops-types";
import { portalSessionCookie } from "../src/portal-auth";
import { PORTAL_STALE_PATH } from "../src/portal-stale";
import { buildServer } from "../src/server";
import { STALE_PRS_KEY, staleJobs, type StalePrCache } from "../src/stale-jobs";

// The stale view (stale jobs D5) against a real D1 and KV: each rule's row is planted
// beside a clean job that rule must leave out, rows are aged by direct SQL, and the
// merge-resume step's cache is read back from APP_KV. job_touches is append-only, so its
// rows are inserted and never deleted; every read joins them to jobs, which is emptied
// before each test. Fake data only: namespaces "sample" and "other", example.com repos.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Real time, not a fixed date: the jobs tool reads the clock itself.
let NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

let seq = 0;
function jobId(): string {
  seq += 1;
  return `job_5a1e${Date.now().toString(16).slice(-4)}${seq.toString(16).padStart(4, "0")}`;
}

async function plant(
  status: string,
  updatedAgo: number,
  over: { namespace?: string; result_ref?: string; title?: string } = {}
): Promise<string> {
  const id = jobId();
  const held = status === "claimed" || status === "blocked" ? "agent:sample-driver" : null;
  await env.DB.prepare(
    `INSERT INTO jobs (id, namespace, title, body, status, priority, gate_required, posted_by, claimed_by, result_ref, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'do the thing', ?4, 0, 0, 'github:sample', ?5, ?6, ?7, ?7)`
  )
    .bind(id, over.namespace ?? "sample", over.title ?? `stale view ${id}`, status, held, over.result_ref ?? null, ago(updatedAgo))
    .run();
  return id;
}

async function autoResumedAt(id: string, at: string, namespace = "sample"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO job_touches (job_id, namespace, kind, actor, actor_kind, detail, at) VALUES (?1, ?2, 'resume', ?3, 'system', NULL, ?4)`
  )
    .bind(id, namespace, MERGE_RESUME_ACTOR, at)
    .run();
}

async function putCache(cache: StalePrCache): Promise<void> {
  await env.APP_KV.put(STALE_PRS_KEY, JSON.stringify(cache));
}

function scopedReader(namespace: string): Agent {
  const scopes = defaultScopes([namespace]);
  scopes.grants = ["read"];
  return { id: "agent_5a1e5a1e5a1e", name: "sample-reader", kind: "driver", actor: "agent:sample-reader", scopes, admin: false, row: null };
}

async function callJobs(agent: Agent, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
  const server = buildServer(env as never, agent);
  const client = new Client({ name: "stale-jobs", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    const result = (await client.callTool({ name: "jobs", arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: result.isError, text: result.content[0].text };
  } finally {
    await client.close();
  }
}

beforeEach(async () => {
  NOW = new Date();
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.APP_KV.delete(STALE_PRS_KEY);
});

describe("staleJobs", () => {
  it("lists each rule's job with its reason, and leaves out the clean job beside each", async () => {
    // unchanged
    const blockedOld = await plant("blocked", 4 * DAY);
    const claimedOld = await plant("claimed", 3 * DAY + HOUR);
    const blockedFresh = await plant("blocked", 2 * DAY);
    const queuedOld = await plant("queued", 10 * DAY);
    const doneOld = await plant("done", 10 * DAY);
    // resumed-not-completed
    const resumedOld = await plant("claimed", 30 * HOUR);
    await autoResumedAt(resumedOld, ago(30 * HOUR));
    const resumedFresh = await plant("claimed", 2 * HOUR);
    await autoResumedAt(resumedFresh, ago(2 * HOUR));
    const resumedDone = await plant("done", 30 * HOUR);
    await autoResumedAt(resumedDone, ago(40 * HOUR));
    // prs-settled
    const settled = await plant("blocked", HOUR);
    const stillOpen = await plant("blocked", HOUR);
    const readBeforeChange = await plant("blocked", HOUR);
    await putCache({
      [settled]: { merged: 1, closed: 1, open: 0, unread: 0, at: ago(5 * 60 * 1000) },
      [stillOpen]: { merged: 1, closed: 0, open: 1, unread: 0, at: ago(5 * 60 * 1000) },
      [readBeforeChange]: { merged: 2, closed: 0, open: 0, unread: 0, at: ago(2 * HOUR) },
    });

    const out = await staleJobs(env as never, NOW, { namespace: "sample" });
    const byId = new Map(out.rows.map((r) => [r.id, r]));
    expect(byId.get(blockedOld)?.rule).toBe("unchanged");
    expect(byId.get(blockedOld)?.reason).toMatch(/^blocked and unchanged since .*\(4 days\)$/);
    expect(byId.get(claimedOld)?.rule).toBe("unchanged");
    expect(byId.get(resumedOld)?.rule).toBe("resumed-not-completed");
    expect(byId.get(resumedOld)?.reason).toMatch(/30 hours later$/);
    expect(byId.get(settled)?.rule).toBe("prs-settled");
    expect(byId.get(settled)?.reason).toMatch(/1 merged, 1 closed without merging/);
    for (const clean of [blockedFresh, queuedOld, doneOld, resumedFresh, resumedDone, stillOpen, readBeforeChange]) {
      expect(byId.has(clean), `${clean} should not be stale`).toBe(false);
    }
    expect(out.rows).toHaveLength(4);
    expect(out.truncated).toBe(false);
    expect(out.note).toBeUndefined();
  });

  it("narrows to the namespace named, and with none reads every namespace", async () => {
    const mine = await plant("blocked", 4 * DAY);
    const theirs = await plant("blocked", 4 * DAY, { namespace: "other" });
    expect((await staleJobs(env as never, NOW, { namespace: "sample" })).rows.map((r) => r.id)).toEqual([mine]);
    expect((await staleJobs(env as never, NOW)).rows.map((r) => r.id).sort()).toEqual([mine, theirs].sort());
  });

  it("a damaged cache is said in the note and the other rules still answer", async () => {
    const blockedOld = await plant("blocked", 4 * DAY);
    await env.APP_KV.put(STALE_PRS_KEY, "{not json");
    const out = await staleJobs(env as never, NOW, { namespace: "sample" });
    expect(out.rows.map((r) => r.id)).toEqual([blockedOld]);
    expect(out.note).toMatch(/pull request cache could not be fully read/);
  });
});

describe("the merge-resume step's cache", () => {
  it("records the counts for a blocked job it read, and drops the entry of a job no longer blocked", async () => {
    // GitHub is not reachable from the test runtime and "sample" maps no repo, so the read
    // is unread: the job is not resumed and not settled.
    const blocked = await plant("blocked", HOUR, { result_ref: "https://github.com/example/sample/pull/9" });
    const finished = await plant("done", HOUR);
    await putCache({ [finished]: { merged: 1, closed: 0, open: 0, unread: 0, at: ago(HOUR) } });

    const report = await mergeResumeTick(env as never, NOW);
    expect(report.resumed).toEqual([]);
    expect(report.cache_error).toBeUndefined();
    const cache = JSON.parse((await env.APP_KV.get(STALE_PRS_KEY)) ?? "{}") as StalePrCache;
    expect(Object.keys(cache)).toEqual([blocked]);
    expect(cache[blocked]).toEqual({ merged: 0, closed: 0, open: 0, unread: 1, at: NOW.toISOString() });
    expect((await staleJobs(env as never, NOW, { namespace: "sample" })).rows).toEqual([]);
  });
});

describe("jobs list stale: true, through the tool", () => {
  it("a caller scoped to one namespace must name it, sees only it, and is refused another", async () => {
    const mine = await plant("blocked", 4 * DAY);
    await plant("blocked", 4 * DAY, { namespace: "other" });
    const reader = scopedReader("sample");

    const named = await callJobs(reader, { action: "list", stale: true, namespace: "sample" });
    expect(named.isError, named.text).not.toBe(true);
    const body = JSON.parse(named.text) as { ok: boolean; action: string; stale: Array<{ id: string; rule: string }> };
    expect(body.ok).toBe(true);
    expect(body.action).toBe("list");
    expect(body.stale.map((r) => r.id)).toEqual([mine]);
    expect(body.stale[0].rule).toBe("unchanged");

    const unnamed = await callJobs(reader, { action: "list", stale: true });
    expect(unnamed.isError).toBe(true);
    expect(unnamed.text).toMatch(/must name a namespace/);

    const other = await callJobs(reader, { action: "list", stale: true, namespace: "other" });
    expect(other.isError).toBe(true);
    expect(other.text).toMatch(/not scoped to the 'other' namespace/);
  });

  it("refuses stale with view, status or id, and on any action but list", async () => {
    const reader = scopedReader("sample");
    for (const extra of [{ view: "plan" }, { status: "blocked" }, { id: "job_5a1e00000000" }]) {
      const refused = await callJobs(reader, { action: "list", stale: true, namespace: "sample", ...extra });
      expect(refused.isError, JSON.stringify(extra)).toBe(true);
      expect(refused.text).toMatch(/without view, status or id/);
    }
    const claim = await callJobs(reader, { action: "claim", stale: true, namespace: "sample" });
    expect(claim.isError).toBe(true);
    expect(claim.text).toMatch(/stale is for action list only/);
  });
});

describe("GET /portal/api/stale, through the Worker", () => {
  // The gate itself (a bearer's 403, an anonymous caller's sign-in) is driven for every
  // Portal route in test-integration/route-gates.test.ts.
  it("answers the stale rows of every namespace to the admin's session, uncached", async () => {
    const SECRET = "integration-portal-stale-key";
    const mine = await plant("blocked", 4 * DAY);
    const theirs = await plant("claimed", 4 * DAY, { namespace: "other" });
    await plant("blocked", HOUR);
    const session = (await portalSessionCookie({ email: "admin@example.com" }, SECRET, new Date())).split(";")[0];
    const ctx = createExecutionContext();
    const request = new Request(`https://capsid.test${PORTAL_STALE_PATH}`, { headers: { Cookie: session, "Sec-Fetch-Site": "same-origin" }, redirect: "manual" });
    const response = (await worker.fetch!(request as never, { ...(env as unknown as Env), COOKIE_ENCRYPTION_KEY: SECRET } as never, ctx)) as unknown as Response;
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as PortalStale;
    expect(body.rows.map((r) => r.id).sort()).toEqual([mine, theirs].sort());
    expect(body.rows.every((r) => r.rule === "unchanged")).toBe(true);
    expect(body.truncated).toBe(false);
    expect(body.note).toBeNull();
  });
});
