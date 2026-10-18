import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { postJob } from "../src/jobs";
import { gatherMaintenance, maintenanceTick, readMaintenance, MAINTENANCE_LAST_KEY } from "../src/maintenance";
import { legacyAgent } from "../src/agents";
import type { PrReaders } from "../src/maintenance-prs";
import { PRUNE_AUDIT_ACTION, PRUNE_SWITCH_KEY, type BranchReaders } from "../src/maintenance-branches";
import type { DeployReaders } from "../src/maintenance-deploys";
import type { ReleaseReaders } from "../src/maintenance-releases";
import worker from "../src/index";
import type { Env } from "../src/env";
import type { PortalMaintenance } from "../src/ops-types";
import { portalSessionCookie } from "../src/portal-auth";
import { PORTAL_MAINTENANCE_PATH } from "../src/portal-maintenance";
import { gatherModelDriftItems, UNLISTED_DOC } from "../src/model-drift";
import type { SystemModel } from "../src/system-model";
import { gatherRuleDocItems, RULE_DOC_CAP_BYTES } from "../src/rule-docs";

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
// The branch rules read GitHub too; here every repo has only its default branch. They are
// tested in test/maintenance.test.ts.
const NO_BRANCHES: BranchReaders = {
  plan: async () => ({ owner: "example-org", name: "sample", repo: "example-org/sample", defaultBranch: "main", branchesRead: 1, listsComplete: true, openComplete: true, prune: [], kept: [] }),
  committedAt: async () => NOW.toISOString(),
  prune: async () => ({ deleted: [], skipped: [], remaining: 0 }),
};

// The undeployed-merge rule reads the watcher snapshot; here there are no sites, so the
// rule is quiet with nothing to compare. It is tested in test/maintenance.test.ts.
const NO_DEPLOYS: DeployReaders = {
  snapshot: async () => ({ sites: [] }) as never,
  defaultHead: async () => {
    throw new Error("not called");
  },
};
// The model drift check has its own tests (test/model-drift.test.ts); here it reads nothing.
const NO_DRIFT = async () => ({ items: [], read: 0 });
// The release-tag rule reads each shared package's repo; here there is none to read. It
// is tested in test/maintenance-releases.test.ts.
const notCalled = async (): Promise<never> => {
  throw new Error("not called");
};
const NO_RELEASES: ReleaseReaders = {
  packages: async () => [],
  head: notCalled,
  tags: notCalled,
  manifestCommits: notCalled,
  versionAt: notCalled,
  changelog: notCalled,
  tag: notCalled,
  release: notCalled,
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
    const list = await gatherMaintenance(env as never, NOW, NO_PRS, NO_BRANCHES, NO_DEPLOYS, NO_DRIFT, NO_RELEASES);
    expect(list.items.filter((i) => i.rule === "later-passed").map((i) => i.job)).toEqual([past]);
  });

  it("lists a queued job whose pull request merged under another job, and not a prefix match", async () => {
    const shipped = await post("Add the health route", `Open ${PR} when done.`);
    const other = await post("Unrelated work", "See https://github.com/example-org/sample/pull/70 for context.");
    const done = await post("The job that shipped it");
    await env.DB.prepare("INSERT INTO job_outcome_prs (job_id, pr_url, merged) VALUES (?1, ?2, 1)").bind(done, PR).run();
    const list = await gatherMaintenance(env as never, NOW, NO_PRS, NO_BRANCHES, NO_DEPLOYS, NO_DRIFT, NO_RELEASES);
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
    let list = await gatherMaintenance(env as never, NOW, NO_PRS, NO_BRANCHES, NO_DEPLOYS, NO_DRIFT, NO_RELEASES);
    expect(list.items.filter((i) => i.rule === "followups-missing").map((i) => i.job)).toEqual([promised]);

    // A job posted after it moved is the follow-up. (postJob stamps created_at from `now`.)
    const later = await postJob(jobsEnv(), ADMIN, new Date("2026-10-07T06:00:00.000Z"), { namespace: "sample", title: "Build the thing", body: "go" });
    expect(later.ok, later.refusal).toBe(true);
    list = await gatherMaintenance(env as never, NOW, NO_PRS, NO_BRANCHES, NO_DEPLOYS, NO_DRIFT, NO_RELEASES);
    expect(list.items.filter((i) => i.rule === "followups-missing")).toEqual([]);
  });

  it("reports a job the merge-resume step resumed in the last day, and not an older one", async () => {
    const recent = await post("Resumed today");
    const old = await post("Resumed last week");
    const touch = (id: string, at: string) =>
      env.DB.prepare("INSERT INTO job_touches (job_id, namespace, kind, actor, actor_kind, at) VALUES (?1, 'sample', 'resume', 'system:merge-resume', 'system', ?2)").bind(id, at).run();
    await touch(recent, "2026-10-08T06:00:00.000Z");
    await touch(old, "2026-10-01T06:00:00.000Z");
    const list = await gatherMaintenance(env as never, NOW, NO_PRS, NO_BRANCHES, NO_DEPLOYS, NO_DRIFT, NO_RELEASES);
    expect(list.items.filter((i) => i.rule === "auto-resumed").map((i) => i.job)).toEqual([recent]);
  });

  it("stays quiet on a clean queue", async () => {
    await post("An ordinary queued job");
    expect((await gatherMaintenance(env as never, NOW, NO_PRS, NO_BRANCHES, NO_DEPLOYS, NO_DRIFT, NO_RELEASES)).items).toEqual([]);
  });
});

describe("gatherModelDriftItems", () => {
  // The reads against the real tables: the namespace mapping, ops_sites and the unlisted
  // document. The comparison itself is tested in test/model-drift.test.ts.
  const MODEL: SystemModel = {
    version: 1,
    systems: [{ id: "sample-site", name: "Sample", short: "Sample", family: "site", ring: "used", public: true, domain: "example.com", repos: ["example-org/sample-site"] }],
    containers: [],
    relationships: [],
  };

  it("names a mapped repo the model does not, skips one the unlisted document lists, and reports an unread App list", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
      .bind("drift-sample", JSON.stringify([{ repo: "example-org/sample-site", label: "primary" }, { repo: "example-org/sample-docs", label: "docs" }, { repo: "example-org/sample-notes", label: "notes" }]))
      .run();
    await env.DB.prepare("INSERT INTO documents (namespace, path, title, body, type, status) VALUES (?1, ?2, 'Unlisted', ?3, 'note', 'published')")
      .bind(UNLISTED_DOC.namespace, UNLISTED_DOC.path, "- example-org/sample-notes\n")
      .run();
    const out = await gatherModelDriftItems(env as never, MODEL, async () => {
      throw new Error("no App key in tests");
    });
    const mine = out.items.filter((i) => i.namespace === "drift-sample" || i.rule === "model-not-checked");
    expect(mine.map((i) => [i.rule, i.namespace])).toEqual([
      ["model-drift", "drift-sample"],
      ["model-not-checked", "capsid"],
    ]);
    expect(mine[0].line).toContain("example-org/sample-docs is mapped to drift-sample");
    expect(out.read).toBeGreaterThanOrEqual(3);
  });
});

describe("rule documents", () => {
  it("PLANT: lists an over-cap rule document and one naming a stale tool, and leaves records and clean ones alone", async () => {
    const planted: Array<[string, string, string]> = [
      ["sample", "decisions.md", "x".repeat(RULE_DOC_CAP_BYTES + 1)],
      ["capsid", "schema.md", "Use the `register_namespace` tool."],
      ["sample", "core.md", "Ask `capsid_find_docs` action `namespaces`."],
      ["capsid", "research/old-design.md", "manage_pr ".repeat(3000)],
      ["sample", "archive/decisions-vol-1.md", "x".repeat(RULE_DOC_CAP_BYTES + 1)],
    ];
    for (const [ns, path, body] of planted) {
      await env.DB.prepare("INSERT OR REPLACE INTO documents (namespace, path, title, body, type, status) VALUES (?1, ?2, 't', ?3, 'note', 'published')").bind(ns, path, body).run();
    }
    try {
      const out = await gatherRuleDocItems(env.DB);
      const mine = out.items.filter((i) => i.namespace === "sample" || i.namespace === "capsid");
      expect(mine.map((i) => [i.rule, i.namespace, i.line.split(":")[0]])).toEqual([
        ["rule-doc", "capsid", "capsid/schema.md"],
        ["rule-doc", "sample", "sample/decisions.md"],
      ]);
      expect(mine[0].line).toContain("register_namespace");
      expect(mine[1].line).toContain("over its 20480-byte cap");
      // Three rule documents were read; the research note and the archived volume are records.
      expect(out.read).toBeGreaterThanOrEqual(3);
    } finally {
      for (const [ns, path] of planted) await env.DB.prepare("DELETE FROM documents WHERE namespace = ?1 AND path = ?2").bind(ns, path).run();
    }
  });
});

describe("maintenanceTick", () => {
  it("does not run before 11:00 UTC, runs once a day after, and stores the list", async () => {
    await post("LATER 2026-10-01: stale");
    const early = await maintenanceTick(env as never, new Date("2026-10-08T09:00:00.000Z"), NO_PRS, NO_BRANCHES, NO_DEPLOYS, NO_DRIFT, NO_RELEASES);
    expect(early.ran).toBe(false);
    expect(await readMaintenance(env as never)).toBeNull();

    const first = await maintenanceTick(env as never, NOW, NO_PRS, NO_BRANCHES, NO_DEPLOYS, NO_DRIFT, NO_RELEASES);
    expect(first.ran).toBe(true);
    expect((await readMaintenance(env as never))?.items.map((i) => i.rule)).toEqual(["later-passed"]);
    // Every roster repo was read, and the count says so: zero open pull requests, not none read.
    expect(Object.values((await readMaintenance(env as never))?.prs_read ?? {})).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(Object.values((await readMaintenance(env as never))?.branches_read ?? {})).toEqual([1, 1, 1, 1, 1, 1, 1]);

    const second = await maintenanceTick(env as never, new Date("2026-10-08T15:00:00.000Z"), NO_PRS, NO_BRANCHES, NO_DEPLOYS, NO_DRIFT, NO_RELEASES);
    expect(second.ran).toBe(false);
    const nextDay = await maintenanceTick(env as never, new Date("2026-10-09T12:00:00.000Z"), NO_PRS, NO_BRANCHES, NO_DEPLOYS, NO_DRIFT, NO_RELEASES);
    expect(nextDay.ran).toBe(true);
  });

  it("writes one audit_log row per branch the switched-on prune deleted, with the sha to put it back", async () => {
    await env.APP_KV.put(PRUNE_SWITCH_KEY, "on");
    const ONE_MERGED: BranchReaders = {
      ...NO_BRANCHES,
      plan: async (namespace) => ({
        ...(await NO_BRANCHES.plan(namespace, [])),
        prune: namespace === "capsid" ? [{ branch: "feat/done", sha: "a1", pr: 3 }] : [],
      }),
      prune: async (plan, cap, onDeleted) => {
        for (const c of plan.prune.slice(0, cap)) await onDeleted(c);
        return { deleted: plan.prune.slice(0, cap), skipped: [], remaining: 0 };
      },
    };
    try {
      const ran = await maintenanceTick(env as never, NOW, NO_PRS, ONE_MERGED, NO_DEPLOYS, NO_DRIFT, NO_RELEASES);
      expect(ran.ran && ran.note).toContain("1 pruned");
      const rows = await env.DB.prepare("SELECT actor, namespace, params FROM audit_log WHERE action = ?1").bind(PRUNE_AUDIT_ACTION).all<{ actor: string; namespace: string; params: string }>();
      expect(rows.results.map((r) => [r.actor, r.namespace, JSON.parse(r.params)])).toEqual([
        ["system:maintenance", "capsid", { repo: "example-org/sample", branch: "feat/done", sha: "a1", pr: 3 }],
      ]);
    } finally {
      await env.APP_KV.delete(PRUNE_SWITCH_KEY);
    }
  });
});

describe("GET /portal/api/maintenance, through the Worker", () => {
  // The gate (a bearer's 403, an anonymous caller's sign-in) is driven for every Portal
  // route in test-integration/route-gates.test.ts.
  async function read(): Promise<{ status: number; cache: string | null; body: PortalMaintenance }> {
    const SECRET = "integration-portal-maintenance-key";
    const session = (await portalSessionCookie({ email: "admin@example.com" }, SECRET, new Date())).split(";")[0];
    const ctx = createExecutionContext();
    const request = new Request(`https://capsid.test${PORTAL_MAINTENANCE_PATH}`, { headers: { Cookie: session, "Sec-Fetch-Site": "same-origin" }, redirect: "manual" });
    const response = (await worker.fetch!(request as never, { ...(env as unknown as Env), COOKIE_ENCRYPTION_KEY: SECRET } as never, ctx)) as unknown as Response;
    await waitOnExecutionContext(ctx);
    return { status: response.status, cache: response.headers.get("Cache-Control"), body: (await response.json()) as PortalMaintenance };
  }

  it("answers no pass yet before the first run, then the stored list with what it read", async () => {
    const before = await read();
    expect(before.status).toBe(200);
    expect(before.body.generated).toBeNull();
    expect(before.body.items).toEqual([]);

    await post("LATER 2026-10-01: stale");
    expect((await maintenanceTick(env as never, NOW, NO_PRS, NO_BRANCHES, NO_DEPLOYS, NO_DRIFT, NO_RELEASES)).ran).toBe(true);
    const after = await read();
    expect(after.cache).toBe("no-store");
    expect(after.body.generated).toBe(NOW.toISOString());
    expect(after.body.items.map((i) => i.rule)).toEqual(["later-passed"]);
    expect(after.body.read).toEqual({ prs: 0, branches: 7, repos: 7, roster: 7, deploys: 0 });
  });
});
