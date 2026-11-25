import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { grantAgent } from "../src/agents";
import type { PortalPreview } from "../src/ops-types/portal";
import { PORTAL_PREVIEW_PATH } from "../src/portal-actions";
import { jobRow } from "./jobs-fixture";
import { call, blockedJob, auditRows, resetPortal, performToken } from "./portal-actions-fixtures";

beforeEach(resetPortal);

describe("the job actions against real D1", () => {
  it("resume: the preview says the queue, and why, when the job was blocked by a shared identity, and the perform sends it there", async () => {
    const id = await blockedJob(
      "blocked by a shared identity",
      grantAgent("write", "access:someone@example.com"),
    );
    const previewed = await call(PORTAL_PREVIEW_PATH, {
      method: "POST",
      body: { action: "resume_job", params: { id, reason: "approved" } },
    });
    const preview = (await previewed.json()) as PortalPreview;
    expect(preview.changes[0]).toMatch(/blocked -> queued/);
    expect(preview.changes[0]).toMatch(/shared identity/);
    const performed = await performToken(preview.token);
    expect(performed.status, await performed.clone().text()).toBe(200);
    expect((await jobRow(id))?.status).toBe("queued");
  });

  it("a second perform of the same token is refused as already used, and writes no click row; a fresh preview is refused by the transition", async () => {
    const id = await blockedJob("resumed twice");
    const preview = (await (
      await call(PORTAL_PREVIEW_PATH, {
        method: "POST",
        body: { action: "resume_job", params: { id, reason: "approved" } },
      })
    ).json()) as PortalPreview;
    expect((await performToken(preview.token)).status).toBe(200);
    const clicks = (await auditRows()).filter((r) => r.action === "portal-resume_job").length;
    const again = await performToken(preview.token);
    expect(again.status).toBe(409);
    expect(await again.text()).toMatch(/already used/);
    const fresh = await call(PORTAL_PREVIEW_PATH, {
      method: "POST",
      body: { action: "resume_job", params: { id, reason: "approved" } },
    });
    expect(fresh.status).toBe(400);
    expect(await fresh.text()).toMatch(/not blocked/);
    expect((await auditRows()).filter((r) => r.action === "portal-resume_job").length).toBe(clicks);
  });

  it("fail: a job id that does not exist is refused, rather than reported as a no-op that worked", async () => {
    await blockedJob("some other job");
    const res = await call(PORTAL_PREVIEW_PATH, {
      method: "POST",
      body: { action: "fail_job", params: { id: "job_missing", reason: "x" } },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/no job job_missing/);
  });

  it("fail and resume need a reason, say so, and write nothing", async () => {
    const id = await blockedJob("needs a reason");
    await env.DB.prepare("DELETE FROM audit_log").run();
    for (const action of ["fail_job", "resume_job"]) {
      const res = await call(PORTAL_PREVIEW_PATH, {
        method: "POST",
        body: { action, params: { id } },
      });
      expect(res.status, `${action} without a reason`).toBe(400);
      expect(await res.text()).toMatch(/reason|what you approved/i);
    }
    expect(await auditRows()).toEqual([]);
    expect((await jobRow(id))?.status).toBe("blocked");
  });

  it("resume REFUSES a job whose body was edited after it was signed, at perform, and the job stays blocked", async () => {
    // Editing a blocked job makes resume re-verify the signature; the Portal must show that refusal, not report success.
    const id = await blockedJob("edited while blocked");
    const preview = (await (
      await call(PORTAL_PREVIEW_PATH, {
        method: "POST",
        body: { action: "resume_job", params: { id, reason: "approved" } },
      })
    ).json()) as PortalPreview;
    await env.DB.prepare("UPDATE jobs SET body = ?2 WHERE id = ?1")
      .bind(id, "---\ncapsid-task-signature: deadbeef\n---\ntampered")
      .run();
    const res = await performToken(preview.token);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/signature|does not match its body/i);
    expect((await jobRow(id))?.status).not.toBe("claimed");
    expect(
      (await auditRows()).some((r) => r.action === "portal-resume_job"),
      "a refused resume wrote a click row",
    ).toBe(false);
  });

  it("release: the preview refuses a blocked job, and fail refuses a finished one", async () => {
    const blocked = await blockedJob("still blocked");
    const release = await call(PORTAL_PREVIEW_PATH, {
      method: "POST",
      body: { action: "release_job", params: { id: blocked, reason: "x" } },
    });
    expect(release.status).toBe(400);
    expect(await release.text()).toMatch(/not claimed/);
    await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE id = ?1").bind(blocked).run();
    const fail = await call(PORTAL_PREVIEW_PATH, {
      method: "POST",
      body: { action: "fail_job", params: { id: blocked, reason: "x" } },
    });
    expect(fail.status).toBe(400);
    expect(await fail.text()).toMatch(/already done/);
  });
});
