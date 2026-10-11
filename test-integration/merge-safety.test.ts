import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { PAUSED_KEY, readSafetyReport, recordReverts, REPORT_KEY, safetyTick } from "../src/merge-safety";
import { readUnitEvidence, SUSPENDED_KEY, unitsTick } from "../src/merge-units";

// The safety meter against a real D1: revert tracking from the closed pull requests
// GitHub lists (answered here), recorded once per revert; the counts and the pause from
// planted audit_log and deploy_outcomes rows; and a revert suspending its merge unit.

const NOW = new Date("2026-10-11T12:00:00.000Z");
const A = "a".repeat(40);
const API = "https://api.github.com/repos/example/capsid";
const passThrough = globalThis.fetch;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

let closed: object[] = [];

beforeEach(async () => {
  closed = [];
  await env.DB.prepare("DELETE FROM deploy_outcomes").run();
  await env.DB.prepare("DELETE FROM audit_log WHERE action IN ('auto-merged', 'approved-merged', 'auto-merge-reverted', 'auto-merge-paused')").run();
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES ('capsid', ?1)").bind(JSON.stringify([{ repo: "example/capsid", label: "primary" }])).run();
  for (const key of [PAUSED_KEY, REPORT_KEY, SUSPENDED_KEY, "merge-safety:lifted"]) await env.APP_KV.delete(key);
  await env.APP_KV.put("gh:token:v3:example/capsid", "test-token");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(API)) return passThrough(input, init);
    const path = url.slice(API.length);
    if (path.startsWith("/pulls?state=closed&sort=updated&direction=desc&per_page=50")) return Response.json(closed);
    return new Response("not stubbed", { status: 404 });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = passThrough;
  await env.APP_KV.delete("gh:token:v3:example/capsid");
});

async function autoMerged(pr: number, ago: number, extra: object = {}) {
  await env.DB.prepare(`INSERT INTO audit_log (actor, action, namespace, path, params, at) VALUES ('improve-loop', 'auto-merged', 'capsid', NULL, ?1, ?2)`)
    .bind(JSON.stringify({ policy_version: "8", path_class: "docs", repo: "example/capsid", pr, head_sha: A, merge_sha: `${pr}`.padStart(40, "c"), ...extra }), daysAgo(ago))
    .run();
}
async function rolledBack(pr: number, run: number, ago: number) {
  await env.DB.prepare(`INSERT INTO deploy_outcomes (repo, namespace, run_id, head_sha, pr, outcome, run_at) VALUES ('example/capsid', 'capsid', ?1, ?2, ?3, 'rolled_back', ?4)`)
    .bind(run, A, pr, daysAgo(ago))
    .run();
}
const revertRows = () => env.DB.prepare("SELECT namespace, params FROM audit_log WHERE action = 'auto-merge-reverted' ORDER BY id").all<{ namespace: string; params: string }>();

describe("revert tracking", () => {
  it("records a merged revert of an auto-merged pull request once, from the button's body or git's commit line, and ignores the rest", async () => {
    await autoMerged(41, 3);
    await autoMerged(42, 3, { merge_sha: "d3adbeef" + "0".repeat(32) });
    closed = [
      { number: 50, title: 'Revert "Tidy the docs"', body: "Reverts example/capsid#41", merged_at: daysAgo(1) },
      { number: 51, title: 'Revert "Other"', body: "This reverts commit d3adbeef0000000000000000000000000000.", merged_at: daysAgo(1) },
      // Closed without merging, a revert of a pull request a person approved, and prose.
      { number: 52, title: "Revert #41", body: "", merged_at: null },
      { number: 53, title: 'Revert "x"', body: "Reverts example/capsid#99", merged_at: daysAgo(1) },
      { number: 54, title: "Fix", body: "Closes #41", merged_at: daysAgo(1) },
    ];
    const first = await recordReverts(env as unknown as Env, "capsid", NOW);
    expect(first).toEqual(["example/capsid#41 by #50", "example/capsid#42 by #51"]);
    const rows = (await revertRows()).results.map((r) => JSON.parse(r.params));
    expect(rows[0]).toMatchObject({ repo: "example/capsid", pr: 41, reverted_by: 50, path_class: "docs", merged_at: closed[0] && (closed[0] as { merged_at: string }).merged_at });
    // A second pass over the same list writes nothing.
    expect(await recordReverts(env as unknown as Env, "capsid", NOW)).toEqual([]);
    expect((await revertRows()).results).toHaveLength(2);
  });

  it("a revert suspends its merge unit through readUnitEvidence and unitsTick", async () => {
    await autoMerged(41, 3);
    closed = [{ number: 50, title: 'Revert "Tidy the docs"', body: "Reverts example/capsid#41", merged_at: daysAgo(1) }];
    await recordReverts(env as unknown as Env, "capsid", NOW);
    const evidence = await readUnitEvidence(env as unknown as Env, NOW);
    expect(evidence.rollbacks).toHaveLength(1);
    expect(evidence.rollbacks[0]).toMatchObject({ kind: "revert", pr: 41, reverted_by: 50, merged_by: "tick", path_class: "docs", head_sha: A });
    expect((await unitsTick(env as unknown as Env, NOW)).newly_suspended).toEqual(["capsid/docs"]);
  });
});

describe("the shutoff against D1", () => {
  it("PLANT: two rollbacks of auto-merged pull requests in a week pause the namespace, audit it once, and write the report", async () => {
    await autoMerged(41, 4);
    await autoMerged(42, 4);
    await autoMerged(43, 2);
    await rolledBack(41, 1, 3);
    await rolledBack(42, 2, 1);
    await env.DB.prepare(`INSERT INTO deploy_outcomes (repo, namespace, run_id, head_sha, pr, outcome, run_at) VALUES ('example/capsid', 'capsid', 3, ?1, 43, 'verified', ?2)`).bind(A, daysAgo(1)).run();
    const first = await safetyTick(env as unknown as Env, NOW, ["capsid"]);
    expect(first.newly_paused).toEqual(["capsid"]);
    expect(Object.keys(JSON.parse((await env.APP_KV.get(PAUSED_KEY))!))).toEqual(["capsid"]);
    const audit = await env.DB.prepare("SELECT actor, namespace FROM audit_log WHERE action = 'auto-merge-paused'").all<{ actor: string; namespace: string }>();
    expect(audit.results).toEqual([{ actor: "capsid:merge-safety", namespace: "capsid" }]);
    const report = await readSafetyReport(env.APP_KV);
    expect(report?.namespaces).toEqual([
      expect.objectContaining({ namespace: "capsid", auto_merged: 3, approved: 0, deploys_verified: 1, rolled_back: 2, rollback_failed: 0, reverts: 0, bad_auto_7d: 2, paused: expect.objectContaining({ since: NOW.toISOString() }) }),
    ]);
    // The next pass changes nothing and audits nothing more.
    expect((await safetyTick(env as unknown as Env, new Date(NOW.getTime() + 300_000), ["capsid"])).ran).toBe(false);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auto-merge-paused'").first<{ n: number }>())?.n).toBe(1);
  });

  it("one rollback with a clean baseline pauses nothing", async () => {
    await autoMerged(41, 4);
    await rolledBack(41, 1, 3);
    expect((await safetyTick(env as unknown as Env, NOW, ["capsid"])).newly_paused).toEqual([]);
    expect(await env.APP_KV.get(PAUSED_KEY)).toBeNull();
  });
});
