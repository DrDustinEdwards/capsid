import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { APP_ROSTER } from "../src/roster";
import type { PortalDigest, PortalPlan } from "../src/ops-types/views";
import type { PortalPerformed, PortalPreview } from "../src/ops-types/portal";
import { PORTAL_DIGEST_PATH, PORTAL_PLAN_PATH } from "../src/portal-overnight";
import { PORTAL_ACTIONS } from "../src/controls-base";
import { PORTAL_PERFORM_PATH, PORTAL_PREVIEW_PATH } from "../src/portal-actions";
import { OVERNIGHT_MODE_KEY } from "../src/overnight";
import { AWAITING_SEAT_KEY } from "../src/auto-merge-tick";
import { jobRow } from "./jobs-fixture";
import {
  CSRF,
  NOW,
  ACTOR,
  call,
  postedJob,
  auditRows,
  KEYS,
  resetPortal,
} from "./portal-actions-fixtures";
import { CASES } from "./portal-actions-cases";

// The Portal's controls through the whole Worker against a real D1 and KV: every action
// previewed, checked to have written nothing, then performed from its token, and the
// rows it wrote read back. The refusals were carried over from the old page's
// job-action tests when /console was deleted, so none of its cases lost coverage.

beforeEach(resetPortal);

describe("every action, previewed then performed through the Worker", () => {
  it("covers the allow-list", () => {
    expect(Object.keys(CASES).sort()).toEqual([...PORTAL_ACTIONS].sort());
  });

  for (const action of PORTAL_ACTIONS) {
    it(`${action}: the preview writes nothing, and the perform writes the rows the preview listed`, async () => {
      const params = await CASES[action].params();
      const auditBefore = await auditRows();
      const kvBefore = await Promise.all(KEYS.map((k) => env.APP_KV.get(k)));
      const jobBefore = params.id ? await jobRow(params.id) : null;

      const previewed = await call(PORTAL_PREVIEW_PATH, {
        method: "POST",
        body: { action, params },
      });
      expect(previewed.status, await previewed.clone().text()).toBe(200);
      const preview = (await previewed.json()) as PortalPreview;
      expect(await auditRows(), "the preview wrote an audit row").toEqual(auditBefore);
      expect(
        await Promise.all(KEYS.map((k) => env.APP_KV.get(k))),
        "the preview wrote to KV",
      ).toEqual(kvBefore);
      if (params.id)
        expect(await jobRow(params.id), "the preview moved the job").toEqual(jobBefore);

      const performed = await call(PORTAL_PERFORM_PATH, {
        method: "POST",
        body: { token: preview.token },
      });
      expect(performed.status, await performed.clone().text()).toBe(200);
      const body = (await performed.json()) as PortalPerformed;
      expect(body.action).toBe(action);
      expect(body.warning).toBeNull();
      expect(body.feed.csrf).toBe(CSRF);
      expect(body.feed.live.namespaces.map((n) => n.name)).toEqual([...APP_ROSTER]);
      await CASES[action].after(params);

      // The rows written are the rows the preview said would be. A job transition
      // writes its action twice, once for the job and once for its mirror document, so
      // the comparison is of distinct "<action> by <actor>" lines.
      const written = (await auditRows()).filter((r) => !auditBefore.some((b) => b.id === r.id));
      expect([...new Set(written.map((r) => `${r.action} by ${r.actor}`))].sort()).toEqual(
        [...preview.audit].sort(),
      );
      const click = written.find((r) => r.action === `portal-${action}`);
      expect(click?.actor).toBe(ACTOR);
    });
  }
});

describe("parked jobs, the Tonight plan and the digest", () => {
  it("a parked job stays in the feed with its reason, and Unpark's Undo writes portal-undo-unpark_job", async () => {
    const id = await postedJob("a job to park and bring back");
    const park = (await (
      await call(PORTAL_PREVIEW_PATH, {
        method: "POST",
        body: { action: "park_job", params: { id, reason: "comes back on Monday" } },
      })
    ).json()) as PortalPreview;
    const parked = (await (
      await call(PORTAL_PERFORM_PATH, { method: "POST", body: { token: park.token } })
    ).json()) as PortalPerformed;
    const inFeed = parked.feed.live.jobs.find((j) => j.id === id);
    expect(inFeed?.status).toBe("parked");
    expect(inFeed?.parked_reason).toBe("comes back on Monday");
    const undo = (await (
      await call(PORTAL_PREVIEW_PATH, {
        method: "POST",
        body: {
          action: "unpark_job",
          params: { id, reason: "Undo: comes back on Monday", undo: "true" },
        },
      })
    ).json()) as PortalPreview;
    expect(undo.audit).toContain(`portal-undo-unpark_job by ${ACTOR}`);
    expect(
      (await call(PORTAL_PERFORM_PATH, { method: "POST", body: { token: undo.token } })).status,
    ).toBe(200);
    expect((await jobRow(id))?.status).toBe("queued");
  });

  it("GET /portal/api/plan and /portal/api/digest serve the jobs tool's readers, over every namespace", async () => {
    const id = await postedJob("a job for tonight");
    const plan = await call(PORTAL_PLAN_PATH);
    expect(plan.status, await plan.clone().text()).toBe(200);
    const planned = (await plan.json()) as PortalPlan;
    expect(planned.queued_read).toBeGreaterThanOrEqual(1);
    expect(
      [...planned.lanes.flatMap((l) => l.jobs), ...planned.skipped].some((j) => j.id === id),
    ).toBe(true);
    expect("for_namespace" in planned).toBe(false);
    const digest = await call(`${PORTAL_DIGEST_PATH}?since=2026-01-01`);
    expect(digest.status, await digest.clone().text()).toBe(200);
    expect(((await digest.json()) as PortalDigest).since).toBe("2026-01-01T00:00:00.000Z");
    expect((await call(`${PORTAL_DIGEST_PATH}?since=soon`)).status).toBe(400);
  });
});

describe("the approval record against real D1", () => {
  it("approving again voids the open approval as replaced, and Undo voids the new one as undone, each with its row", async () => {
    await env.DB.prepare("DELETE FROM pr_approvals").run();
    await env.APP_KV.put("gh:token:v3:example/capsid", "test-token");
    await env.APP_KV.put(
      AWAITING_SEAT_KEY,
      JSON.stringify([
        {
          namespace: "capsid",
          repo: "example/capsid",
          number: 41,
          failed: "path_class",
          why: "a src change",
          at: NOW.toISOString(),
          class: "approve",
          path_class: "src-routine",
          class_reasons: [],
        },
      ]),
    );
    const act = async (params: Record<string, string>) => {
      const preview = (await (
        await call(PORTAL_PREVIEW_PATH, { method: "POST", body: { action: "approve_pr", params } })
      ).json()) as PortalPreview;
      const performed = await call(PORTAL_PERFORM_PATH, {
        method: "POST",
        body: { token: preview.token },
      });
      expect(performed.status, await performed.clone().text()).toBe(200);
      return preview;
    };
    await act({ namespace: "capsid", prs: "41", shas: "c".repeat(40) });
    const again = await act({ namespace: "capsid", prs: "41", shas: "c".repeat(40) });
    expect(again.audit).toContain(`pr-approval-voided by ${ACTOR}`);
    const undo = await act({ namespace: "capsid", prs: "41", undo: "true" });
    expect(undo.audit).toContain(`portal-undo-approve_pr by ${ACTOR}`);
    const { results } = await env.DB.prepare(
      "SELECT status, close_reason FROM pr_approvals ORDER BY id",
    ).all<{ status: string; close_reason: string | null }>();
    expect(results).toEqual([
      { status: "voided", close_reason: "replaced" },
      { status: "voided", close_reason: "undone" },
    ]);
    await env.APP_KV.delete("gh:token:v3:example/capsid");
    await env.APP_KV.delete(AWAITING_SEAT_KEY);
  });
});

describe("the automation switches against real D1 and KV", () => {
  it("overnight refuses a missing reason at preview, and writes nothing", async () => {
    const auditBefore = await auditRows();
    const kvBefore = await Promise.all(KEYS.map((k) => env.APP_KV.get(k)));
    for (const [action, params] of [
      ["overnight", { value: "api" }],
      ["overnight", { value: "subscription" }],
    ] as const) {
      const res = await call(PORTAL_PREVIEW_PATH, { method: "POST", body: { action, params } });
      expect(res.status, `${action} without a reason`).toBe(400);
      expect(await res.text()).toMatch(new RegExp(`^${action} needs a reason`));
    }
    expect(await auditRows()).toEqual(auditBefore);
    expect(await Promise.all(KEYS.map((k) => env.APP_KV.get(k)))).toEqual(kvBefore);
  });

  it("a switch and its Undo write their own click rows: portal-overnight, then portal-undo-overnight, each with its reason", async () => {
    const flip = async (params: Record<string, string>) => {
      const preview = (await (
        await call(PORTAL_PREVIEW_PATH, { method: "POST", body: { action: "overnight", params } })
      ).json()) as PortalPreview;
      const performed = await call(PORTAL_PERFORM_PATH, {
        method: "POST",
        body: { token: preview.token },
      });
      expect(performed.status, await performed.clone().text()).toBe(200);
      return preview;
    };
    await flip({ value: "api", reason: "queued jobs are waiting" });
    expect(await env.APP_KV.get(OVERNIGHT_MODE_KEY)).toBe("api");
    const undo = await flip({
      value: "off",
      reason: "Undo: queued jobs are waiting",
      undo: "true",
    });
    expect(undo.audit).toContain(`portal-undo-overnight by ${ACTOR}`);
    expect(await env.APP_KV.get(OVERNIGHT_MODE_KEY)).toBe("off");
    const clicks = (await auditRows()).filter((r) => r.action.endsWith("overnight"));
    expect(clicks.map((r) => r.action)).toEqual(["portal-overnight", "portal-undo-overnight"]);
    expect(JSON.parse(clicks[0].params)).toMatchObject({ reason: "queued jobs are waiting" });
    expect(JSON.parse(clicks[0].params).undo).toBeUndefined();
    expect(JSON.parse(clicks[1].params)).toMatchObject({
      reason: "Undo: queued jobs are waiting",
      undo: true,
    });
  });
});
