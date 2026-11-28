import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { resetCapsidDb } from "./reset-db";
import { beforeEach, describe, expect, it } from "vitest";
import { maintenanceTick, readMaintenance, MAINTENANCE_LAST_KEY } from "../src/maintenance";
import type { PrReaders } from "../src/maintenance-prs";
import {
  PRUNE_AUDIT_ACTION,
  PRUNE_SWITCH_KEY,
  type BranchReaders,
} from "../src/maintenance-branches";
import type { DeployReaders } from "../src/maintenance-deploys";
import worker from "../src/index";
import type { Env } from "../src/env";
import type { PortalMaintenance } from "../src/ops-types/views";
import { portalSessionCookie } from "../src/portal-auth";
import { PORTAL_MAINTENANCE_PATH } from "../src/portal-maintenance";
import { gatherModelDriftItems } from "../src/model-drift";
import type { SystemModel } from "../src/system-model";
import { gatherRuleDocItems, RULE_DOC_CAP_BYTES } from "../src/rule-docs";

// The daily maintenance pass against a real D1.

const NOW = new Date("2026-10-08T12:00:00.000Z");
// The PR rules read GitHub (tested in test/maintenance.test.ts); here no repo has an open PR.
const NO_PRS: PrReaders = {
  openPrs: async () => ({ repo: "example-org/sample", prs: [], problem: null }),
  failingStep: async () => ({ step: null, problem: "not called" }),
};
// The branch rules read GitHub too (test/maintenance.test.ts); here every repo has only its default branch.
const NO_BRANCHES: BranchReaders = {
  plan: async () => ({
    owner: "example-org",
    name: "sample",
    repo: "example-org/sample",
    defaultBranch: "main",
    branchesRead: 1,
    listsComplete: true,
    openComplete: true,
    prune: [],
    kept: [],
  }),
  committedAt: async () => NOW.toISOString(),
  prune: async () => ({ deleted: [], skipped: [], remaining: 0 }),
};

// The undeployed-merge rule reads the watcher snapshot (test/maintenance.test.ts); here there are no sites, so it is quiet.
const NO_DEPLOYS: DeployReaders = {
  snapshot: async () => ({ sites: [] }) as never,
  defaultHead: async () => {
    throw new Error("not called");
  },
};
// The model drift check has its own tests (test/model-drift.test.ts); here it reads nothing.
const NO_DRIFT = async () => ({ items: [], read: 0 });
// One drift item, so a stored list holds something to read back.
const ONE_DRIFT = async () => ({
  items: [
    {
      rule: "model-drift" as const,
      namespace: "capsid",
      line: "example-org/new is not in the model",
    },
  ],
  read: 1,
});
beforeEach(async () => {
  await resetCapsidDb();
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
    .bind("sample", JSON.stringify([{ repo: "example-org/sample", label: "primary" }]))
    .run();
  await env.APP_KV.delete("maintenance:list");
  await env.APP_KV.delete(MAINTENANCE_LAST_KEY);
});

describe("gatherModelDriftItems", () => {
  // The reads against the real tables: the namespace mapping and ops_sites. The comparison
  // itself is tested in test/model-drift.test.ts.
  const MODEL: SystemModel = {
    version: 1,
    systems: [
      {
        id: "sample-site",
        name: "Sample",
        short: "Sample",
        family: "site",
        ring: "used",
        domain: "example.com",
        repos: ["example-org/sample-site"],
      },
    ],
    containers: [],
    relationships: [],
  };

  it("names a mapped repo the model does not, and reports an unread App list", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
      .bind(
        "drift-sample",
        JSON.stringify([
          { repo: "example-org/sample-site", label: "primary" },
          { repo: "example-org/sample-docs", label: "docs" },
        ]),
      )
      .run();
    const out = await gatherModelDriftItems(env as never, MODEL, async () => {
      throw new Error("no App key in tests");
    });
    const mine = out.items.filter(
      (i) => i.namespace === "drift-sample" || i.rule === "model-not-checked",
    );
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
      ["capsid", "conventions-sample.md", "Use the `register_namespace` tool."],
      ["sample", "core.md", "Ask `capsid_find_docs` action `namespaces`."],
      ["capsid", "research/old-design.md", "manage_pr ".repeat(3000)],
      ["sample", "archive/decisions-old.md", "x".repeat(RULE_DOC_CAP_BYTES + 1)],
    ];
    for (const [ns, path, body] of planted) {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO documents (namespace, path, title, body, type, status) VALUES (?1, ?2, 't', ?3, 'note', 'published')",
      )
        .bind(ns, path, body)
        .run();
    }
    try {
      const out = await gatherRuleDocItems(env.DB);
      const mine = out.items.filter((i) => i.namespace === "sample" || i.namespace === "capsid");
      expect(mine.map((i) => [i.rule, i.namespace, i.line.split(":")[0]])).toEqual([
        ["rule-doc", "capsid", "capsid/conventions-sample.md"],
        ["rule-doc", "sample", "sample/decisions.md"],
      ]);
      expect(mine[0].line).toContain("register_namespace");
      expect(mine[1].line).toContain("over its 20480-byte cap");
      // Three rule documents were read; the research note and the archived volume are records.
      expect(out.read).toBeGreaterThanOrEqual(3);
    } finally {
      for (const [ns, path] of planted)
        await env.DB.prepare("DELETE FROM documents WHERE namespace = ?1 AND path = ?2")
          .bind(ns, path)
          .run();
    }
  });
});

describe("maintenanceTick", () => {
  it("does not run before 11:00 UTC, runs once a day after, and stores the list", async () => {
    const early = await maintenanceTick(
      env as never,
      new Date("2026-10-08T09:00:00.000Z"),
      NO_PRS,
      NO_BRANCHES,
      NO_DEPLOYS,
      NO_DRIFT,
    );
    expect(early.ran).toBe(false);
    expect(await readMaintenance(env as never)).toBeNull();

    const first = await maintenanceTick(
      env as never,
      NOW,
      NO_PRS,
      NO_BRANCHES,
      NO_DEPLOYS,
      ONE_DRIFT,
    );
    expect(first.ran).toBe(true);
    expect((await readMaintenance(env as never))?.items.map((i) => i.rule)).toEqual([
      "model-drift",
    ]);
    // Every roster repo was read, and the count says so: zero open pull requests, not none read.
    expect(Object.values((await readMaintenance(env as never))?.prs_read ?? {})).toEqual([
      0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(Object.values((await readMaintenance(env as never))?.branches_read ?? {})).toEqual([
      1, 1, 1, 1, 1, 1, 1,
    ]);

    const second = await maintenanceTick(
      env as never,
      new Date("2026-10-08T15:00:00.000Z"),
      NO_PRS,
      NO_BRANCHES,
      NO_DEPLOYS,
      NO_DRIFT,
    );
    expect(second.ran).toBe(false);
    const nextDay = await maintenanceTick(
      env as never,
      new Date("2026-10-09T12:00:00.000Z"),
      NO_PRS,
      NO_BRANCHES,
      NO_DEPLOYS,
      NO_DRIFT,
    );
    expect(nextDay.ran).toBe(true);
  });

  it("writes one audit_log row per branch the default-on prune deleted, with the sha to put it back", async () => {
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
      const ran = await maintenanceTick(
        env as never,
        NOW,
        NO_PRS,
        ONE_MERGED,
        NO_DEPLOYS,
        NO_DRIFT,
      );
      expect(ran.ran && ran.note).toContain("1 pruned");
      const rows = await env.DB.prepare(
        "SELECT actor, namespace, params FROM audit_log WHERE action = ?1",
      )
        .bind(PRUNE_AUDIT_ACTION)
        .all<{ actor: string; namespace: string; params: string }>();
      expect(rows.results.map((r) => [r.actor, r.namespace, JSON.parse(r.params)])).toEqual([
        [
          "system:maintenance",
          "capsid",
          { repo: "example-org/sample", branch: "feat/done", sha: "a1", pr: 3 },
        ],
      ]);
    } finally {
      await env.APP_KV.delete(PRUNE_SWITCH_KEY);
    }
  });
});

describe("GET /portal/api/maintenance, through the Worker", () => {
  // The gate (a bearer's 403, an anonymous caller's sign-in) is driven for every Portal
  // route in test-integration/route-gates.test.ts.
  async function read(): Promise<{
    status: number;
    cache: string | null;
    body: PortalMaintenance;
  }> {
    const COOKIE_KEY = "integration-portal-maintenance-key";
    const session = (
      await portalSessionCookie({ email: "admin@example.com" }, COOKIE_KEY, new Date())
    ).split(";")[0];
    const ctx = createExecutionContext();
    const request = new Request(`https://capsid.test${PORTAL_MAINTENANCE_PATH}`, {
      headers: { Cookie: session, "Sec-Fetch-Site": "same-origin" },
      redirect: "manual",
    });
    const response = (await worker.fetch!(
      request as never,
      { ...(env as unknown as Env), COOKIE_ENCRYPTION_KEY: COOKIE_KEY } as never,
      ctx,
    )) as unknown as Response;
    await waitOnExecutionContext(ctx);
    return {
      status: response.status,
      cache: response.headers.get("Cache-Control"),
      body: (await response.json()) as PortalMaintenance,
    };
  }

  it("answers no pass yet before the first run, then the stored list with what it read", async () => {
    const before = await read();
    expect(before.status).toBe(200);
    expect(before.body.generated).toBeNull();
    expect(before.body.items).toEqual([]);

    expect(
      (
        await maintenanceTick(
          env as never,
          NOW,
          NO_PRS,
          NO_BRANCHES,
          NO_DEPLOYS,
          ONE_DRIFT,
        )
      ).ran,
    ).toBe(true);
    const after = await read();
    expect(after.cache).toBe("private, no-store");
    expect(after.body.generated).toBe(NOW.toISOString());
    expect(after.body.items.map((i) => i.rule)).toEqual(["model-drift"]);
    expect(after.body.read).toEqual({ prs: 0, branches: 7, repos: 7, roster: 7, deploys: 0 });
  });
});
