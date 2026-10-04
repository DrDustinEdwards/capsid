import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { WATCHER_ACTOR, clearFinding, gatherFindings, openWatcherFingerprints } from "../src/watcher";

// The watcher's reads and writes of the jobs table, against a real D1. The rows
// are seeded and the assertions are on which rows come back or change, not on SQL text.

const env_ = env as unknown as Parameters<typeof clearFinding>[0];
const NOW = new Date("2026-09-12T12:00:00Z");
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();

async function seed(id: string, over: { title?: string; status?: string; posted_by?: string; updated_at?: string } = {}) {
  await env.DB.prepare(
    `INSERT INTO jobs (id, namespace, title, body, status, posted_by, created_at, updated_at)
     VALUES (?1, 'capsid', ?2, 'lorem body', ?3, ?4, ?5, ?5)`
  )
    .bind(id, over.title ?? `a job ${id}`, over.status ?? "queued", over.posted_by ?? WATCHER_ACTOR, over.updated_at ?? hoursAgo(1))
    .run();
}

async function row(id: string) {
  return env.DB.prepare("SELECT status, result_summary FROM jobs WHERE id = ?1").bind(id).first<{ status: string; result_summary: string | null }>();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM jobs").run();
});

describe("openWatcherFingerprints", () => {
  it("reads every OPEN job the watcher itself posted, and nothing else", async () => {
    // The pass skips on this map, so a claimed or blocked copy must be in it or the
    // watcher posts a duplicate.
    await seed("job_000000000001", { title: "Watcher: queued [fp-queued]", status: "queued" });
    await seed("job_000000000002", { title: "Watcher: claimed [fp-claimed]", status: "claimed" });
    await seed("job_000000000003", { title: "Watcher: blocked [fp-blocked]", status: "blocked" });
    await seed("job_000000000004", { title: "Watcher: done [fp-done]", status: "done" });
    await seed("job_000000000005", { title: "Watcher: failed [fp-failed]", status: "failed" });
    await seed("job_000000000006", { title: "Somebody else's [fp-other]", posted_by: "github:DrDustinEdwards" });
    await seed("job_000000000007", { title: "a job with no fingerprint" });

    const open = await openWatcherFingerprints(env_);
    expect(Object.fromEntries(open)).toEqual({
      "fp-queued": "job_000000000001",
      "fp-claimed": "job_000000000002",
      "fp-blocked": "job_000000000003",
    });
  });
});

describe("clearFinding", () => {
  it("closes the watcher's own queued job as cleared", async () => {
    await seed("job_000000000001");
    expect(await clearFinding(env_, "job_000000000001", NOW)).toBe(true);
    // "cleared": nobody did the work, the finding stopped being true.
    expect(await row("job_000000000001")).toEqual({ status: "failed", result_summary: "cleared" });
  });

  it("closes the job's mirror document in the same write, and leaves a claimed job's mirror alone", async () => {
    // The stranded-mirror bug: the row failed while documents.status stayed active.
    for (const id of ["job_000000000010", "job_000000000011"]) {
      await seed(id, id.endsWith("11") ? { status: "claimed" } : {});
      await env.DB.prepare(
        "INSERT INTO documents (namespace, path, title, body, type, tags, status) VALUES ('capsid', ?1, 't', 'b', 'task', 'jobs', 'active')"
      )
        .bind(`jobs/${id}.md`)
        .run();
    }
    const mirror = (id: string) =>
      env.DB.prepare("SELECT status FROM documents WHERE path = ?1").bind(`jobs/${id}.md`).first<{ status: string }>();
    expect(await clearFinding(env_, "job_000000000010", NOW)).toBe(true);
    expect(await clearFinding(env_, "job_000000000011", NOW)).toBe(false);
    expect((await mirror("job_000000000010"))?.status).toBe("closed");
    expect((await mirror("job_000000000011"))?.status).toBe("active");
  });

  it("cannot close a job a driver claimed, nor somebody else's job, and reports false when it moved nothing", async () => {
    await seed("job_000000000002", { status: "claimed" });
    await seed("job_000000000003", { posted_by: "github:DrDustinEdwards" });
    expect(await clearFinding(env_, "job_000000000002", NOW), "a claimed job was closed underneath its driver").toBe(false);
    expect(await clearFinding(env_, "job_000000000003", NOW), "somebody else's job was closed").toBe(false);
    expect(await clearFinding(env_, "job_missing00000", NOW)).toBe(false);
    expect((await row("job_000000000002"))?.status).toBe("claimed");
    expect((await row("job_000000000003"))?.status).toBe("queued");
  });
});

describe("a job blocked on a human is not a watcher finding", () => {
  it("a job blocked for two days produces no blocked- finding and no job", async () => {
    // Every blocked job waits on a person by construction, so a reminder per blocked
    // job was noise (Dustin, 2026-09-26). The Portal lists blocked jobs with their
    // commands; alerting is a separate item.
    await seed("job_longblocked0", { status: "blocked", posted_by: "github:DrDustinEdwards", updated_at: hoursAgo(48) });
    const { findings, ran } = await gatherFindings(env_, NOW);
    expect(findings.filter((f) => f.fingerprint.startsWith("blocked-"))).toEqual([]);
    expect([...ran] as string[]).not.toContain("blocked jobs");
  });
});

describe("migrations/0030, the mirror backfill", () => {
  // Already run on an empty store at setup, so its statements run again over seeded rows.
  const backfill = env.TEST_MIGRATIONS.find((m) => m.name === "0030_close_finished_job_mirrors.sql");
  const statusOf = (id: string) =>
    env.DB.prepare("SELECT status FROM documents WHERE path = ?1").bind(`jobs/${id}.md`).first<{ status: string }>();

  it("closes the active mirror of every finished job, snapshots and audits each, and leaves open jobs and other documents alone", async () => {
    expect(backfill, "no migration named 0030_close_finished_job_mirrors.sql").toBeTruthy();
    const jobs: Array<[string, string]> = [
      ["job_bf0000000001", "failed"],
      ["job_bf0000000002", "done"],
      ["job_bf0000000003", "superseded"],
      ["job_bf0000000004", "queued"],
      ["job_bf0000000005", "claimed"],
      ["job_bf0000000006", "blocked"],
    ];
    for (const [id, status] of jobs) {
      await seed(id, { status });
      await env.DB.prepare(
        "INSERT INTO documents (namespace, path, title, body, type, tags, status) VALUES ('capsid', ?1, 't', 'b', 'task', 'jobs', 'active')"
      )
        .bind(`jobs/${id}.md`)
        .run();
    }
    // A document that is not a mirror, and an already closed mirror.
    await env.DB.prepare(
      "INSERT INTO documents (namespace, path, title, body, type, status) VALUES ('capsid', 'jobs/job_bf0000000001-notes.md', 't', 'b', 'task', 'active')"
    ).run();

    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'job-mirror-closed'").first<{ n: number }>();
    for (const query of backfill!.queries) await env.DB.prepare(query).run();
    const audited = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'job-mirror-closed'").first<{ n: number }>();
    const versions = await env.DB.prepare("SELECT COUNT(*) AS n FROM document_versions WHERE path LIKE 'jobs/job_bf%'").first<{ n: number }>();

    for (const [id, status] of jobs) {
      const finished = ["failed", "done", "superseded"].includes(status);
      expect((await statusOf(id))?.status, `${id} (${status})`).toBe(finished ? "closed" : "active");
    }
    expect((await statusOf("job_bf0000000001-notes"))?.status).toBe("active");
    expect(audited!.n - before!.n).toBe(3);
    expect(versions!.n).toBe(3);

    // Run again: nothing left to close, so nothing more is written.
    for (const query of backfill!.queries) await env.DB.prepare(query).run();
    const again = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'job-mirror-closed'").first<{ n: number }>();
    expect(again!.n).toBe(audited!.n);
  });
});
