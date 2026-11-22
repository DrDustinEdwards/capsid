import { env } from "cloudflare:test";
import { expect } from "vitest";
import type { Env } from "../src/env";
import { breakerResetKey } from "../src/job-breaker";
import { AUTO_MERGE_POLICY_PATH, loadMergePolicy } from "../src/auto-merge-policy";
import { splitSignedTask } from "../src/signed-docs";
import { policyDocument } from "../test/policy-doc";
import { LIFTED_KEY, SUSPENDED_KEY } from "../src/merge-units";
import { LIFTED_KEY as SAFETY_LIFTED_KEY, PAUSED_KEY } from "../src/merge-safety";
import {
  OPERATOR_TOKEN,
  operatorCalls,
  repo,
  secretPuts,
  auditRows,
  packageRow,
  siteRow,
  signedPolicy,
  Case,
} from "./portal-actions-fixtures";

/** The Worker's signed policy body, after checking its signature is there. */
async function signedPolicyBody(): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT body FROM documents WHERE namespace = 'capsid' AND path = ?1",
  )
    .bind(AUTO_MERGE_POLICY_PATH)
    .first<{ body: string }>();
  const { signature, body } = splitSignedTask(row!.body);
  expect(signature).toBeTruthy();
  return body;
}

/** The newest snapshot of the policy: the version a signing replaced. */
async function previousPolicyBody(): Promise<string | undefined> {
  const version = await env.DB.prepare(
    "SELECT body FROM document_versions WHERE namespace = 'capsid' AND path = ?1 ORDER BY id DESC LIMIT 1",
  )
    .bind(AUTO_MERGE_POLICY_PATH)
    .first<{ body: string }>();
  return version?.body;
}

/** The one call the Portal action made to dustinedwards.info's operator API, with the token. */
function expectOperatorCall(tool: string, args: Record<string, unknown>) {
  expect(operatorCalls.map((c) => [c.url, c.auth, JSON.parse(c.body)])).toEqual([
    ["https://dustinedwards.info/api/operator", `Bearer ${OPERATOR_TOKEN}`, { tool, args }],
  ]);
}

export const SITE_CASES: Record<string, Case> = {
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
      const body = await signedPolicyBody();
      expect(body).toMatch(/^- version: 8$/m);
      expect(body).toContain("- unit `capsid / tests`");
      const loaded = await loadMergePolicy(env as unknown as Env);
      expect("policy" in loaded && loaded.policy.units).toEqual(["capsid / tests"]);
      expect(await previousPolicyBody(), "version 7 was not snapshotted").toMatch(/- version: 7/);
    },
  },
  sign_policy_from_repo: {
    // The repo's file, version 8, written over version 7 and signed, snapshotting version 7,
    // and loading as the Worker's copy. The preview binds the file's hash.
    params: async () => {
      await signedPolicy();
      // The App's token for the repo, as pr_close seeds it, and the file the repo holds.
      await env.APP_KV.put("gh:token:v3:example/capsid", "test-token");
      repo.policy = policyDocument("8");
      return { confirm: "8" };
    },
    after: async () => {
      const body = await signedPolicyBody();
      expect(body).toBe(policyDocument("8"));
      const loaded = await loadMergePolicy(env as unknown as Env);
      expect("policy" in loaded && loaded.policy.version).toBe("8");
      expect(await previousPolicyBody(), "version 7 was not snapshotted").toMatch(/- version: 7/);
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
      expectOperatorCall("run_job", { backup: true });
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
      expectOperatorCall("sync_pages", {});
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
