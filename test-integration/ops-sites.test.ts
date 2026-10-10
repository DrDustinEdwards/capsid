import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addSite, editSite, readSiteConfig, removeSite, sitesFrom, validateSite, type SiteInput } from "../src/ops-sites";

// The Portal's site configuration against a real D1 with every migration applied
// (migrations/0022_ops_sites.sql): the seed, the schema's own checks, and the three
// guarded writes with their audit rows.

const ACTOR = "access:admin@example.com";

// What OPS_SITES and NO_SITE_NAMESPACES held in src/ops-sites.ts at 44560be, the last
// commit before the list moved into the table. The seed must reproduce it exactly, so
// the Portal watches the same sites the moment this deploys.
const BEFORE_THE_MOVE = [
  { namespace: "bsw", name: "BSW", origin: "https://bsw.dustin-edwards.workers.dev", health_path: null, platform: "cloudflare", script: "bsw", self_probe: false },
  { namespace: "capsid", name: "Capsid", origin: "https://capsid.dustin-edwards.workers.dev", health_path: "/health", platform: "cloudflare", script: "capsid", self_probe: true },
  { namespace: "claude-skills", name: "claude-skills", origin: null, health_path: null, platform: null, script: null, self_probe: false },
  { namespace: "dustinedwards", name: "dustinedwards.info", origin: "https://dustinedwards.info", health_path: "/api/health", platform: "cloudflare", script: null, self_probe: false },
  { namespace: "foxhound", name: "Foxhound", origin: "https://foxhoundapp.com", health_path: null, platform: "cloudflare", script: null, self_probe: false },
  { namespace: "foxing", name: "Foxing", origin: "https://foxing.app", health_path: null, platform: "cloudflare", script: null, self_probe: false },
  { namespace: "germomics", name: "Germomics", origin: "https://germomics.com", health_path: "/health", platform: "cloudflare", script: null, self_probe: false },
  { namespace: "julieedwards", name: "julieedwards.info", origin: "https://julieedwards.info", health_path: null, platform: "vercel", script: null, self_probe: false },
  { namespace: "txasm", name: "TXASM", origin: "https://txasm.org", health_path: null, platform: "cloudflare", script: null, self_probe: false },
];

async function auditRows(): Promise<Array<{ actor: string; action: string; namespace: string; params: string }>> {
  const { results } = await env.DB.prepare("SELECT actor, action, namespace, params FROM audit_log ORDER BY id").all<{ actor: string; action: string; namespace: string; params: string }>();
  return results ?? [];
}

function input(over: Partial<SiteInput> = {}): SiteInput {
  return { namespace: "sample", name: "Sample", origin: "https://sample.example.com", health_path: "/health", platform: "cloudflare", script: null, ...over };
}

describe("the seed", () => {
  it("is exactly the list the code held before the move: eight sites and one namespace with none", async () => {
    const rows = await readSiteConfig(env.DB);
    expect(rows.map(({ revision: _r, updated_at: _u, operator: _o, operator_problem: _p, ...rest }) => rest)).toEqual(BEFORE_THE_MOVE);
    // migrations/0035 opts dustinedwards alone into Capsid calling its operator API.
    expect(rows.filter((r) => r.operator).map((r) => [r.namespace, r.operator?.auth_var])).toEqual([["dustinedwards", "DUSTINEDWARDS_OPERATOR_TOKEN"]]);
    expect(rows.every((r) => r.operator_problem === null)).toBe(true);
    expect(rows.every((r) => r.revision === 1)).toBe(true);
    expect(sitesFrom(rows)).toHaveLength(8);
  });

  // scanner-rule: a seeded script is named only where the host proves it
  it("names a script only where the host proves it, a workers.dev host's first label, and self-probes Capsid alone", async () => {
    const sites = sitesFrom(await readSiteConfig(env.DB));
    const named = sites.filter((s) => s.script !== undefined);
    expect(named.map((s) => s.script).sort()).toEqual(["bsw", "capsid"]);
    for (const s of sites) {
      const host = new URL(s.origin).hostname;
      if (host.endsWith(".workers.dev")) expect(s.script, `${s.namespace} is on workers.dev and does not name its script`).toBe(host.split(".")[0]);
      else expect(s.script, `${s.namespace} names a script its host does not prove`).toBeUndefined();
    }
    expect(sites.filter((s) => s.self).map((s) => s.namespace)).toEqual(["capsid"]);
  });

  it("passes the Portal's own validation, so every seeded row can be edited as it stands", async () => {
    for (const row of await readSiteConfig(env.DB)) {
      const params = Object.fromEntries(
        Object.entries({ namespace: row.namespace, name: row.name, origin: row.origin, health_path: row.health_path, platform: row.platform, script: row.script }).filter(([, v]) => v !== null)
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
    expect(BROKEN).toHaveLength(5);
    for (const [label, values] of BROKEN) {
      const insert = env.DB.prepare(
        "INSERT INTO ops_sites (namespace, name, origin, health_path, platform, script, self_probe) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
      ).bind(...values);
      await expect(insert.run(), `the table accepted ${label}`).rejects.toThrow(/CHECK constraint failed/);
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
    expect(rows.map((r) => [r.actor, r.action, r.namespace])).toEqual([[ACTOR, "ops-site-added", "sample"]]);
    expect(JSON.parse(rows[0].params).after.origin).toBe("https://sample.example.com");

    const again = await addSite(env.DB, ACTOR, input({ name: "Other" }));
    expect(again.ok).toBe(false);
    expect(again.ok ? "" : again.refusal).toMatch(/already has a row/);
    expect(await auditRows()).toHaveLength(1);
    expect((await readSiteConfig(env.DB)).find((r) => r.namespace === "sample")?.name).toBe("Sample");
  });

  it("PLANT: edit and remove refuse a revision that is not the row's, and write nothing", async () => {
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
    const [capsid] = (await readSiteConfig(env.DB)).filter((r) => r.namespace === "capsid");
    const keep = await editSite(env.DB, ACTOR, { namespace: "capsid", name: "Capsid", origin: capsid.origin, health_path: "/health", platform: "cloudflare", script: "capsid" }, capsid.revision);
    expect(keep.ok && keep.site.self_probe).toBe(true);
    const moved = await editSite(
      env.DB,
      ACTOR,
      { namespace: "capsid", name: "Capsid", origin: "https://capsid.example.com", health_path: "/health", platform: "cloudflare", script: "capsid" },
      capsid.revision + 1
    );
    expect(moved.ok && moved.site.self_probe).toBe(false);
  });

  it("remove deletes the row and keeps it whole in the audit row", async () => {
    await addSite(env.DB, ACTOR, input());
    const removed = await removeSite(env.DB, ACTOR, "sample", 1);
    expect(removed.ok).toBe(true);
    expect((await readSiteConfig(env.DB)).some((r) => r.namespace === "sample")).toBe(false);
    const audit = (await auditRows()).find((r) => r.action === "ops-site-removed");
    expect(JSON.parse(audit?.params ?? "{}").before).toMatchObject({ namespace: "sample", origin: "https://sample.example.com", health_path: "/health" });
  });
});
