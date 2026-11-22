import { env } from "cloudflare:test";
import { expect } from "vitest";
import type { Env } from "../src/env";
import { OVERNIGHT_DECISION_KEY, OVERNIGHT_MODE_KEY } from "../src/overnight";
import { breakerResetKey } from "../src/job-breaker";
import { AWAITING_SEAT_KEY } from "../src/auto-merge-tick";
import { AUTO_MERGE_POLICY_PATH, loadMergePolicy } from "../src/auto-merge-policy";
import { splitSignedTask } from "../src/signed-docs";
import { LIFTED_KEY, SUSPENDED_KEY } from "../src/merge-units";
import { LIFTED_KEY as SAFETY_LIFTED_KEY, PAUSED_KEY } from "../src/merge-safety";
import { jobRow } from "./jobs-fixture";
import {
  NOW,
  ACTOR,
  OPERATOR_TOKEN,
  operatorCalls,
  githubCalls,
  repo,
  secretPuts,
  postedJob,
  claimedJob,
  blockedJob,
  parkedJob,
  auditRows,
  packageRow,
  siteRow,
  policyText,
  signedPolicy,
  Case,
  GITHUB_PR,
} from "./portal-actions-fixtures";

export const CASES: Record<string, Case> = {
  overnight: {
    // The subscription, so the real KV shows the decision record written with the mode.
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
    // With a note (stale jobs D6): the control hands it to the resume, which records it.
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
    // The seat's admin complete (stale jobs D4, ruled 2026-10-09): done, credited to the
    // driver that blocked it, with an admin_complete touch naming the seat.
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
    // A queued job nobody worked: superseded, with no outcome row against anybody.
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
  approve_pr: {
    // A pull request the tick classed approve: an approval row at the head reviewed, and
    // nothing merged (no PUT to GitHub's merge).
    params: async () => {
      githubCalls.length = 0;
      await env.DB.prepare("DELETE FROM pr_approvals").run();
      await env.APP_KV.put("gh:token:v3:example/capsid", "test-token");
      await env.APP_KV.put(
        AWAITING_SEAT_KEY,
        JSON.stringify([
          {
            namespace: "capsid",
            repo: "example/capsid",
            number: 41,
            failed: "path_class",
            why: "a src change",
            at: NOW.toISOString(),
            class: "approve",
            path_class: "src-routine",
            class_reasons: [],
          },
        ]),
      );
      return { namespace: "capsid", prs: "41", shas: "c".repeat(7), reason: "read the diff" };
    },
    after: async () => {
      const row = await env.DB.prepare(
        "SELECT repo, pr, head_sha, class, status, approved_by, surface, reason FROM pr_approvals",
      ).first<Record<string, unknown>>();
      expect(row).toEqual({
        repo: "example/capsid",
        pr: 41,
        head_sha: "c".repeat(40),
        class: "approve",
        status: "approved",
        approved_by: ACTOR,
        surface: "portal",
        reason: "read the diff",
      });
      expect(
        githubCalls.filter((c) => c.includes("/merge")),
        "approve_pr merged",
      ).toEqual([]);
      await env.APP_KV.delete("gh:token:v3:example/capsid");
      await env.APP_KV.delete(AWAITING_SEAT_KEY);
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
  site_add: {
    params: async () => ({
      namespace: "sample",
      name: "Sample",
      origin: "https://sample.example.com",
      health_path: "/health",
      platform: "cloudflare",
    }),
    after: async () =>
      expect(await siteRow("sample")).toMatchObject({
        origin: "https://sample.example.com",
        health_path: "/health",
        platform: "cloudflare",
        revision: 1,
      }),
  },
  site_edit: {
    params: async () => {
      const row = await siteRow("germomics");
      return {
        namespace: "germomics",
        revision: String(row?.revision),
        name: "Germomics",
        origin: "https://germomics.com",
        health_path: "/api/health",
        platform: "cloudflare",
      };
    },
    after: async ({ revision }) =>
      expect(await siteRow("germomics")).toMatchObject({
        health_path: "/api/health",
        revision: Number(revision) + 1,
      }),
  },
  site_remove: {
    params: async () => {
      const row = await siteRow("txasm");
      return { namespace: "txasm", revision: String(row?.revision) };
    },
    after: async () => expect(await siteRow("txasm")).toBeNull(),
  },
  reset_breaker: {
    params: async () => ({ namespace: "capsid" }),
    after: async () => expect(await env.APP_KV.get(breakerResetKey("capsid"))).not.toBeNull(),
  },
  package_add: {
    params: async () => ({
      name: "sample-pkg",
      repo: "example-org/sample-pkg",
      formerly: "sample-old",
    }),
    after: async () =>
      expect(await packageRow("sample-pkg")).toMatchObject({
        repo: "example-org/sample-pkg",
        formerly: "sample-old",
        revision: 1,
      }),
  },
  package_edit: {
    params: async () => {
      await env.DB.prepare(
        "INSERT INTO ops_packages (name, repo) VALUES ('sample-pkg', 'example-org/sample-pkg')",
      ).run();
      return {
        name: "sample-pkg",
        revision: "1",
        repo: "example-org/sample-pkg",
        formerly: "sample-old",
      };
    },
    after: async () =>
      expect(await packageRow("sample-pkg")).toMatchObject({ formerly: "sample-old", revision: 2 }),
  },
  package_remove: {
    params: async () => {
      await env.DB.prepare("INSERT INTO ops_packages (name) VALUES ('sample-pkg')").run();
      return { name: "sample-pkg", revision: "1" };
    },
    after: async () => expect(await packageRow("sample-pkg")).toBeNull(),
  },
  sign_policy_change: {
    // Version 8, signed, with the unit, snapshotting version 7, and loading as the Worker's
    // copy: the typed version is what lets it through.
    params: async () => {
      await signedPolicy();
      return { change: "promote", unit: "capsid/tests", confirm: "8" };
    },
    after: async () => {
      const row = await env.DB.prepare(
        "SELECT body FROM documents WHERE namespace = 'capsid' AND path = ?1",
      )
        .bind(AUTO_MERGE_POLICY_PATH)
        .first<{ body: string }>();
      const { signature, body } = splitSignedTask(row!.body);
      expect(signature).toBeTruthy();
      expect(body).toMatch(/^- version: 8$/m);
      expect(body).toContain("- unit `capsid / tests`");
      const loaded = await loadMergePolicy(env as unknown as Env);
      expect("policy" in loaded && loaded.policy.units).toEqual(["capsid / tests"]);
      const version = await env.DB.prepare(
        "SELECT body FROM document_versions WHERE namespace = 'capsid' AND path = ?1 ORDER BY id DESC LIMIT 1",
      )
        .bind(AUTO_MERGE_POLICY_PATH)
        .first<{ body: string }>();
      expect(version?.body, "version 7 was not snapshotted").toMatch(/- version: 7/);
    },
  },
  sign_policy_from_repo: {
    // The repo's file, version 8, written over version 7 and signed, snapshotting version 7,
    // and loading as the Worker's copy. The preview binds the file's hash.
    params: async () => {
      await signedPolicy();
      // The App's token for the repo, as pr_close seeds it, and the file the repo holds.
      await env.APP_KV.put("gh:token:v3:example/capsid", "test-token");
      repo.policy = policyText("8");
      return { confirm: "8" };
    },
    after: async () => {
      const row = await env.DB.prepare(
        "SELECT body FROM documents WHERE namespace = 'capsid' AND path = ?1",
      )
        .bind(AUTO_MERGE_POLICY_PATH)
        .first<{ body: string }>();
      const { signature, body } = splitSignedTask(row!.body);
      expect(signature).toBeTruthy();
      expect(body).toBe(policyText("8"));
      const loaded = await loadMergePolicy(env as unknown as Env);
      expect("policy" in loaded && loaded.policy.version).toBe("8");
      const version = await env.DB.prepare(
        "SELECT body FROM document_versions WHERE namespace = 'capsid' AND path = ?1 ORDER BY id DESC LIMIT 1",
      )
        .bind(AUTO_MERGE_POLICY_PATH)
        .first<{ body: string }>();
      expect(version?.body, "version 7 was not snapshotted").toMatch(/- version: 7/);
      const audit = await env.DB.prepare(
        "SELECT params FROM audit_log WHERE action = 'policy-loaded-from-repo' ORDER BY id DESC LIMIT 1",
      ).first<{ params: string }>();
      expect(JSON.parse(audit?.params ?? "{}")).toMatchObject({
        from: "7",
        to: "8",
        source: "docs/policy/auto-merge.md",
      });
    },
  },
  unit_resume: {
    params: async () => {
      await env.APP_KV.put(
        SUSPENDED_KEY,
        JSON.stringify([
          { unit: "capsid/docs", since: "2026-09-27T00:00:00.000Z", reason: "rolled back" },
        ]),
      );
      await env.APP_KV.delete(LIFTED_KEY);
      return { unit: "capsid/docs", reason: "the cause is fixed" };
    },
    after: async () => {
      expect(JSON.parse((await env.APP_KV.get(SUSPENDED_KEY))!)).toEqual([]);
      expect(Object.keys(JSON.parse((await env.APP_KV.get(LIFTED_KEY))!))).toEqual(["capsid/docs"]);
    },
  },
  automerge_resume: {
    params: async () => {
      await env.APP_KV.put(
        PAUSED_KEY,
        JSON.stringify({ capsid: { since: "2026-09-27T00:00:00.000Z", reason: "2 rolled back" } }),
      );
      await env.APP_KV.delete(SAFETY_LIFTED_KEY);
      return { namespace: "capsid", reason: "both are answered" };
    },
    after: async () => {
      expect(JSON.parse((await env.APP_KV.get(PAUSED_KEY))!)).toEqual({});
      expect(Object.keys(JSON.parse((await env.APP_KV.get(SAFETY_LIFTED_KEY))!))).toEqual([
        "capsid",
      ]);
    },
  },
  namespace_add: {
    params: async () => ({ namespace: "sample-added", repo: "example/sample-added" }),
    after: async () => {
      const row = await env.DB.prepare(
        "SELECT repos FROM namespaces WHERE namespace = 'sample-added'",
      ).first<{ repos: string }>();
      expect(JSON.parse(row?.repos ?? "null")).toEqual([
        { repo: "example/sample-added", label: "primary" },
      ]);
    },
  },
  namespace_edit: {
    params: async () => ({
      namespace: "sample",
      repos: JSON.stringify([{ repo: "example/sample-two", label: "primary" }]),
    }),
    after: async () => {
      const row = await env.DB.prepare(
        "SELECT repos FROM namespaces WHERE namespace = 'sample'",
      ).first<{ repos: string }>();
      expect(JSON.parse(row?.repos ?? "null")).toEqual([
        { repo: "example/sample-two", label: "primary" },
      ]);
      const audit = await env.DB.prepare(
        "SELECT params FROM audit_log WHERE action = 'update_namespace' ORDER BY id DESC LIMIT 1",
      ).first<{ params: string }>();
      expect(JSON.parse(JSON.parse(audit?.params ?? "{}").old)).toEqual([
        { repo: "example/sample", label: "primary" },
      ]);
    },
  },
  namespace_remove: {
    // A registered project with a live document: cascade deletes it, snapshotted first.
    params: async () => {
      await env.DB.prepare("INSERT INTO namespaces (namespace, repos) VALUES ('sample-gone', ?1)")
        .bind(JSON.stringify([{ repo: "example/sample-gone", label: "primary" }]))
        .run();
      await env.DB.prepare(
        "INSERT INTO documents (namespace, path, title, body) VALUES ('sample-gone', 'notes.md', 'Notes', 'lorem')",
      ).run();
      return { namespace: "sample-gone", cascade: "true" };
    },
    after: async () => {
      expect(
        await env.DB.prepare(
          "SELECT namespace FROM namespaces WHERE namespace = 'sample-gone'",
        ).first(),
      ).toBeNull();
      expect(
        await env.DB.prepare("SELECT path FROM documents WHERE namespace = 'sample-gone'").first(),
      ).toBeNull();
      const kept = await env.DB.prepare(
        "SELECT body FROM document_versions WHERE namespace = 'sample-gone' AND path = 'notes.md'",
      ).first<{ body: string }>();
      expect(kept?.body, "the document was not snapshotted before it went").toBe("lorem");
    },
  },
  site_key_rotate: {
    params: async () => {
      secretPuts.length = 0;
      await env.DB.prepare(
        "INSERT INTO ops_sites (namespace, name, origin, health_path, platform, script, self_probe) VALUES ('sample', 'Sample', 'https://sample.example.com', '/health', 'cloudflare', 'sample-site', 0)",
      ).run();
      return { namespace: "sample" };
    },
    after: async () => {
      // The site's Worker first, then Carrel, with one value.
      expect(secretPuts.map((p) => [p.script, p.name])).toEqual([
        ["sample-site", "CARREL_SITE_KEY"],
        ["carrel-desk", "SITE_SAMPLE_KEY"],
      ]);
      expect(secretPuts[0].text).toHaveLength(43);
      expect(secretPuts[1].text).toBe(secretPuts[0].text);
      // The value is in no audit row, the mutator's or the click's.
      for (const row of await auditRows())
        expect(row.params, `${row.action} recorded the key`).not.toContain(secretPuts[0].text);
    },
  },
  site_backup: {
    params: async () => {
      operatorCalls.length = 0;
      await env.DB.prepare(
        "UPDATE ops_sites SET operator = json_set(operator, '$.backup', json('true')) WHERE namespace = 'dustinedwards'",
      ).run();
      return { namespace: "dustinedwards" };
    },
    after: async () => {
      expect(operatorCalls.map((c) => [c.url, c.auth, JSON.parse(c.body)])).toEqual([
        [
          "https://dustinedwards.info/api/operator",
          `Bearer ${OPERATOR_TOKEN}`,
          { tool: "run_job", args: { backup: true } },
        ],
      ]);
      const row = await env.DB.prepare(
        "SELECT params FROM audit_log WHERE action = 'site-backup' ORDER BY id DESC LIMIT 1",
      ).first<{ params: string }>();
      expect(JSON.parse(row?.params ?? "{}")).toMatchObject({
        tool: "run_job",
        via: "portal",
        ok: true,
      });
      expect(row?.params, "the token reached the audit row").not.toContain(OPERATOR_TOKEN);
      const run = await env.DB.prepare(
        "SELECT outcome, reason FROM task_runs WHERE task = 'site-backup' ORDER BY id DESC LIMIT 1",
      ).first<{ outcome: string; reason: string }>();
      expect(run).toEqual({
        outcome: "ok",
        reason: "dustinedwards: run_job { backup: true } ran: media-backup ok in 20 ms (portal)",
      });
    },
  },
  run_job: {
    params: async () => {
      operatorCalls.length = 0;
      return { namespace: "dustinedwards", name: "media-backup" };
    },
    after: async () => {
      expect(operatorCalls.map((c) => [c.url, JSON.parse(c.body)])).toEqual([
        [
          "https://dustinedwards.info/api/operator",
          { tool: "run_job", args: { job: "media-backup" } },
        ],
      ]);
      const run = await env.DB.prepare(
        "SELECT outcome, reason FROM task_runs WHERE task = 'site-job' ORDER BY id DESC LIMIT 1",
      ).first<{ outcome: string; reason: string }>();
      expect(run).toEqual({
        outcome: "ok",
        reason: "dustinedwards: run_job ran: media-backup ok in 20 ms (portal)",
      });
    },
  },
  site_repair: {
    params: async () => {
      operatorCalls.length = 0;
      return { namespace: "dustinedwards", tool: "sync_pages" };
    },
    after: async () => {
      expect(operatorCalls.map((c) => [c.url, c.auth, JSON.parse(c.body)])).toEqual([
        [
          "https://dustinedwards.info/api/operator",
          `Bearer ${OPERATOR_TOKEN}`,
          { tool: "sync_pages", args: {} },
        ],
      ]);
      const row = await env.DB.prepare(
        "SELECT params FROM audit_log WHERE action = 'site-repair' ORDER BY id DESC LIMIT 1",
      ).first<{ params: string }>();
      expect(JSON.parse(row?.params ?? "{}")).toMatchObject({
        tool: "sync_pages",
        via: "portal",
        converged: true,
        present: 14,
        expected: 14,
      });
      expect(row?.params, "the token reached the audit row").not.toContain(OPERATOR_TOKEN);
      const run = await env.DB.prepare(
        "SELECT outcome, reason FROM task_runs WHERE task = 'site-repair' ORDER BY id DESC LIMIT 1",
      ).first<{ outcome: string; reason: string }>();
      expect(run).toEqual({
        outcome: "ok",
        reason: "dustinedwards: sync_pages converged (14 of 14 present) (portal)",
      });
    },
  },
};
