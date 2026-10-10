import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { executeApproval, expireStaleApprovals, readOpenApprovals } from "../src/approval-executor";
import type { PrFacts } from "../src/auto-merge-policy";

// The executor's SQL against a real D1 with migrations/0037 applied: the read of the open
// approvals, a state move with its audit row, and the 7-day sweep. The decisions are tested
// through the tick in test/auto-merge.test.ts.

const NOW = new Date("2026-10-10T12:00:00.000Z");
const A = "a".repeat(40);
const B = "b".repeat(40);

async function approve(pr: number, approvedAt: string, head = A) {
  await env.DB.prepare(
    `INSERT INTO pr_approvals (repo, pr, head_sha, class, status, approved_by, surface, approved_at) VALUES ('example/capsid', ?1, ?2, 'approve', 'approved', 'access:admin@example.com', 'portal', ?3)`
  )
    .bind(pr, head, approvedAt)
    .run();
}

const facts = (number: number, headSha: string) => ({ number, repo: "example/capsid", headSha }) as unknown as PrFacts;

describe("the executor against real D1", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM pr_approvals").run();
    await env.DB.prepare("DELETE FROM audit_log").run();
  });

  it("reads the open approvals by repo, voids one on a new push with its audit row, and a second move finds nothing", async () => {
    await approve(41, NOW.toISOString());
    const open = await readOpenApprovals(env.DB, "example/capsid");
    expect([...open.keys()]).toEqual([41]);
    const result = await executeApproval(env as unknown as Env, "capsid", facts(41, B), null, open.get(41)!, NOW);
    expect(result).toMatchObject({ done: "voided" });
    const row = await env.DB.prepare("SELECT status, close_reason, closed_at FROM pr_approvals WHERE pr = 41").first<Record<string, string>>();
    expect(row?.status).toBe("voided");
    expect(row?.close_reason).toMatch(/^new push: approved at aaaaaaa, the head is bbbbbbb now/);
    const audit = await env.DB.prepare("SELECT actor, action, params FROM audit_log").all<{ actor: string; action: string; params: string }>();
    expect(audit.results.map((r) => r.action)).toEqual(["pr-approval-voided"]);
    expect(JSON.parse(audit.results[0]!.params)).toMatchObject({ repo: "example/capsid", pr: 41, approved_sha: A, head_sha: B });
    expect((await readOpenApprovals(env.DB, "example/capsid")).size).toBe(0);
  });

  it("the sweep expires approvals 7 days old, on any pull request, and leaves younger ones open", async () => {
    await approve(41, "2026-10-02T11:00:00.000Z");
    await approve(42, "2026-10-09T12:00:00.000Z");
    expect(await expireStaleApprovals(env as unknown as Env, NOW)).toBe(1);
    const rows = await env.DB.prepare("SELECT pr, status FROM pr_approvals ORDER BY pr").all<{ pr: number; status: string }>();
    expect(rows.results).toEqual([
      { pr: 41, status: "expired" },
      { pr: 42, status: "approved" },
    ]);
    const audit = await env.DB.prepare("SELECT action FROM audit_log").all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toEqual(["pr-approval-expired"]);
  });

  it("the partial unique index holds one open approval per pull request", async () => {
    await approve(41, NOW.toISOString());
    await expect(approve(41, NOW.toISOString(), B)).rejects.toThrow(/UNIQUE/);
  });
});
