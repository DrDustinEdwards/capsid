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
    // job was noise (Dustin, 2026-09-26). The console lists blocked jobs with their
    // commands; alerting is a separate item.
    await seed("job_longblocked0", { status: "blocked", posted_by: "github:DrDustinEdwards", updated_at: hoursAgo(48) });
    const { findings, ran } = await gatherFindings(env_, NOW);
    expect(findings.filter((f) => f.fingerprint.startsWith("blocked-"))).toEqual([]);
    expect([...ran] as string[]).not.toContain("blocked jobs");
  });
});
