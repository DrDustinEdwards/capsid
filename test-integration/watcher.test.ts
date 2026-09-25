import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { BLOCKED_STALE_HOURS, WATCHER_ACTOR, clearFinding, openWatcherFingerprints, readStaleBlocked } from "../src/watcher";

// THE WATCHER'S THREE READS AND WRITES OF THE jobs TABLE, AGAINST A REAL D1.
//
// Moved from test/watcher.test.ts (audit 2026-09-25, item C2-19). Those tests handed
// each function a stub that captured the SQL text and the bound params and asserted
// on them (posted_by = ?1, status = 'queued', RETURNING id, LIMIT 20). Here the rows
// are seeded and the assertions are on which rows come back or change.

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
    // Queued alone was the watcher's half of the 2026-09-18 duplicate: this map is what
    // the pass skips on, so a claimed or blocked copy was invisible to it.
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
    // The reason is the honest word: nobody did the work, it stopped being true.
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

describe("readStaleBlocked", () => {
  it("returns blocked jobs older than the window, oldest first, and at most 20", async () => {
    await seed("job_fresh0000000", { status: "blocked", updated_at: hoursAgo(BLOCKED_STALE_HOURS - 1) });
    await seed("job_queued000000", { status: "queued", updated_at: hoursAgo(BLOCKED_STALE_HOURS + 10) });
    for (let i = 0; i < 22; i++) {
      await seed(`job_stale${String(i).padStart(7, "0")}`, { status: "blocked", updated_at: hoursAgo(BLOCKED_STALE_HOURS + 1 + i) });
    }
    const stale = await readStaleBlocked(env_, NOW);
    // An unbounded read is one that times out on the day it matters.
    expect(stale).toHaveLength(20);
    expect(stale[0].id, "the oldest blocked job must come first").toBe("job_stale0000021");
    expect(stale.map((r) => r.id)).not.toContain("job_fresh0000000");
    expect(stale.map((r) => r.id)).not.toContain("job_queued000000");
  });

  it("the window is BLOCKED_STALE_HOURS: a job just inside it is not stale, one just past it is", async () => {
    await seed("job_inside000000", { status: "blocked", updated_at: new Date(NOW.getTime() - BLOCKED_STALE_HOURS * 3_600_000 + 60_000).toISOString() });
    await seed("job_outside00000", { status: "blocked", updated_at: new Date(NOW.getTime() - BLOCKED_STALE_HOURS * 3_600_000 - 60_000).toISOString() });
    expect((await readStaleBlocked(env_, NOW)).map((r) => r.id)).toEqual(["job_outside00000"]);
  });
});
