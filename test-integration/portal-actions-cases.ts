import { env } from "cloudflare:test";
import { expect } from "vitest";
import { githubCalls, Case, GITHUB_PR } from "./portal-actions-fixtures";
import { SITE_CASES } from "./portal-actions-site-cases";

export const AGENT_CASES: Record<string, Case> = {
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

export const CASES: Record<string, Case> = { ...AGENT_CASES, ...SITE_CASES };
