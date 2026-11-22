import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  blockJob,
  claimJob,
  editJob,
  listJobs,
  parkJob,
  returnDueParked,
  resumeJob,
  unparkJob,
} from "../src/jobs";
import { gatherInbox } from "../src/inbox";
import { jobDocPath } from "../src/jobs-schema";
import { verifySignedBody } from "../src/signed-docs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server";
import {
  auditActions,
  post,
  resetJobs,
  SEAT,
  DRIVER,
  OTHER,
  at,
  LATER,
  SEAT_AGENT,
  plain,
  NOW,
  jobRow,
  jobsEnv,
  TEST_SECRET,
} from "./jobs-fixture";

// The work queue against a real D1 (jobs.test.ts): edit and park.

beforeEach(resetJobs);

const PLAIN_DRIVER = plain(DRIVER);

describe("edit", () => {
  // The seat correcting a job nobody is working (src/jobs-edit.ts). The legacy callers
  // above are admin, so the driver here has the admin bit and can_merge taken away, as a
  // minted driver does.

  async function versionCount(id: string): Promise<number> {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM job_versions WHERE job_id = ?1")
      .bind(id)
      .first<{ n: number }>();
    return r?.n ?? 0;
  }

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM job_versions").run();
  });

  it("a driver is refused, and the job is left as it was", async () => {
    const posted = await post({ title: "driver edit", body: "do the safe thing" });
    const id = posted.job!.id;
    const out = await editJob(jobsEnv(), PLAIN_DRIVER, LATER, id, { body: "do the other thing" });
    expect(out.ok).toBe(false);
    expect(out.refusal).toMatch(/cannot edit a job/);
    expect((await jobRow(id))?.body).toBe(posted.job!.body);
    expect(await versionCount(id)).toBe(0);
    expect(await auditActions(id)).not.toContain("job-edited");
  });

  it("a claimed job is refused, even for the seat", async () => {
    const posted = await post({ title: "claimed edit", body: "do the safe thing" });
    const id = posted.job!.id;
    expect((await claimJob(jobsEnv(), DRIVER, NOW, { id })).ok).toBe(true);
    const out = await editJob(jobsEnv(), SEAT_AGENT, LATER, id, {
      body: "do the other thing",
      priority: 9,
    });
    expect(out.ok).toBe(false);
    expect(out.refusal).toMatch(/is claimed/);
    const stored = await jobRow(id);
    expect(stored?.body).toBe(posted.job!.body);
    expect(stored?.priority).toBe(0);
    expect(await versionCount(id)).toBe(0);
  });

  it("the edited body is signed as at post: it verifies, and claim hands it out", async () => {
    const posted = await post({ title: "signed edit", body: "do the first thing" });
    const id = posted.job!.id;
    const out = await editJob(jobsEnv(), SEAT_AGENT, LATER, id, { body: "do the corrected thing" });
    expect(out.ok, out.refusal).toBe(true);
    const stored = String((await jobRow(id))?.body);
    expect(stored).not.toBe(posted.job!.body);
    const verdict = await verifySignedBody(TEST_SECRET, stored, "job body");
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.body).toBe("do the corrected thing");
    const claimed = await claimJob(jobsEnv(), DRIVER, LATER, { id });
    expect(claimed.ok, claimed.refusal).toBe(true);
    expect(claimed.job!.body).toContain("do the corrected thing");
  });

  it("a blocked job may be edited, and resume verifies the new body", async () => {
    const posted = await post({ title: "blocked edit", body: "do the first thing" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    expect(
      (await blockJob(jobsEnv(), DRIVER, NOW, id, { reason: "gate", command: "git push origin x" }))
        .ok,
    ).toBe(true);
    const out = await editJob(jobsEnv(), SEAT_AGENT, LATER, id, {
      body: "do the corrected thing",
      gate_required: true,
    });
    expect(out.ok, out.refusal).toBe(true);
    expect(out.job!.status).toBe("blocked");
    const resumed = await resumeJob(jobsEnv(), SEAT_AGENT, LATER, id, "seat approved the push");
    expect(resumed.ok, resumed.refusal).toBe(true);
    expect((await jobRow(id))?.gate_required).toBe(1);
  });

  it("each edit keeps the version it replaced, readable newest first through jobs list for the id", async () => {
    const posted = await post({ title: "first title", body: "do the first thing", priority: 1 });
    const id = posted.job!.id;
    expect(
      (await editJob(jobsEnv(), SEAT_AGENT, LATER, id, { title: "second title", priority: 5 })).ok,
    ).toBe(true);
    const second = await editJob(jobsEnv(), SEAT_AGENT, at("2026-09-10T12:10:00.000Z"), id, {
      body: "do the second thing",
    });
    expect(second.ok, second.refusal).toBe(true);

    const server = buildServer(jobsEnv(), SEAT_AGENT);
    const client = new Client({ name: "jobs-edit", version: "1.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    const result = (await client.callTool({
      name: "capsid_work_jobs",
      arguments: { action: "list", id },
    })) as { content: Array<{ text: string }> };
    await client.close();
    const listed = JSON.parse(result.content[0].text) as {
      versions?: Array<Record<string, unknown>>;
      jobs: Array<Record<string, unknown>>;
    };
    expect(listed.jobs[0].title).toBe("second title");
    expect(listed.versions).toHaveLength(2);
    expect(listed.versions![0]).toMatchObject({
      title: "second title",
      priority: 5,
      gate_required: 0,
      body: posted.job!.body,
      edited_by: SEAT,
      edited_at: "2026-09-10T12:10:00.000Z",
    });
    expect(listed.versions![1]).toMatchObject({
      title: "first title",
      priority: 1,
      gate_required: 0,
      body: posted.job!.body,
      edited_by: SEAT,
      edited_at: LATER.toISOString(),
    });

    // The mirror is rewritten with the row, and the edit is audited.
    const doc = await env.DB.prepare(
      "SELECT body FROM documents WHERE namespace = 'capsid' AND path = ?1",
    )
      .bind(jobDocPath(id))
      .first<{ body: string }>();
    expect(doc!.body).toContain("second title");
    expect(doc!.body).toContain("do the second thing");
    expect(await auditActions(id)).toContain("job-edited");
  });

  it("a title another open job holds is refused, naming that job", async () => {
    const holder = await post({ title: "taken title" });
    const other = await post({ title: "free title" });
    const out = await editJob(jobsEnv(), SEAT_AGENT, LATER, other.job!.id, {
      title: "taken title",
    });
    expect(out.ok).toBe(false);
    expect(out.refusal).toContain(holder.job!.id);
    expect((await jobRow(other.job!.id))?.title).toBe("free title");
    expect(await versionCount(other.job!.id)).toBe(0);
  });
});

describe("park", () => {
  // The seat setting a queued job aside: wanted, but not now (src/jobs-park.ts). The driver
  // has the admin bit and can_merge taken away, as a minted driver does.
  const WHY = "comes back when the keys question is answered";

  it("a driver is refused, for park and for unpark, and the job is left as it was", async () => {
    const id = (await post({ title: "driver park" })).job!.id;
    const parkOut = await parkJob(jobsEnv(), PLAIN_DRIVER, LATER, id, WHY);
    expect(parkOut.ok).toBe(false);
    expect(parkOut.refusal).toMatch(/cannot park a job/);
    expect((await jobRow(id))?.status).toBe("queued");
    expect(await auditActions(id)).not.toContain("job-parked");

    expect((await parkJob(jobsEnv(), SEAT_AGENT, LATER, id, WHY)).ok).toBe(true);
    const unparkOut = await unparkJob(jobsEnv(), PLAIN_DRIVER, LATER, id);
    expect(unparkOut.ok).toBe(false);
    expect(unparkOut.refusal).toMatch(/cannot unpark a job/);
    expect((await jobRow(id))?.status).toBe("parked");
  });

  it("a reason is required, in one line", async () => {
    const id = (await post({ title: "reason park" })).job!.id;
    for (const bad of [undefined, "", "   ", "two\nlines", "x".repeat(301)]) {
      const out = await parkJob(jobsEnv(), SEAT_AGENT, LATER, id, bad);
      expect(out.ok, JSON.stringify(bad)).toBe(false);
      expect(out.refusal).toMatch(/needs a reason in one line/);
    }
    expect((await jobRow(id))?.status).toBe("queued");
  });

  it("only a queued job is parked: a claimed job and a blocked job are refused, even for the seat", async () => {
    const claimedId = (await post({ title: "claimed park" })).job!.id;
    expect((await claimJob(jobsEnv(), DRIVER, NOW, { id: claimedId })).ok).toBe(true);
    const claimedOut = await parkJob(jobsEnv(), SEAT_AGENT, LATER, claimedId, WHY);
    expect(claimedOut.ok).toBe(false);
    expect(claimedOut.refusal).toMatch(/is claimed/);
    expect((await jobRow(claimedId))?.status).toBe("claimed");

    expect(
      (
        await blockJob(jobsEnv(), DRIVER, NOW, claimedId, {
          reason: "needs a push",
          command: "git push",
        })
      ).ok,
    ).toBe(true);
    const blockedOut = await parkJob(jobsEnv(), SEAT_AGENT, LATER, claimedId, WHY);
    expect(blockedOut.ok).toBe(false);
    expect(blockedOut.refusal).toMatch(/is blocked/);
    expect((await jobRow(claimedId))?.status).toBe("blocked");
  });

  it("a parked job is never claimed, stays listed with its reason, and its mirror and audit row are written", async () => {
    const parkedId = (await post({ title: "parked job", priority: 50 })).job!.id;
    const otherId = (await post({ title: "other job", priority: 1 })).job!.id;
    const out = await parkJob(jobsEnv(), SEAT_AGENT, LATER, parkedId, WHY);
    expect(out.ok).toBe(true);
    expect(out.job?.status).toBe("parked");

    // The higher-priority job is parked, so the next claim in the namespace takes the other.
    const claimed = await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    expect(claimed.job?.id).toBe(otherId);
    // And a claim that names the parked job is refused.
    const named = await claimJob(jobsEnv(), OTHER, NOW, { id: parkedId });
    expect(named.ok).toBe(false);
    expect((await jobRow(parkedId))?.status).toBe("parked");

    const listed = await listJobs(jobsEnv(), { namespace: "capsid", status: "parked" });
    expect(listed.jobs?.map((j) => j.id)).toEqual([parkedId]);
    expect(listed.jobs?.[0]?.result_summary).toBe(WHY);
    const mirror = await env.DB.prepare(
      "SELECT status FROM documents WHERE namespace = 'capsid' AND path = ?1",
    )
      .bind(jobDocPath(parkedId))
      .first<{ status: string }>();
    expect(mirror?.status).toBe("active");
    expect(await auditActions(parkedId)).toContain("job-parked");
  });

  it("unpark returns the job to queued and clears the reason", async () => {
    const id = (await post({ title: "back again" })).job!.id;
    expect((await parkJob(jobsEnv(), SEAT_AGENT, LATER, id, WHY)).ok).toBe(true);
    const out = await unparkJob(jobsEnv(), SEAT_AGENT, LATER, id);
    expect(out.ok).toBe(true);
    const stored = await jobRow(id);
    expect(stored?.status).toBe("queued");
    expect(stored?.result_summary).toBeNull();
    expect((await claimJob(jobsEnv(), DRIVER, NOW, { id })).ok).toBe(true);
    expect(await auditActions(id)).toEqual(expect.arrayContaining(["job-parked", "job-unparked"]));
    // A job that is not parked is not unparked.
    expect((await unparkJob(jobsEnv(), SEAT_AGENT, LATER, id)).refusal).toMatch(/not parked/);
  });

  it("a parked job holds no title slot, so unpark is refused, naming the job, when the title was reposted", async () => {
    const parkedId = (await post({ title: "same title" })).job!.id;
    expect((await parkJob(jobsEnv(), SEAT_AGENT, LATER, parkedId, WHY)).ok).toBe(true);
    const repost = await post({ title: "same title" });
    expect(repost.ok).toBe(true);
    const out = await unparkJob(jobsEnv(), SEAT_AGENT, LATER, parkedId);
    expect(out.ok).toBe(false);
    expect(out.refusal).toContain(repost.job!.id);
    expect((await jobRow(parkedId))?.status).toBe("parked");
  });

  it("a due date returns the job on the tick, and a due job whose title was taken stays parked once, shown in the inbox", async () => {
    const DUE = "2026-09-11T00:00:00.000Z";
    const dueId = (await post({ title: "comes back tomorrow" })).job!.id;
    expect((await parkJob(jobsEnv(), SEAT_AGENT, LATER, dueId, WHY, "2026-09-10")).refusal).toMatch(
      /already passed/,
    );
    expect((await parkJob(jobsEnv(), SEAT_AGENT, LATER, dueId, WHY, "2026-09-11")).ok).toBe(true);
    expect((await jobRow(dueId))?.parked_until).toBe(DUE);
    // Not due yet: the tick leaves it.
    expect((await returnDueParked(jobsEnv(), at("2026-09-10T23:59:00.000Z"))).returned).toEqual([]);

    const takenId = (await post({ title: "taken while parked" })).job!.id;
    expect((await parkJob(jobsEnv(), SEAT_AGENT, LATER, takenId, WHY, DUE)).ok).toBe(true);
    const repost = (await post({ title: "taken while parked" })).job!.id;

    const tick = at("2026-09-11T00:05:00.000Z");
    const report = await returnDueParked(jobsEnv(), tick);
    expect(report.returned).toEqual([dueId]);
    expect(report.kept.map((k) => k.id)).toEqual([takenId]);
    expect(report.kept[0]?.why).toContain(repost);
    const back = await jobRow(dueId);
    expect(back?.status).toBe("queued");
    expect(back?.parked_until).toBeNull();
    expect(back?.result_summary).toBeNull();
    expect(await auditActions(dueId)).toContain("job-unparked");
    expect((await jobRow(takenId))?.status).toBe("parked");
    expect(await auditActions(takenId)).toContain("job-park-due-kept");

    // The kept job is not tried again on the next tick, and the inbox shows it as due.
    const next = await returnDueParked(jobsEnv(), at("2026-09-11T00:20:00.000Z"));
    expect(next.kept).toEqual([]);
    const inbox = await gatherInbox(jobsEnv(), at("2026-09-11T00:20:00.000Z"), ["capsid"]);
    const items = inbox.apps.flatMap((a) => a.items);
    expect(items.find((i) => i.job === takenId)?.kind).toBe("parked-due");
    expect(items.find((i) => i.job === dueId)).toBeUndefined();
  });
});
