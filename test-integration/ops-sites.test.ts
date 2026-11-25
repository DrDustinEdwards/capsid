import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addSite,
  editSite,
  readSiteConfig,
  removeSite,
  validateSite,
  type SiteInput,
} from "../src/ops-sites";

// The Portal's site configuration against a real D1 with every migration applied
// (migrations/0022_ops_sites.sql, 0051's health routes, 0052's and 0056's further hosts): the seed, the schema's own
// checks, and the three guarded writes with their audit rows.

const ACTOR = "access:admin@example.com";

async function auditRows(): Promise<
  Array<{ actor: string; action: string; namespace: string; params: string }>
> {
  const { results } = await env.DB.prepare(
    "SELECT actor, action, namespace, params FROM audit_log ORDER BY id",
  ).all<{ actor: string; action: string; namespace: string; params: string }>();
  return results ?? [];
}

function input(over: Partial<SiteInput> = {}): SiteInput {
  return {
    namespace: "sample",
    name: "Sample",
    origin: "https://sample.example.com",
    health_path: "/health",
    platform: "cloudflare",
    script: null,
    ...over,
  };
}

describe("the seed", () => {
  it("passes the Portal's own validation, so every seeded row can be edited as it stands", async () => {
    for (const row of await readSiteConfig(env.DB)) {
      const params = Object.fromEntries(
        Object.entries({
          namespace: row.namespace,
          name: row.name,
          origin: row.origin,
          health_path: row.health_path,
          platform: row.platform,
          script: row.script,
        }).filter(([, v]) => v !== null),
      ) as Record<string, string>;
      const checked = validateSite(params);
      expect(checked.ok, `${row.namespace}: ${checked.ok ? "" : checked.refusal}`).toBe(true);
    }
  });
});

describe("the schema", () => {
  // Each insert breaks one CHECK in the table, so a row the Portal would refuse cannot
  // arrive by another path either.
  const BROKEN: Array<[string, unknown[]]> = [
    ["an origin with no platform", ["broken-a", "x", "https://a.example.com", null, null, null, 0]],
    ["a platform with no origin", ["broken-b", "x", null, null, "cloudflare", null, 0]],
    ["an unknown platform", ["broken-c", "x", "https://c.example.com", null, "netlify", null, 0]],
    ["a health path on a no-site row", ["broken-d", "x", null, "/health", null, null, 0]],
    ["a self-probe on a no-site row", ["broken-e", "x", null, null, null, null, 1]],
  ];
  it("PLANT: refuses each of five rows the Portal would refuse", async () => {
    for (const [label, values] of BROKEN) {
      const insert = env.DB.prepare(
        "INSERT INTO ops_sites (namespace, name, origin, health_path, platform, script, self_probe) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      ).bind(...values);
      await expect(insert.run(), `the table accepted ${label}`).rejects.toThrow(
        /CHECK constraint failed/,
      );
    }
  });
});

describe("the writes", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM audit_log").run();
    await env.DB.prepare("DELETE FROM ops_sites WHERE namespace = 'sample'").run();
  });

  it("add writes the row and one audit row with it, and refuses a namespace that already has one", async () => {
    const added = await addSite(env.DB, ACTOR, input());
    expect(added.ok).toBe(true);
    const rows = await auditRows();
    expect(rows.map((r) => [r.actor, r.action, r.namespace])).toEqual([
      [ACTOR, "ops-site-added", "sample"],
    ]);
    expect(JSON.parse(rows[0].params).after.origin).toBe("https://sample.example.com");

    const again = await addSite(env.DB, ACTOR, input({ name: "Other" }));
    expect(again.ok).toBe(false);
    expect(again.ok ? "" : again.refusal).toMatch(/already has a row/);
    expect(await auditRows()).toHaveLength(1);
    expect((await readSiteConfig(env.DB)).find((r) => r.namespace === "sample")?.name).toBe(
      "Sample",
    );
  });

  it("PLANT: edit and remove refuse a revision that is not the row's, an edit refuses to move a token's origin, and neither writes", async () => {
    await addSite(env.DB, ACTOR, input());
    await env.DB.prepare("DELETE FROM audit_log").run();
    const edited = await editSite(env.DB, ACTOR, input({ health_path: "/healthz" }), 2);
    expect(edited.ok).toBe(false);
    expect(edited.ok ? "" : edited.refusal).toMatch(/changed since the preview/);
    const removed = await removeSite(env.DB, ACTOR, "sample", 7);
    expect(removed.ok).toBe(false);
    expect(await auditRows()).toEqual([]);
    const row = (await readSiteConfig(env.DB)).find((r) => r.namespace === "sample");
    expect(row?.health_path).toBe("/health");
    expect(row?.revision).toBe(1);

    // An edit that moves the origin while the row names an operator token is refused too:
    // the token would go to the new host.
    const operator = JSON.stringify({
      path: "/api/operator",
      auth_var: "SAMPLE_OPERATOR_TOKEN",
    });
    expect((await editSite(env.DB, ACTOR, input({ operator }), 1)).ok).toBe(true);
    await env.DB.prepare("DELETE FROM audit_log").run();
    const away = input({ origin: "https://elsewhere.example.net" });
    const moved = await editSite(env.DB, ACTOR, away, 2);
    expect(moved.ok, "the origin moved with the token still set").toBe(false);
    expect(moved.ok ? "" : moved.refusal).toMatch(/cannot change while it names an operator token/);
    expect(await auditRows()).toEqual([]);
    // Clearing the token in the same edit lets the origin move.
    const cleared = await editSite(env.DB, ACTOR, { ...away, operator: null }, 2);
    expect(cleared.ok, cleared.ok ? "" : cleared.refusal).toBe(true);
    expect(cleared.ok && cleared.site.operator).toBeNull();
  });

  it("edit at the right revision moves it on by one and audits both sides", async () => {
    await addSite(env.DB, ACTOR, input());
    const edited = await editSite(env.DB, ACTOR, input({ health_path: "/healthz" }), 1);
    expect(edited.ok, edited.ok ? "" : edited.refusal).toBe(true);
    expect(edited.ok && edited.site.revision).toBe(2);
    const audit = (await auditRows()).find((r) => r.action === "ops-site-edited");
    const params = JSON.parse(audit?.params ?? "{}");
    expect(params.before.health_path).toBe("/health");
    expect(params.after.health_path).toBe("/healthz");
    // The same revision a second time is stale now.
    expect((await editSite(env.DB, ACTOR, input({ health_path: "/other" }), 1)).ok).toBe(false);
  });

  it("an edit that moves Capsid's origin clears its self-probe; one that keeps it does not", async () => {
    // The seed no longer self-probes (0052), so the flag is set here to test what an edit does to it.
    await env.DB.prepare("UPDATE ops_sites SET self_probe = 1 WHERE namespace = 'capsid'").run();
    const [capsid] = (await readSiteConfig(env.DB)).filter((r) => r.namespace === "capsid");
    const keep = await editSite(
      env.DB,
      ACTOR,
      {
        namespace: "capsid",
        name: "Capsid",
        origin: capsid.origin,
        health_path: "/health",
        platform: "cloudflare",
        script: "capsid",
      },
      capsid.revision,
    );
    expect(keep.ok && keep.site.self_probe).toBe(true);
    const moved = await editSite(
      env.DB,
      ACTOR,
      {
        namespace: "capsid",
        name: "Capsid",
        origin: "https://capsid.example.com",
        health_path: "/health",
        platform: "cloudflare",
        script: "capsid",
      },
      capsid.revision + 1,
    );
    expect(moved.ok && moved.site.self_probe).toBe(false);
  });

  it("remove deletes the row and keeps it whole in the audit row", async () => {
    await addSite(env.DB, ACTOR, input());
    const removed = await removeSite(env.DB, ACTOR, "sample", 1);
    expect(removed.ok).toBe(true);
    expect((await readSiteConfig(env.DB)).some((r) => r.namespace === "sample")).toBe(false);
    const audit = (await auditRows()).find((r) => r.action === "ops-site-removed");
    expect(JSON.parse(audit?.params ?? "{}").before).toMatchObject({
      namespace: "sample",
      origin: "https://sample.example.com",
      health_path: "/health",
    });
  });
});
