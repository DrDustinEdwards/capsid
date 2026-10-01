import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addPackage,
  editPackage,
  historyKey,
  packageHistory,
  readPackageConfig,
  removePackage,
  weekStatement,
  type FetchLike,
} from "../src/ops-packages";
import type { PackageSnapshot } from "../src/ops-types";

// The Packages panel against a real D1 and KV (job_c6e4ab939a54): its configuration is
// written like the sites', its weekly rows are written once a week, and its history is
// read on demand in ranges npm will not shorten, joined to a former name, and cached.

type Env = Parameters<typeof packageHistory>[0];
const ENV = env as unknown as Env;
const ACTOR = "access:admin@example.com";
const NOW = new Date("2026-09-30T08:00:00Z");

beforeEach(async () => {
  for (const table of ["ops_packages", "ops_package_weeks", "audit_log"]) await env.DB.prepare(`DELETE FROM ${table}`).run();
  for (const name of ["sample-pkg", "sample-old"]) await env.APP_KV.delete(historyKey(name));
});

async function audit(action: string) {
  return env.DB.prepare("SELECT actor, params FROM audit_log WHERE action = ?1").bind(action).all<{ actor: string; params: string }>();
}

describe("configuration", () => {
  it("add, edit and remove are audited, and an edit or a removal names the revision it read", async () => {
    const added = await addPackage(env.DB, ACTOR, { name: "sample-pkg", repo: "example-org/sample-pkg", formerly: null });
    expect(added.ok).toBe(true);
    expect((await addPackage(env.DB, ACTOR, { name: "sample-pkg", repo: null, formerly: null })).ok, "a second add replaced the row").toBe(false);

    expect((await editPackage(env.DB, ACTOR, { name: "sample-pkg", repo: "example-org/sample-pkg", formerly: "sample-old" }, 2)).ok, "a stale revision was accepted").toBe(false);
    const edited = await editPackage(env.DB, ACTOR, { name: "sample-pkg", repo: "example-org/sample-pkg", formerly: "sample-old" }, 1);
    expect(edited.ok && edited.pkg).toMatchObject({ formerly: "sample-old", revision: 2 });

    expect((await removePackage(env.DB, ACTOR, "sample-pkg", 1)).ok).toBe(false);
    expect((await removePackage(env.DB, ACTOR, "sample-pkg", 2)).ok).toBe(true);
    expect(await readPackageConfig(env.DB)).toEqual([]);

    for (const action of ["ops-package-added", "ops-package-edited", "ops-package-removed"]) {
      const rows = (await audit(action)).results ?? [];
      expect(rows.map((r) => r.actor), action).toEqual([ACTOR]);
    }
    const removed = JSON.parse((await audit("ops-package-removed")).results![0].params);
    expect(removed.before).toMatchObject({ name: "sample-pkg", formerly: "sample-old" });
  });

  it("the schema refuses a former name equal to the name, whatever the caller checked", async () => {
    await expect(env.DB.prepare("INSERT INTO ops_packages (name, formerly) VALUES ('sample-pkg', 'sample-pkg')").run()).rejects.toThrow();
  });
});

describe("the weekly GitHub row", () => {
  const snap = (stars: number): PackageSnapshot => ({
    name: "sample-pkg",
    registry: "npm",
    at: NOW.toISOString(),
    npm: { state: "none", reason: "x" },
    downloads: { state: "none", reason: "x" },
    dependents: { state: "none", reason: "x" },
    github: { state: "ok", repo: "example-org/sample-pkg", stars, open_issues: 2, open_prs: 1, open_prs_capped: false, latest_release: { tag: "v1.0.0", published_at: null } },
  });

  it("is written by the first pass of the week, and later passes that week change nothing", async () => {
    await env.DB.batch([weekStatement(env.DB, snap(5), NOW)!]);
    await env.DB.batch([weekStatement(env.DB, snap(9), new Date("2026-10-01T08:00:00Z"))!]);
    await env.DB.batch([weekStatement(env.DB, snap(11), new Date("2026-10-06T08:00:00Z"))!]);
    const { results } = await env.DB.prepare("SELECT week, stars FROM ops_package_weeks ORDER BY week").all();
    expect(results).toEqual([
      { week: "2026-W40", stars: 5 },
      { week: "2026-W41", stars: 11 },
    ]);
  });

  it("is not written from a pass that could not read GitHub", () => {
    expect(weekStatement(env.DB, { ...snap(1), github: { state: "error", reason: "GitHub answered 502" } }, NOW)).toBeNull();
  });
});

describe("the daily history", () => {
  // A fake npm: sample-old published 2025-01-01, sample-pkg on 2026-09-01. Each range
  // answers one download on its first day, so the days read back name the ranges.
  function fakeNpm(): { fetchImpl: FetchLike; ranges: string[] } {
    const ranges: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      const u = new URL(url);
      const created = u.pathname === "/sample-old" ? "2025-01-01T00:00:00Z" : u.pathname === "/sample-pkg" ? "2026-09-01T00:00:00Z" : null;
      if (u.host === "registry.npmjs.org" && created) return Response.json({ time: { created } });
      const m = /^\/downloads\/range\/(\d{4}-\d\d-\d\d):(\d{4}-\d\d-\d\d)\/(.+)$/.exec(u.pathname);
      if (u.host === "api.npmjs.org" && m) {
        ranges.push(`${m[3]} ${m[1]}:${m[2]}`);
        return Response.json({ start: m[1], end: m[2], package: m[3], downloads: [{ day: m[1], downloads: 1 }, { day: m[2], downloads: 0 }] });
      }
      return new Response("not found", { status: 404 });
    };
    return { fetchImpl, ranges };
  }

  it("reads from each name's first publish to yesterday, in ranges of at most 540 days, joined, oldest first", async () => {
    await addPackage(env.DB, ACTOR, { name: "sample-pkg", repo: null, formerly: "sample-old" });
    const [cfg] = await readPackageConfig(env.DB);
    const { fetchImpl, ranges } = fakeNpm();
    const history = await packageHistory(ENV, cfg, fetchImpl, NOW);
    expect(ranges).toEqual(["sample-old 2025-01-01:2026-06-24", "sample-old 2026-06-25:2026-09-29", "sample-pkg 2026-09-01:2026-09-29"]);
    expect(history.days).toEqual([
      { day: "2025-01-01", downloads: 1, name: "sample-old" },
      { day: "2026-06-25", downloads: 1, name: "sample-old" },
      { day: "2026-09-01", downloads: 1, name: "sample-pkg" },
    ]);
    expect(history.first_day).toBe("2025-01-01");
    expect(history.last_day).toBe("2026-09-01");
  });

  it("is served from the cache until its former name changes", async () => {
    await addPackage(env.DB, ACTOR, { name: "sample-pkg", repo: null, formerly: "sample-old" });
    const [cfg] = await readPackageConfig(env.DB);
    const first = fakeNpm();
    await packageHistory(ENV, cfg, first.fetchImpl, NOW);
    const second = fakeNpm();
    const again = await packageHistory(ENV, cfg, second.fetchImpl, new Date("2026-09-30T09:00:00Z"));
    expect(second.ranges, "a cached history was fetched again").toEqual([]);
    expect(again.fetched_at).toBe(NOW.toISOString());
    const third = fakeNpm();
    const changed = await packageHistory(ENV, { ...cfg, formerly: null }, third.fetchImpl, NOW);
    expect(third.ranges).toEqual(["sample-pkg 2026-09-01:2026-09-29"]);
    expect(changed.days.every((d) => d.name === "sample-pkg")).toBe(true);
  });

  it("a range that could not be read is named as missing, never counted as zero", async () => {
    await addPackage(env.DB, ACTOR, { name: "sample-pkg", repo: null, formerly: null });
    const [cfg] = await readPackageConfig(env.DB);
    const fetchImpl: FetchLike = async (url) =>
      new URL(url).host === "registry.npmjs.org" ? Response.json({ time: { created: "2026-09-01T00:00:00Z" } }) : new Response("busy", { status: 429 });
    const history = await packageHistory(ENV, cfg, fetchImpl, NOW);
    expect(history.days).toEqual([]);
    expect(history.notes.join(" ")).toMatch(/2026-09-01 to 2026-09-29: api.npmjs.org answered 429; those days are missing, not zero/);
  });
});
