import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { dueForReverify, outcomePrStatements, reverifyPr, reverifyStatements, reverifySweep } from "../src/outcome-prs";

// OUTCOME MERGE STATE, AGAINST A REAL D1 (job_3e1596235513).
//
// These replace source-text tests in test/outcome-prs.test.ts. The rules are about
// what the SQL does: a count recomputed rather than incremented, a filter and an
// order on the sweep, a limit that binds. GitHub is never reached here: no namespace
// is registered, so every pull request read fails, which is the path an unreachable
// GitHub takes.

type Env = Parameters<typeof reverifySweep>[0];
const ENV = env as unknown as Env;
const NOW = new Date("2026-09-10T12:00:00.000Z");
const PR = (n: number) => `https://github.com/o/r/pull/${n}`;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM job_outcome_prs").run();
  await env.DB.prepare("DELETE FROM job_outcomes").run();
  await env.DB.prepare("DELETE FROM jobs").run();
});

async function outcome(jobId: string, over: { recorded_at?: string; prs_merged?: number | null; result_kind?: string } = {}) {
  await env.DB.prepare(
    `INSERT INTO job_outcomes (job_id, agent, namespace, prs_opened, prs_merged, commits, files_changed, tests_added, ci_green,
       blocked_count, resumed_count, duration_minutes, result_kind, verified, recorded_at)
     VALUES (?1, 'opkey:aaaabbbbcccc', 'capsid', 1, ?2, 6, 19, 75, 1, 1, 1, 42, ?3, '{}', ?4)`
  )
    .bind(jobId, over.prs_merged === undefined ? 0 : over.prs_merged, over.result_kind ?? "pr", over.recorded_at ?? "2026-09-09T12:00:00.000Z")
    .run();
}

async function prRow(jobId: string, url: string, merged: number | null, verifiedAt: string | null) {
  await env.DB.prepare("INSERT INTO job_outcome_prs (job_id, pr_url, merged, merge_verified_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(jobId, url, merged, verifiedAt)
    .run();
}

async function outcomeRow(jobId: string) {
  return env.DB.prepare("SELECT * FROM job_outcomes WHERE job_id = ?1").bind(jobId).first<Record<string, unknown>>();
}

describe("reverifyStatements", () => {
  it("recomputes the merged count rather than incrementing it, and touches nothing else it cannot verify", async () => {
    await outcome("job_twice");
    await prRow("job_twice", PR(1), null, null);
    const before = await outcomeRow("job_twice");
    await env.DB.batch(reverifyStatements(env.DB, "job_twice", PR(1), true, NOW));
    await env.DB.batch(reverifyStatements(env.DB, "job_twice", PR(1), true, NOW));
    const after = await outcomeRow("job_twice");
    expect(after?.prs_merged, "a second pass over the same pull request counted it again").toBe(1);
    for (const column of ["commits", "files_changed", "tests_added", "ci_green", "duration_minutes", "blocked_count", "resumed_count"]) {
      expect(after?.[column], `${column} was touched`).toBe(before?.[column]);
    }
  });

  it("a pull request closed unmerged is stored as 0 and adds nothing to the count", async () => {
    await outcome("job_closed", { prs_merged: 0 });
    await prRow("job_closed", PR(2), null, null);
    await env.DB.batch(reverifyStatements(env.DB, "job_closed", PR(2), false, NOW));
    const pr = await env.DB.prepare("SELECT merged FROM job_outcome_prs WHERE job_id = 'job_closed'").first<{ merged: number }>();
    expect(pr?.merged).toBe(0);
    expect((await outcomeRow("job_closed"))?.prs_merged).toBe(0);
  });
});

describe("reverifyPr", () => {
  it("a pull request no row names does no work and writes nothing", async () => {
    expect(await reverifyPr(ENV, "capsid", PR(3), NOW)).toEqual([]);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM job_outcome_prs").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("a pull request GitHub cannot be asked about leaves every row exactly as it was", async () => {
    await outcome("job_unread");
    await prRow("job_unread", PR(4), null, null);
    const before = await outcomeRow("job_unread");
    expect(await reverifyPr(ENV, "capsid", PR(4), NOW)).toEqual([]);
    expect(await outcomeRow("job_unread")).toEqual(before);
    const pr = await env.DB.prepare("SELECT merged, merge_verified_at FROM job_outcome_prs WHERE job_id = 'job_unread'").first();
    expect(pr).toEqual({ merged: null, merge_verified_at: null });
  });
});

describe("dueForReverify", () => {
  it("takes never-checked rows first, then the oldest check, and skips what is known merged or out of the window", async () => {
    await outcome("job_a");
    await outcome("job_b");
    await outcome("job_c");
    await outcome("job_old", { recorded_at: "2026-07-01T00:00:00.000Z" });
    await prRow("job_a", PR(10), 0, "2026-09-09T00:00:00.000Z");
    await prRow("job_b", PR(11), null, null);
    await prRow("job_c", PR(12), 1, "2026-09-08T00:00:00.000Z");
    await prRow("job_a", PR(13), 0, "2026-09-01T00:00:00.000Z");
    await prRow("job_old", PR(14), null, null);
    const due = await dueForReverify(ENV, NOW);
    expect(due.map((d) => d.pr_url)).toEqual([PR(11), PR(13), PR(10)]);
  });

  it("binds its limit", async () => {
    await outcome("job_many");
    for (const n of [20, 21, 22]) await prRow("job_many", PR(n), null, null);
    expect(await dueForReverify(ENV, NOW, 2)).toHaveLength(2);
  });
});

describe("reverifySweep", () => {
  it("seeds join rows first, so a seeded URL is looked at in the same sweep, and writes no count itself", async () => {
    await env.DB.prepare(
      `INSERT INTO jobs (id, namespace, title, body, status, posted_by, result_ref, result_summary)
       VALUES ('job_seed', 'capsid', 'seeded', 'b', 'done', 'github:x', ?1, 'merged later')`
    )
      .bind(PR(30))
      .run();
    await outcome("job_seed", { prs_merged: 0 });
    const report = await reverifySweep(ENV, NOW);
    expect(report.seeded).toBe(1);
    expect(report.checked, "the seeded row was not looked at in the same sweep").toBe(1);
    const pr = await env.DB.prepare("SELECT merged FROM job_outcome_prs WHERE job_id = 'job_seed'").first<{ merged: number | null }>();
    expect(pr?.merged, "a scraped URL was counted before GitHub was asked").toBeNull();
    expect((await outcomeRow("job_seed"))?.prs_merged).toBe(0);
  });
});

describe("outcomePrStatements", () => {
  it("records the merge state of each pull request complete read, and leaves an unread one for the sweep", async () => {
    await outcome("job_partial");
    const read = { [PR(1)]: true, [PR(3)]: false };
    await env.DB.batch(outcomePrStatements(env.DB, "job_partial", [PR(1), PR(2), PR(3)], read, NOW));
    const { results } = await env.DB.prepare("SELECT pr_url, merged, merge_verified_at FROM job_outcome_prs WHERE job_id = 'job_partial' ORDER BY pr_url").all();
    expect(results).toEqual([
      { pr_url: PR(1), merged: 1, merge_verified_at: NOW.toISOString() },
      // Unread is NULL, never 0: nobody counted it.
      { pr_url: PR(2), merged: null, merge_verified_at: null },
      { pr_url: PR(3), merged: 0, merge_verified_at: NOW.toISOString() },
    ]);
    // The sweep still picks the unread one up, and the closed one, as before.
    const due = (await dueForReverify(ENV, NOW)).map((r) => r.pr_url).sort();
    expect(due).toEqual([PR(2), PR(3)]);
  });
});
