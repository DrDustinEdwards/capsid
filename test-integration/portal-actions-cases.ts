import { env } from "cloudflare:test";
import { expect } from "vitest";
import { OVERNIGHT_DECISION_KEY, OVERNIGHT_MODE_KEY } from "../src/overnight";
import { jobRow } from "./jobs-fixture";
import {
  ACTOR,
  githubCalls,
  postedJob,
  claimedJob,
  blockedJob,
  parkedJob,
  auditRows,
  Case,
  GITHUB_PR,
} from "./portal-actions-fixtures";
import { SITE_CASES } from "./portal-actions-site-cases";

export const JOB_CASES: Record<string, Case> = {
  overnight: {
    params: async () => ({ value: "subscription", reason: "first supervised night" }),
    after: async () => {
      expect(await env.APP_KV.get(OVERNIGHT_MODE_KEY)).toBe("subscription");
      const decision = JSON.parse((await env.APP_KV.get(OVERNIGHT_DECISION_KEY)) ?? "null");
      expect(decision.decided_by).toBe("Dustin Edwards");
      expect(decision.decided_on).toBe("2026-10-04");
      expect(decision.reason).toBe("first supervised night");
    },
  },
  resume_job: {
    params: async () => ({
      id: await blockedJob("a blocked job"),
      reason: "I ran the push myself",
      note: "Pushed at abc1234.\nConfirm the deploy, then complete.",
    }),
    after: async ({ id }) => {
      const stored = await jobRow(id);
      expect(stored?.status).toBe("claimed");
      expect(stored?.claimed_by, "the claim goes back to the driver that blocked it").toBe(
        "agent:capsid-driver",
      );
      const resumed = (await auditRows())
        .filter((r) => r.action === "job-resumed")
        .map((r) => JSON.parse(r.params));
      expect(
        resumed.some((p) => p.note === "Pushed at abc1234.\nConfirm the deploy, then complete."),
        "the note did not reach the resume",
      ).toBe(true);
    },
  },
  release_job: {
    params: async () => ({
      id: await claimedJob("a claim whose holder went away"),
      reason: "no session is running",
    }),
    after: async ({ id }) => {
      const stored = await jobRow(id);
      expect(stored?.status).toBe("queued");
      expect(stored?.claimed_by).toBeNull();
    },
  },
  close_shipped: {
    params: async () => ({
      id: await blockedJob("a job whose work shipped"),
      reason: "merged and live",
    }),
    after: async ({ id }) => {
      const stored = await jobRow(id);
      expect(stored?.status).toBe("done");
      expect(stored?.result_summary).toMatch(
        /^Closed as shipped by access:admin@example\.com: merged and live/,
      );
      const outcome = await env.DB.prepare("SELECT agent FROM job_outcomes WHERE job_id = ?1")
        .bind(id)
        .first<{ agent: string }>();
      expect(outcome?.agent, "the outcome credits the driver that did the work").toBe(
        "agent:capsid-driver",
      );
      const touch = await env.DB.prepare(
        "SELECT actor FROM job_touches WHERE job_id = ?1 AND kind = 'admin_complete'",
      )
        .bind(id)
        .first<{ actor: string }>();
      expect(touch?.actor).toBe(ACTOR);
    },
  },
  supersede_job: {
    params: async () => ({
      id: await postedJob("a duplicate job"),
      reason: "a duplicate of the other one",
    }),
    after: async ({ id }) => {
      const stored = await jobRow(id);
      expect(stored?.status).toBe("superseded");
      expect(stored?.result_summary).toBe("Superseded: a duplicate of the other one");
      const outcome = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM job_outcomes WHERE job_id = ?1",
      )
        .bind(id)
        .first<{ n: number }>();
      expect(outcome?.n).toBe(0);
    },
  },
  park_job: {
    params: async () => ({
      id: await postedJob("a job for later"),
      reason: "comes back when the design is ruled",
    }),
    after: async ({ id }) => {
      const stored = await jobRow(id);
      expect(stored?.status).toBe("parked");
      expect(stored?.result_summary).toBe("comes back when the design is ruled");
    },
  },
  unpark_job: {
    params: async () => ({ id: await parkedJob("a parked job") }),
    after: async ({ id }) => {
      const stored = await jobRow(id);
      expect(stored?.status).toBe("queued");
      expect(stored?.result_summary).toBeNull();
    },
  },
  pr_close: {
    params: async () => {
      githubCalls.length = 0;
      await env.APP_KV.put("gh:token:v3:example/capsid", "test-token");
      return { namespace: "capsid", number: "41", reason: "replaced by #42" };
    },
    after: async () => {
      expect(githubCalls).toContain(`PATCH ${GITHUB_PR}`);
      expect(githubCalls).toContain(
        "DELETE https://api.github.com/repos/example/capsid/git/refs/heads/feat/sample",
      );
      const row = await env.DB.prepare(
        "SELECT params FROM audit_log WHERE action = 'pr-closed' ORDER BY id DESC LIMIT 1",
      ).first<{ params: string }>();
      expect(JSON.parse(row?.params ?? "{}")).toMatchObject({
        repo: "example/capsid",
        number: 41,
        reason: "replaced by #42",
        head_branch: "feat/sample",
        head_branch_deleted: true,
      });
      await env.APP_KV.delete("gh:token:v3:example/capsid");
    },
  },
  fail_job: {
    params: async () => ({ id: await blockedJob("a job to fail"), reason: "superseded" }),
    after: async ({ id }) => expect((await jobRow(id))?.status).toBe("failed"),
  },
  revoke_agent: {
    params: async () => {
      await env.DB.prepare(
        `INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at)
         VALUES ('agent_sample00001', 'sample-driver', 'driver', ?1, ?2, 'github:sample', '2026-09-11 00:00:00')`,
      )
        .bind(
          "e".repeat(64),
          JSON.stringify({
            namespaces: ["capsid"],
            repos: "*",
            tools: "*",
            grants: ["read"],
            flags: {},
          }),
        )
        .run();
      return { name: "sample-driver" };
    },
    after: async () => {
      const row = await env.DB.prepare(
        "SELECT revoked_at FROM agents WHERE name = 'sample-driver'",
      ).first<{ revoked_at: string | null }>();
      expect(row?.revoked_at).not.toBeNull();
    },
  },
  activate_agent: {
    params: async () => {
      await env.DB.prepare(
        `INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at, pending)
         VALUES ('agent_minted00001', 'sample-new-driver', 'driver', ?1, '{}', 'access:admin@example.com', '2026-09-11 00:00:00', 1)`,
      )
        .bind("d".repeat(64))
        .run();
      return { name: "sample-new-driver" };
    },
    after: async () => {
      const row = await env.DB.prepare(
        "SELECT pending FROM agents WHERE name = 'sample-new-driver'",
      ).first<{ pending: number }>();
      expect(row?.pending).toBe(0);
    },
  },
};

export const CASES: Record<string, Case> = { ...JOB_CASES, ...SITE_CASES };
