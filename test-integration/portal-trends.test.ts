import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { AUTO_MERGED_APPROVAL_REASON } from "../src/approval-executor";
import type { Env } from "../src/env";
import type { PortalTrends } from "../src/ops-types";
import { portalSessionCookie } from "../src/portal-auth";
import { PORTAL_TRENDS_PATH } from "../src/portal-trends";
import { readTrends } from "../src/trends";

// The trends route's SQL against the D1 the migrations build, and its R2 listing. The
// series are read at a fixed time in 2030, so nothing another test wrote falls in the
// window. No GitHub is reachable here, so every CI repo is in not_read, which is the case
// the route must say rather than draw as green. Fake data only: namespace "sample".

const NOW = new Date("2030-01-16T12:00:00.000Z"); // a Wednesday; its week starts 2030-01-14
const SECRET = "integration-portal-trends-key";

async function job(id: string, status: string, created: string, updated: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO jobs (id, namespace, title, body, status, priority, gate_required, posted_by, created_at, updated_at)
     VALUES (?1, 'sample', ?2, 'do the thing', ?3, 0, 0, 'github:sample', ?4, ?5)`
  )
    .bind(id, `trends ${id}`, status, created, updated)
    .run();
}

async function audit(actor: string, action: string, at: string, params: unknown = {}): Promise<void> {
  await env.DB.prepare("INSERT INTO audit_log (actor, action, namespace, path, params, at) VALUES (?1, ?2, 'sample', NULL, ?3, ?4)")
    .bind(actor, action, JSON.stringify(params), at)
    .run();
}

async function touch(kind: string, actorKind: string, at: string): Promise<void> {
  await env.DB.prepare("INSERT INTO job_touches (job_id, namespace, kind, actor, actor_kind, at) VALUES ('job_000000000001', 'sample', ?1, 'access:admin@example.com', ?2, ?3)")
    .bind(kind, actorKind, at)
    .run();
}

describe("the trends series", () => {
  it("PLANT: minutes, the queue and merges are counted from the rows that happened", async () => {
    // Minutes: two writes four minutes apart and a touch, one session of 5 minutes; a
    // driver's write is not the administrator's.
    await audit("access:admin@example.com", "job-resumed", "2030-01-15 09:00:00");
    await audit("access:admin@example.com", "job-superseded", "2030-01-15 09:04:00");
    await touch("resume", "human", "2030-01-15T09:04:30.000Z");
    await touch("note", "human", "2030-01-15T09:04:40.000Z");
    await audit("agent:sample-driver", "job-claimed", "2030-01-15 15:00:00");

    // Queue: one job open since before the window, one posted and ended inside it, one
    // posted and still queued, one that ended before the window.
    await job("job_00000000000a", "blocked", "2029-12-01T00:00:00.000Z", "2030-01-10T00:00:00.000Z");
    await job("job_00000000000b", "done", "2030-01-12T08:00:00.000Z", "2030-01-14T08:00:00.000Z");
    await job("job_00000000000c", "queued", "2030-01-15T08:00:00.000Z", "2030-01-15T08:00:00.000Z");
    await job("job_00000000000d", "failed", "2029-12-01T00:00:00.000Z", "2029-12-20T00:00:00.000Z");

    // Merges this week: one by the policy, one by an approval, one by the seat, one closed
    // from the Portal and one from chat; a comment is none of these.
    await audit("system:auto-merge", "auto-merged", "2030-01-14 10:00:00");
    await audit("system:executor", "approved-merged", "2030-01-14 11:00:00");
    // The policy's merge also closed an approval it held: the same merge, counted once.
    await audit("system:auto-merge", "approved-merged", "2030-01-14 10:00:01", { reason: AUTO_MERGED_APPROVAL_REASON });
    await audit("access:admin@example.com", "manage_pr", "2030-01-14 12:00:00", { action: "merge", merged: true });
    await audit("access:admin@example.com", "pr-closed", "2030-01-14 13:00:00");
    await audit("access:admin@example.com", "manage_pr", "2030-01-14 14:00:00", { action: "close" });
    await audit("access:admin@example.com", "manage_pr", "2030-01-14 15:00:00", { action: "comment" });
    await env.DB.prepare(
      "INSERT INTO deploy_outcomes (repo, namespace, run_id, head_sha, pr, outcome, run_at) VALUES ('example-org/sample', 'sample', 7, ?1, 12, 'rolled_back', '2030-01-15T10:00:00.000Z')"
    )
      .bind("a".repeat(40))
      .run();

    // Backups: one complete run today, one run with no marker.
    await env.MEDIA.put("backups/json/2030-01-16T03-10-00-000Z/_complete.json", "{}");
    await env.MEDIA.put("backups/json/2030-01-15T03-10-00-000Z/documents.json", "[]");

    const t = await readTrends(env as unknown as Env, NOW, 2);

    expect(t.minutes.weeks.map((w) => w.week)).toEqual(["2030-W02", "2030-W03"]);
    const thisWeek = t.minutes.weeks[1]!;
    // The 09:00 session: 09:00 to 09:04:40, plus a minute, rounds to 6. The administrator's
    // own merge, two closes and the comment on Monday (below) are four more one-minute
    // sessions, an hour apart. The driver's write is none of them.
    expect(thisWeek).toMatchObject({ start: "2030-01-14", sessions: 5, minutes: 10, decisions: 1 });

    const day = (d: string) => t.queue.find((q) => q.day === d)!;
    expect(t.queue).toHaveLength(14);
    expect(day("2030-01-03")).toMatchObject({ posted: 0, ended: 0, open: 1 });
    expect(day("2030-01-12")).toMatchObject({ posted: 1, ended: 0, open: 2 });
    expect(day("2030-01-14")).toMatchObject({ posted: 0, ended: 1, open: 1 });
    expect(day("2030-01-15")).toMatchObject({ posted: 1, ended: 0, open: 2 });

    expect(t.merges.weeks[1]).toMatchObject({ auto: 1, approved: 1, seat: 1, closed: 2 });
    expect(t.merges.rollbacks).toEqual([{ at: "2030-01-15T10:00:00.000Z", repo: "example-org/sample", pr: 12, outcome: "rolled_back" }]);

    expect(t.backups.error).toBeNull();
    expect(t.backups.slots!.daily.filter((s) => s.filled).map((s) => s.key)).toEqual(["2030-01-16"]);

    expect(t.ci.repos).toEqual([]);
    expect(t.ci.not_read.length).toBeGreaterThan(0);
  });

  it("answers the admin's session through the Worker, and refuses a bad weeks with 400", async () => {
    const cookie = (await portalSessionCookie({ email: "admin@example.com" }, SECRET, new Date())).split(";")[0];
    const get = async (qs: string) => {
      const ctx = createExecutionContext();
      const res = (await worker.fetch!(
        new Request(`https://capsid.test${PORTAL_TRENDS_PATH}${qs}`, { headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" }, redirect: "manual" }) as never,
        { ...env, COOKIE_ENCRYPTION_KEY: SECRET } as never,
        ctx
      )) as unknown as Response;
      await waitOnExecutionContext(ctx);
      return res;
    };
    const ok = await get("?weeks=4");
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
    const body = (await ok.json()) as PortalTrends;
    expect(body.weeks).toBe(4);
    expect(body.minutes.weeks).toHaveLength(4);
    expect(body.minutes.note).toMatch(/estimate/);
    for (const bad of ["?weeks=0", "?weeks=27", "?weeks=two"]) expect((await get(bad)).status, bad).toBe(400);
  });
});
