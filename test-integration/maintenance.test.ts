import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { postJob } from "../src/jobs";
import { gatherMaintenance, maintenanceTick, readMaintenance, MAINTENANCE_LAST_KEY } from "../src/maintenance";
import { legacyAgent } from "../src/agents";
import type { PrReaders } from "../src/maintenance-prs";

// The daily maintenance pass against a real D1 (job_549550d73d4e). The rules are planted
// one at a time beside a clean job each must leave alone.

const SECRET = "test-root-secret";
const ADMIN = legacyAgent("write", "github:DrDustinEdwards");
const NOW = new Date("2026-10-08T12:00:00.000Z");
const PR = "https://github.com/example-org/sample/pull/7";
// The pull request rules read GitHub; here every repo has no open pull request, so the job
// rules are seen alone. The pull request rules are tested in test/maintenance.test.ts.
const NO_PRS: PrReaders = {
  openPrs: async () => ({ repo: "example-org/sample", prs: [], problem: null }),
  failingStep: async () => ({ step: null, problem: "not called" }),
};

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

async function post(title: string, body = "do the thing"): Promise<string> {
  const posted = await postJob(jobsEnv(), ADMIN, NOW, { namespace: "sample", title, body });
  expect(posted.ok, posted.refusal).toBe(true);
  return posted.job!.id;
}

beforeEach(async () => {
  for (const table of ["jobs", "audit_log", "job_outcomes", "job_outcome_prs", "job_touches"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run().catch(() => undefined);
  }
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
    .bind("sample", JSON.stringify([{ repo: "example-org/sample", label: "primary" }]))
    .run();
  await env.APP_KV.delete("maintenance:list");
  await env.APP_KV.delete(MAINTENANCE_LAST_KEY);
});

describe("gatherMaintenance", () => {
  it("lists a queued LATER job whose date has passed, and leaves a future one alone", async () => {
    const past = await post("LATER 2026-10-01: move the cron");
    await post("LATER 2026-12-01: rename the tool");
    const list = await gatherMaintenance(env as never, NOW, NO_PRS);
    expect(list.items.filter((i) => i.rule === "later-passed").map((i) => i.job)).toEqual([past]);
  });

  it("lists a queued job whose pull request merged under another job, and not a prefix match", async () => {
    const shipped = await post("Add the health route", `Open ${PR} when done.`);
    const other = await post("Unrelated work", "See https://github.com/example-org/sample/pull/70 for context.");
    const done = await post("The job that shipped it");
    await env.DB.prepare("INSERT INTO job_outcome_prs (job_id, pr_url, merged) VALUES (?1, ?2, 1)").bind(done, PR).run();
    const list = await gatherMaintenance(env as never, NOW, NO_PRS);
    const found = list.items.filter((i) => i.rule === "shipped-elsewhere");
    expect(found.map((i) => i.job)).toEqual([shipped]);
    expect(found[0].line).toContain(done);
    expect(found.map((i) => i.job)).not.toContain(other);
  });

  it("lists a finished job that promised follow-ups when none was posted since, and not when one was", async () => {
    const promised = await post("Design the thing");
    await env.DB.prepare("UPDATE jobs SET status = 'done', result_summary = ?2, created_at = ?3, updated_at = ?4 WHERE id = ?1")
      .bind(promised, "Design done. The build will follow as separate jobs.", "2026-10-06T00:00:00.000Z", "2026-10-07T00:00:00.000Z")
      .run();
    let list = await gatherMaintenance(env as never, NOW, NO_PRS);
    expect(list.items.filter((i) => i.rule === "followups-missing").map((i) => i.job)).toEqual([promised]);

    // A job posted after it moved is the follow-up. (postJob stamps created_at from `now`.)
    const later = await postJob(jobsEnv(), ADMIN, new Date("2026-10-07T06:00:00.000Z"), { namespace: "sample", title: "Build the thing", body: "go" });
    expect(later.ok, later.refusal).toBe(true);
    list = await gatherMaintenance(env as never, NOW, NO_PRS);
    expect(list.items.filter((i) => i.rule === "followups-missing")).toEqual([]);
  });

  it("reports a job the merge-resume step resumed in the last day, and not an older one", async () => {
    const recent = await post("Resumed today");
    const old = await post("Resumed last week");
    const touch = (id: string, at: string) =>
      env.DB.prepare("INSERT INTO job_touches (job_id, namespace, kind, actor, actor_kind, at) VALUES (?1, 'sample', 'resume', 'system:merge-resume', 'system', ?2)").bind(id, at).run();
    await touch(recent, "2026-10-08T06:00:00.000Z");
    await touch(old, "2026-10-01T06:00:00.000Z");
    const list = await gatherMaintenance(env as never, NOW, NO_PRS);
    expect(list.items.filter((i) => i.rule === "auto-resumed").map((i) => i.job)).toEqual([recent]);
  });

  it("stays quiet on a clean queue", async () => {
    await post("An ordinary queued job");
    expect((await gatherMaintenance(env as never, NOW, NO_PRS)).items).toEqual([]);
  });
});

describe("maintenanceTick", () => {
  it("does not run before 11:00 UTC, runs once a day after, and stores the list", async () => {
    await post("LATER 2026-10-01: stale");
    const early = await maintenanceTick(env as never, new Date("2026-10-08T09:00:00.000Z"), NO_PRS);
    expect(early.ran).toBe(false);
    expect(await readMaintenance(env as never)).toBeNull();

    const first = await maintenanceTick(env as never, NOW, NO_PRS);
    expect(first.ran).toBe(true);
    expect((await readMaintenance(env as never))?.items.map((i) => i.rule)).toEqual(["later-passed"]);
    // Every roster repo was read, and the count says so: zero open pull requests, not none read.
    expect(Object.values((await readMaintenance(env as never))?.prs_read ?? {})).toEqual([0, 0, 0, 0, 0, 0, 0]);

    const second = await maintenanceTick(env as never, new Date("2026-10-08T15:00:00.000Z"), NO_PRS);
    expect(second.ran).toBe(false);
    const nextDay = await maintenanceTick(env as never, new Date("2026-10-09T12:00:00.000Z"), NO_PRS);
    expect(nextDay.ran).toBe(true);
  });
});
