import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { readUnitEvidence, SUSPENDED_KEY, unitsTick } from "../src/merge-units";

// The merge units' evidence against a real D1 with migrations/0043 applied: the unit of a
// rolled-back pull request found through the tick's auto-merged audit row (json_extract)
// or through its approval, and one rollback of an unattended merge suspending the unit.

const NOW = new Date("2026-10-11T12:00:00.000Z");
const A = "a".repeat(40);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM deploy_outcomes").run();
  await env.DB.prepare("DELETE FROM pr_approvals").run();
  await env.DB.prepare("DELETE FROM audit_log WHERE action = 'auto-merged'").run();
  await env.APP_KV.delete(SUSPENDED_KEY);
});

async function rolledBack(pr: number, run: number) {
  await env.DB.prepare(
    `INSERT INTO deploy_outcomes (repo, namespace, run_id, head_sha, pr, outcome, run_at) VALUES ('example/capsid', 'capsid', ?1, ?2, ?3, 'rolled_back', '2026-10-10T10:00:00Z')`
  )
    .bind(run, A, pr)
    .run();
}

describe("merge units against D1", () => {
  it("finds an unattended merge's unit through its audit row and suspends it", async () => {
    await env.DB.prepare(`INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('improve-loop', 'auto-merged', 'capsid', NULL, ?1)`)
      .bind(JSON.stringify({ policy_version: "6", path_class: "docs", repo: "example/capsid", pr: 41, head_sha: A }))
      .run();
    await rolledBack(41, 1);
    const evidence = await readUnitEvidence(env as unknown as Env, NOW);
    expect(evidence.rollbacks).toHaveLength(1);
    expect(evidence.rollbacks[0]).toMatchObject({ pr: 41, merged_by: "tick", path_class: "docs" });
    const report = await unitsTick(env as unknown as Env, NOW);
    expect(report.newly_suspended).toEqual(["capsid/docs"]);
    expect(JSON.parse((await env.APP_KV.get(SUSPENDED_KEY))!)[0].unit).toBe("capsid/docs");
    const audit = await env.DB.prepare("SELECT namespace FROM audit_log WHERE action = 'merge-unit-suspended'").all();
    expect(audit.results.length).toBeGreaterThan(0);
  });

  it("finds an approved merge's unit through pr_approvals, reads the new columns, and suspends nothing", async () => {
    await env.DB.prepare(
      `INSERT INTO pr_approvals (repo, pr, head_sha, class, status, approved_by, surface, approved_at, closed_at, namespace, path_class)
       VALUES ('example/capsid', 42, ?1, 'approve', 'merged', 'access:admin@example.com', 'portal', '2026-10-09T10:00:00Z', '2026-10-09T10:05:00Z', 'capsid', 'tests')`
    )
      .bind(A)
      .run();
    await rolledBack(42, 2);
    const evidence = await readUnitEvidence(env as unknown as Env, NOW);
    expect(evidence.approvals).toEqual([{ namespace: "capsid", path_class: "tests", status: "merged", close_reason: null, closed_at: "2026-10-09T10:05:00Z" }]);
    expect(evidence.rollbacks[0]).toMatchObject({ pr: 42, merged_by: "approval", path_class: "tests" });
    expect((await unitsTick(env as unknown as Env, NOW)).newly_suspended).toEqual([]);
  });
});
