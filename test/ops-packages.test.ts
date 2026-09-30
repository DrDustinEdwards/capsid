import assert from "node:assert/strict";
import { test } from "node:test";
import { historyRanges, isoWeek, readPackage, validatePackage, type FetchLike } from "../src/ops-packages.ts";
import type { OpsPackageConfig } from "../src/ops-types.ts";
import { fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// The Packages panel's pure parts and its per-pass read, against a fake of each source.
// The response shapes are the ones the live endpoints returned on 2026-09-30.

// ---- configuration --------------------------------------------------------------------

test("a package name is npm's: lowercase, URL-safe, optionally scoped", () => {
  for (const name of ["enarratio", "express", "@types/node", "a.b-c_d~e"]) assert.equal(validatePackage({ name }).ok, true, name);
  for (const name of ["", "Enarratio", "has space", "@scope", "@scope/", "../etc", "x".repeat(215)]) {
    assert.equal(validatePackage({ name }).ok, false, `accepted '${name}'`);
  }
});

test("a repository is owner/name, and a former name is a different npm name", () => {
  assert.deepEqual(validatePackage({ name: "enarratio", repo: "DrDustinEdwards/enarratio", formerly: "abscissa" }), {
    ok: true,
    pkg: { name: "enarratio", repo: "DrDustinEdwards/enarratio", formerly: "abscissa" },
  });
  assert.equal(validatePackage({ name: "enarratio", repo: "https://github.com/x/y" }).ok, false);
  assert.equal(validatePackage({ name: "enarratio", formerly: "enarratio" }).ok, false);
  assert.equal(validatePackage({ name: "enarratio", formerly: "Abscissa" }).ok, false);
  // Blank optional fields are absent, not empty strings.
  assert.deepEqual(validatePackage({ name: "enarratio", repo: " ", formerly: "" }), { ok: true, pkg: { name: "enarratio", repo: null, formerly: null } });
});

// ---- the history's ranges ---------------------------------------------------------------

test("the history is read in ranges npm will not shorten: contiguous, none over 540 days", () => {
  const ranges = historyRanges("2015-01-10", "2026-09-29");
  assert.equal(ranges[0][0], "2015-01-10");
  assert.equal(ranges[ranges.length - 1][1], "2026-09-29");
  const day = (s: string) => Date.parse(`${s}T00:00:00Z`) / 86_400_000;
  for (let i = 0; i < ranges.length; i++) {
    const [a, b] = ranges[i];
    assert.ok(day(b) - day(a) + 1 <= 540, `${a}:${b} is longer than 540 days`);
    if (i > 0) assert.equal(day(a), day(ranges[i - 1][1]) + 1, `a gap before ${a}`);
  }
  assert.deepEqual(historyRanges("2026-09-29", "2026-09-29"), [["2026-09-29", "2026-09-29"]]);
  assert.deepEqual(historyRanges("2026-09-30", "2026-09-29"), []);
});

test("weeks are ISO 8601 weeks", () => {
  assert.equal(isoWeek(new Date("2026-09-30T12:00:00Z")), "2026-W40");
  assert.equal(isoWeek(new Date("2021-01-03T00:00:00Z")), "2020-W53");
  assert.equal(isoWeek(new Date("2024-12-30T00:00:00Z")), "2025-W01");
});

// ---- one pass's read --------------------------------------------------------------------

type Answer = { status?: number; body?: unknown };

function fetchFrom(routes: Record<string, Answer>): { fetchImpl: FetchLike; seen: string[] } {
  const seen: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    seen.push(url);
    const a = routes[url];
    if (!a) return new Response("not found", { status: 500 });
    return new Response(a.body === undefined ? "" : JSON.stringify(a.body), { status: a.status ?? 200, headers: { "Content-Type": "application/json" } });
  };
  return { fetchImpl, seen };
}

const CFG: OpsPackageConfig = { name: "sample-pkg", registry: "npm", repo: null, formerly: null, revision: 1, updated_at: "2026-09-30 00:00:00" };
const NOW = new Date("2026-09-30T08:00:00Z");

test("one pass reads the registry, the counts, the dependents, and says there is no repository", async () => {
  const { fetchImpl, seen } = fetchFrom({
    "https://registry.npmjs.org/sample-pkg": { body: { name: "sample-pkg", "dist-tags": { latest: "1.2.0", next: "2.0.0-rc.1" }, versions: { "1.1.0": {}, "1.2.0": {}, "2.0.0-rc.1": {} }, modified: "2026-09-29T17:16:48.045Z" } },
    "https://api.npmjs.org/downloads/point/last-week/sample-pkg": { body: { downloads: 229, start: "2026-09-22", end: "2026-09-28", package: "sample-pkg" } },
    "https://api.npmjs.org/downloads/point/last-month/sample-pkg": { body: { downloads: 901, start: "2026-08-30", end: "2026-09-28", package: "sample-pkg" } },
    "https://api.npmjs.org/versions/sample-pkg/last-week": { body: { package: "sample-pkg", downloads: { "1.2.0": 200, "1.1.0": 29 } } },
    "https://api.deps.dev/v3/systems/npm/packages/sample-pkg": { body: { versions: [{ versionKey: { version: "1.1.0" } }, { versionKey: { version: "1.2.0" }, isDefault: true }] } },
    "https://api.deps.dev/v3alpha/systems/npm/packages/sample-pkg/versions/1.2.0:dependents": { body: { dependentCount: 12, directDependentCount: 3, indirectDependentCount: 9 } },
  });
  const snap = await readPackage(fakeEnv({}), CFG, fetchImpl, NOW);
  assert.deepEqual(snap.npm, { state: "ok", latest: "1.2.0", dist_tags: { latest: "1.2.0", next: "2.0.0-rc.1" }, versions: 3, modified: "2026-09-29T17:16:48.045Z" });
  assert.deepEqual(snap.downloads, { state: "ok", last_week: 229, last_month: 901, through: "2026-09-28", by_version_last_week: { "1.2.0": 200, "1.1.0": 29 } });
  assert.deepEqual(snap.dependents, { state: "ok", version: "1.2.0", direct: 3, indirect: 9, total: 12 });
  assert.equal(snap.github.state, "none");
  assert.equal(seen.length, 6, "a package with no repository costs six requests");
});

test("a new package npm has not counted yet has zero downloads and no dependents, not an error", async () => {
  // npm answers 404 "package not found" for a package with no counts yet, and deps.dev
  // answers 404 "dependents not found" for a version nothing depends on.
  const { fetchImpl } = fetchFrom({
    "https://registry.npmjs.org/sample-pkg": { body: { "dist-tags": { latest: "0.1.0" }, versions: { "0.1.0": {} } } },
    "https://api.npmjs.org/downloads/point/last-week/sample-pkg": { status: 404, body: { error: "package sample-pkg not found" } },
    "https://api.npmjs.org/downloads/point/last-month/sample-pkg": { status: 404, body: { error: "package sample-pkg not found" } },
    "https://api.npmjs.org/versions/sample-pkg/last-week": { status: 404, body: {} },
    "https://api.deps.dev/v3/systems/npm/packages/sample-pkg": { body: { versions: [{ versionKey: { version: "0.1.0" }, isDefault: true }] } },
    "https://api.deps.dev/v3alpha/systems/npm/packages/sample-pkg/versions/0.1.0:dependents": { status: 404 },
  });
  const snap = await readPackage(fakeEnv({}), CFG, fetchImpl, NOW);
  assert.deepEqual(snap.downloads, { state: "ok", last_week: 0, last_month: 0, through: null, by_version_last_week: {} });
  assert.equal(snap.dependents.state, "none");
});

test("each source fails on its own: an outage at npm does not blank the dependents", async () => {
  const { fetchImpl } = fetchFrom({
    "https://registry.npmjs.org/sample-pkg": { status: 503 },
    "https://api.npmjs.org/downloads/point/last-week/sample-pkg": { status: 429 },
    "https://api.deps.dev/v3/systems/npm/packages/sample-pkg": { body: { versions: [{ versionKey: { version: "1.0.0" }, isDefault: true }] } },
    "https://api.deps.dev/v3alpha/systems/npm/packages/sample-pkg/versions/1.0.0:dependents": { body: { dependentCount: 1, directDependentCount: 1, indirectDependentCount: 0 } },
  });
  const snap = await readPackage(fakeEnv({}), CFG, fetchImpl, NOW);
  assert.deepEqual(snap.npm, { state: "error", reason: "registry.npmjs.org answered 503" });
  assert.deepEqual(snap.downloads, { state: "error", reason: "api.npmjs.org answered 429" });
  assert.equal(snap.dependents.state, "ok");
});

test("a scoped name travels with its slash escaped where the registry and the version counts need it", async () => {
  const { fetchImpl, seen } = fetchFrom({});
  await readPackage(fakeEnv({}), { ...CFG, name: "@sample/pkg" }, fetchImpl, NOW);
  assert.ok(seen.includes("https://registry.npmjs.org/@sample%2Fpkg"), seen.join("\n"));
  assert.ok(seen.includes("https://api.npmjs.org/downloads/point/last-week/@sample/pkg"), seen.join("\n"));
  assert.ok(seen.includes("https://api.deps.dev/v3/systems/npm/packages/%40sample%2Fpkg"), seen.join("\n"));
});

test("the repository's numbers come from GitHub through the App, with pull requests taken out of the issue count", async () => {
  // GitHub's open_issues_count counts open pull requests as issues.
  const { fetchImpl } = fetchFrom({});
  const env = fakeEnv({ APP_KV: fakeKv({ seedToken: true }).kv });
  await withFetch(
    {
      "GET /repos/example-org/sample-pkg": { body: { stargazers_count: 4, open_issues_count: 3 } },
      "GET /repos/example-org/sample-pkg/pulls": { body: [{ number: 7 }, { number: 8 }] },
      "GET /repos/example-org/sample-pkg/releases/latest": { status: 404, body: { message: "Not Found" } },
    },
    async () => {
      const snap = await readPackage(env, { ...CFG, repo: "example-org/sample-pkg" }, fetchImpl, NOW);
      assert.deepEqual(snap.github, { state: "ok", repo: "example-org/sample-pkg", stars: 4, open_issues: 1, open_prs: 2, open_prs_capped: false, latest_release: null });
    }
  );
});
