import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import type { PortalTrends } from "../src/ops-types/views";
import { portalSessionCookie } from "../src/portal-auth";
import { PORTAL_TRENDS_PATH } from "../src/portal-trends";
import { readTrends } from "../src/trends";

// Fixed time in 2030 so no other test's rows fall in the window. No GitHub is reachable, so every CI repo is in not_read,
// which the route must say rather than draw as green.

const NOW = new Date("2030-01-16T12:00:00.000Z"); // a Wednesday; its week starts 2030-01-14
const SECRET = "integration-portal-trends-key";

async function audit(
  actor: string,
  action: string,
  at: string,
  params: unknown = {},
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_log (actor, action, namespace, path, params, at) VALUES (?1, ?2, 'sample', NULL, ?3, ?4)",
  )
    .bind(actor, action, JSON.stringify(params), at)
    .run();
}

describe("the trends series", () => {
  it("PLANT: minutes and deploys are counted from the rows that happened", async () => {
    await audit("access:admin@example.com", "write", "2030-01-15 09:00:00");
    await audit("access:admin@example.com", "agent-revoked", "2030-01-15 09:04:00");
    await audit("agent:sample-driver", "write", "2030-01-15 15:00:00");

    await audit("access:admin@example.com", "manage_pr", "2030-01-14 12:00:00", {
      action: "merge",
      merged: true,
    });
    await audit("access:admin@example.com", "pr-closed", "2030-01-14 13:00:00");
    await audit("access:admin@example.com", "manage_pr", "2030-01-14 14:00:00", {
      action: "close",
    });
    await audit("access:admin@example.com", "manage_pr", "2030-01-14 15:00:00", {
      action: "comment",
    });
    await env.DB.prepare(
      "INSERT INTO deploy_outcomes (repo, namespace, run_id, head_sha, pr, outcome, run_at, restore_seconds) VALUES ('example-org/sample', 'sample', 7, ?1, 12, 'rolled_back', '2030-01-15T10:00:00.000Z', 90)",
    )
      .bind("a".repeat(40))
      .run();
    for (const [id, outcome] of [
      [8, "verified"],
      [9, "verified"],
      [10, "unverified"],
    ] as const) {
      await env.DB.prepare(
        "INSERT INTO deploy_outcomes (repo, namespace, run_id, head_sha, outcome, run_at) VALUES ('example-org/sample', 'sample', ?1, ?2, ?3, '2030-01-14T10:00:00.000Z')",
      )
        .bind(id, "b".repeat(40), outcome)
        .run();
    }

    await env.MEDIA.put("backups/json/2030-01-16T03-10-00-000Z/_complete.json", "{}");
    await env.MEDIA.put("backups/json/2030-01-15T03-10-00-000Z/documents.json", "[]");

    const t = await readTrends(env as unknown as Env, NOW, 2);

    expect(t.minutes.weeks.map((w) => w.week)).toEqual(["2030-W02", "2030-W03"]);
    const thisWeek = t.minutes.weeks[1]!;
    // 09:00 to 09:04 plus a minute is 5; the administrator's own merge, two closes and comment on Monday are four more
    // one-minute sessions an hour apart. The driver's write is none of them.
    expect(thisWeek).toMatchObject({ start: "2030-01-14", sessions: 5, minutes: 9 });

    expect(t.deploys.repos).toEqual([
      {
        repo: "example-org/sample",
        deploys: 4,
        per_week: 2,
        shipped: 2,
        refused: 1,
        rolled_back: 1,
        unverified: 1,
        change_failure_rate: 0.333,
        restore_median_seconds: 90,
      },
    ]);
    expect(t.backups.error).toBeNull();
    expect(t.backups.slots!.daily.filter((s) => s.filled).map((s) => s.key)).toEqual([
      "2030-01-16",
    ]);

    expect(t.ci.repos).toEqual([]);
    expect(t.ci.not_read.length).toBeGreaterThan(0);
  });

  it("answers the admin's session through the Worker, and refuses a bad weeks with 400", async () => {
    const cookie = (
      await portalSessionCookie({ email: "admin@example.com" }, SECRET, new Date())
    ).split(";")[0];
    const get = async (qs: string) => {
      const ctx = createExecutionContext();
      const res = (await worker.fetch!(
        new Request(`https://capsid.test${PORTAL_TRENDS_PATH}${qs}`, {
          headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
          redirect: "manual",
        }) as never,
        { ...env, COOKIE_ENCRYPTION_KEY: SECRET } as never,
        ctx,
      )) as unknown as Response;
      await waitOnExecutionContext(ctx);
      return res;
    };
    const ok = await get("?weeks=4");
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(ok.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await ok.json()) as PortalTrends;
    expect(body.weeks).toBe(4);
    expect(body.minutes.weeks).toHaveLength(4);
    expect(body.minutes.note).toMatch(/estimate/);
    for (const bad of ["?weeks=0", "?weeks=27", "?weeks=two"])
      expect((await get(bad)).status, bad).toBe(400);
  });
});
