import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { blockJob, claimJob, completeJob, failJob, jobsSummary, listJobs } from "../src/jobs";
import { capsidStatus } from "../src/status";
import { jobDocPath } from "../src/jobs-schema";
import { splitSignedTask, verifySignedBody } from "../src/signed-docs";
import {
  auditActions,
  post,
  resetJobs,
  DRIVER_ACTOR,
  DRIVER,
  OTHER,
  NOW,
  jobRow,
  jobsEnv,
  TEST_SECRET,
} from "./jobs-fixture";

// The work queue against a real D1 (jobs.test.ts): the mirrored document, list, the improve_status block and the signature.

beforeEach(resetJobs);

describe("the mirrored document", () => {
  it("tracks the row through every transition, and carries the signed prompt", async () => {
    const posted = await post({ title: "mirrored", body: "the full prompt" });
    const id = posted.job!.id;
    const path = jobDocPath(id);

    const readDoc = async () =>
      env.DB.prepare(
        "SELECT title, body, status FROM documents WHERE namespace = 'capsid' AND path = ?1",
      )
        .bind(path)
        .first<{ title: string; body: string; status: string }>();

    const atPost = await readDoc();
    expect(atPost, `no mirrored document at capsid/${path}`).toBeTruthy();
    expect(atPost!.title).toBe("Job: mirrored");
    expect(atPost!.body).toContain("status: **queued**");

    // The prompt in the document is the signed body, byte for byte, so a driver that
    // reads the document verifies the same bytes. Checked through the real verifier.
    const prompt = atPost!.body.slice(atPost!.body.indexOf("## The prompt"));
    const signedPart = prompt.slice(prompt.indexOf("---\n"));
    expect(splitSignedTask(signedPart).body.trim()).toBe("the full prompt");
    const verdict = await verifySignedBody(TEST_SECRET, signedPart, "job document");
    expect(verdict.ok, "reason" in verdict ? verdict.reason : "").toBe(true);

    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    expect((await readDoc())!.body).toContain("status: **claimed**");
    expect((await readDoc())!.body).toContain(DRIVER_ACTOR);

    await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "landed" });
    const atDone = await readDoc();
    expect(atDone!.body).toContain("status: **done**");
    expect(atDone!.body).toContain("landed");
    // A done job's document is closed, so brief stops carrying it as open work.
    expect(atDone!.status).toBe("closed");

    // Every rewrite snapshotted the one it replaced: three writes, two snapshots.
    const versions = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM document_versions WHERE namespace = 'capsid' AND path = ?1",
    )
      .bind(path)
      .first<{ n: number }>();
    expect(versions?.n).toBeGreaterThanOrEqual(2);
  });

  it("PLANT: a failed job's document is closed too, because failed is terminal", async () => {
    // A failed job is as finished as a done one, so its mirror must not stay active.
    const posted = await post({ title: "failed is terminal" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    await failJob(jobsEnv(), DRIVER, NOW, id, "could not reach the thing");

    const doc = await env.DB.prepare(
      "SELECT body, status FROM documents WHERE namespace = 'capsid' AND path = ?1",
    )
      .bind(jobDocPath(id))
      .first<{ body: string; status: string }>();
    expect(doc!.body).toContain("status: **failed**");
    expect(doc!.status).toBe("closed");
  });

  it("a blocked job's document stays active, because blocked is a pause", async () => {
    // A blocked job is waiting for a human and is still open work, so brief must keep
    // carrying it.
    const posted = await post({ title: "blocked is not terminal" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    await blockJob(jobsEnv(), DRIVER, NOW, id, {
      reason: "needs a push",
      command: "git push origin HEAD",
    });

    const doc = await env.DB.prepare(
      "SELECT body, status FROM documents WHERE namespace = 'capsid' AND path = ?1",
    )
      .bind(jobDocPath(id))
      .first<{ body: string; status: string }>();
    expect(doc!.body).toContain("status: **blocked**");
    expect(doc!.status).toBe("active");
  });
});

describe("list", () => {
  it("filters by namespace and status, highest priority first", async () => {
    await post({ title: "low", priority: 0 });
    await post({ title: "high", priority: 10 });
    await post({ title: "elsewhere", namespace: "germomics" });

    const capsid = await listJobs(jobsEnv(), { namespace: "capsid" });
    expect(capsid.jobs!.map((j) => j.title)).toEqual(["high", "low"]);

    const everything = await listJobs(jobsEnv(), {});
    expect(everything.jobs!).toHaveLength(3);

    const claimed = await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    expect(claimed.job!.title).toBe("high");
    const stillQueued = await listJobs(jobsEnv(), { namespace: "capsid", status: "queued" });
    expect(stillQueued.jobs!.map((j) => j.title)).toEqual(["low"]);
  });

  it("carries no body, unless one job is named and the body was asked for", async () => {
    // The column list is SQL a fake cannot check.
    const posted = await post({ title: "has a body" });
    const id = posted.job!.id;

    const listed = await listJobs(jobsEnv(), { namespace: "capsid" });
    expect(listed.jobs!.length).toBeGreaterThan(0);
    for (const job of listed.jobs!) expect(job).not.toHaveProperty("body");

    // withBody without an id is ignored: a whole-namespace list never carries bodies.
    const wide = await listJobs(jobsEnv(), { namespace: "capsid" }, { withBody: true });
    for (const job of wide.jobs!) expect(job).not.toHaveProperty("body");

    const one = await listJobs(jobsEnv(), { namespace: "capsid", id }, { withBody: true });
    expect(one.jobs!).toHaveLength(1);
    expect((one.jobs![0] as { body?: string }).body).toContain("capsid-task-signature");

    const oneNoBody = await listJobs(jobsEnv(), { namespace: "capsid", id });
    expect(oneNoBody.jobs![0]).not.toHaveProperty("body");
  });
});

describe("the improve_status jobs block", () => {
  it("counts the open states per namespace and hands back the blocked jobs themselves", async () => {
    // Four jobs in three states, plus one in another namespace that must not be
    // counted here.
    await post({ title: "waiting" });
    const running = await post({ title: "running" });
    const stuck = await post({ title: "stuck", gate_required: true });
    const finished = await post({ title: "finished" });
    await post({ title: "elsewhere", namespace: "germomics" });

    await claimJob(jobsEnv(), DRIVER, NOW, { id: running.job!.id });
    await claimJob(jobsEnv(), OTHER, NOW, { id: stuck.job!.id });
    await blockJob(jobsEnv(), OTHER, NOW, stuck.job!.id, {
      reason: "the deploy needs confirming",
      command: "npm run deploy",
    });
    await claimJob(jobsEnv(), OTHER, NOW, { id: finished.job!.id });
    await completeJob(jobsEnv(), OTHER, NOW, finished.job!.id, { result_summary: "done" });

    const summary = await jobsSummary(env.DB, "capsid", NOW);
    expect(summary.queued).toBe(1);
    expect(summary.claimed).toBe(1);
    expect(summary.blocked).toBe(1);
    // done_today keys on the day the row was last touched, and completeJob stamped
    // it with the clock this test passed in.
    expect(summary.done_today).toBe(1);

    // The blocked jobs come back as rows, with the command in them.
    expect(summary.blocked_jobs).toHaveLength(1);
    expect(summary.blocked_jobs[0].id).toBe(stuck.job!.id);
    expect(summary.blocked_jobs[0].title).toBe("stuck");
    expect(String(summary.blocked_jobs[0].waiting_on)).toContain("npm run deploy");

    // The other namespace is not in these numbers.
    const other = await jobsSummary(env.DB, "germomics", NOW);
    expect(other.queued).toBe(1);
    expect(other.blocked_jobs).toEqual([]);
  });

  it("a namespace with no jobs reports zeroes, not an absent block", async () => {
    // A missing block and an empty queue are different facts.
    const summary = await jobsSummary(env.DB, "foxing", NOW);
    expect(summary).toEqual({
      queued: 0,
      claimed: 0,
      blocked: 0,
      done_today: 0,
      blocked_jobs: [],
      claimed_jobs: [],
    });
  });

  it("improve_status carries the block for every namespace it reports", async () => {
    await post({ title: "visible in status" });
    const status = await capsidStatus(jobsEnv(), "capsid");
    expect(status.namespaces).toHaveLength(1);
    expect(status.namespaces[0].jobs.queued).toBe(1);
    // Every namespace in the report has one, so a consumer never has to check.
    const all = await capsidStatus(jobsEnv());
    for (const ns of all.namespaces) {
      expect(ns.jobs, `${ns.namespace} has no jobs block`).toBeTruthy();
    }
  });
});

describe("the signature", () => {
  it("a body edited after post is refused at claim, and the job is failed rather than left queued", async () => {
    const posted = await post({ title: "tampered", body: "do the safe thing" });
    const id = posted.job!.id;

    // The row edited the way a raw D1 splice would: a job body is executable input
    // for a session holding local shell and repo credentials.
    await env.DB.prepare("UPDATE jobs SET body = ?2 WHERE id = ?1")
      .bind(id, posted.job!.body.replace("do the safe thing", "do the dangerous thing"))
      .run();

    const claimed = await claimJob(jobsEnv(), DRIVER, NOW, { id });
    expect(claimed.ok).toBe(false);
    expect(claimed.refusal).toMatch(/failed its signature check/);
    expect(claimed.refusal).toMatch(/does not match its body/);

    // Failed, not left queued, which would hand the broken row to every next driver.
    const stored = await jobRow(id);
    expect(stored?.status).toBe("failed");
    expect(String(stored?.result_summary)).toMatch(/does not match its body/);

    // The refusal is audited.
    expect(await auditActions(id)).toContain("job-signature-refused");
  });
});
