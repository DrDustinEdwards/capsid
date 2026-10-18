import assert from "node:assert/strict";
import { test } from "node:test";
import type { InstalledRepo } from "../src/github/client.ts";
import { buildPublicCode } from "../src/public-code.ts";
import { PublicCodeSchema } from "../src/public-code-schema.ts";
import { PUBLIC_BUILD_LAST_KEY, PUBLIC_CODE_KEY, PUBLIC_DOCS, PUBLIC_MODEL_KEY, publicBuildTick, type PublicBuildReaders } from "../src/public-data.ts";
import { bundledModel } from "../src/public-data.ts";
import type { StatsRows } from "../src/public-stats.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// The public code maps (docs/public-data.md, "The code maps"): which repos are read, what
// passes the parse, and how a broken map leaves the rest of the daily build alone.

const NOW = new Date("2026-10-17T00:05:00Z");
const PRIVATE_REPOS = new Set(["germomics", "foxing", "foxhound", "txasm", "julieedwards-info"]);
const ALL = ["capsid", "capsomer", "site-runtime", "d1-dump", "devkit", "site-api", "prelum", "carrel", "enarratio", "dustinedwards-info", "claude-skills", ...PRIVATE_REPOS];
const privacy = new Map(ALL.map((n) => [`drdustinedwards/${n}`, PRIVATE_REPOS.has(n)] as const));
const env = fakeEnv({});

function sampleMap(repo = "DrDustinEdwards/d1-dump"): Record<string, unknown> {
  return {
    version: 1,
    repo,
    sha: "a".repeat(40),
    date: "2026-10-17",
    tools: { typescript: "5.9.3", coverage: "istanbul", mutation: null },
    modules: [
      { path: "src/cli.ts", loc: 40, imports: ["src/run.ts"], functions: [{ name: "main", line: 3, end: 30, cc: 14, coverage: 0, crap: 210, mutants: null, score: null }] },
      { path: "src/run.ts", loc: 12, imports: [], functions: [] },
    ],
    cycles: [],
  };
}

function only(maps: Record<string, unknown>) {
  const reads: string[] = [];
  const read = async (_env: unknown, repo: string) => {
    reads.push(repo);
    return Object.hasOwn(maps, repo) ? maps[repo] : null;
  };
  return { reads, read };
}

test("only a public system's repos are read, and a repo with no map is left out", async () => {
  const { reads, read } = only({ "DrDustinEdwards/d1-dump": sampleMap() });
  const doc = await buildPublicCode(env, bundledModel(), privacy, "2026-10-17", read);
  assert.deepEqual(doc.maps.map((m) => [m.system, m.repo]), [["d1-dump", "DrDustinEdwards/d1-dump"]]);
  for (const r of PRIVATE_REPOS) assert.ok(!reads.includes(`DrDustinEdwards/${r}`), `the private repo ${r} was read`);
  assert.ok(reads.includes("DrDustinEdwards/capsid"));
  PublicCodeSchema.parse(doc);
});

test("a system the model keeps private is never read, even when GitHub says its repo is public", async () => {
  const model = bundledModel();
  const hidden = { ...model, systems: model.systems.map((s) => (s.id === "d1-dump" ? { ...s, public: false } : s)) };
  const { reads, read } = only({ "DrDustinEdwards/d1-dump": sampleMap() });
  const doc = await buildPublicCode(env, hidden, privacy, "2026-10-17", read);
  assert.deepEqual(doc.maps, []);
  assert.ok(!reads.includes("DrDustinEdwards/d1-dump"));
});

test("PLANT: a field the schema does not name never reaches the document", async () => {
  const planted = sampleMap();
  (planted as { secret?: string }).secret = "CANARY-7f3e";
  const mods = planted.modules as Array<Record<string, unknown>>;
  mods[0].owner = "CANARY-7f3e";
  (mods[0].functions as Array<Record<string, unknown>>)[0].source = "CANARY-7f3e";
  const { read } = only({ "DrDustinEdwards/d1-dump": planted });
  const doc = await buildPublicCode(env, bundledModel(), privacy, "2026-10-17", read);
  assert.doesNotMatch(JSON.stringify(doc), /CANARY/);
  PublicCodeSchema.parse(doc);
});

test("a stale function and an older mutation run reach the document; a bad mutated sha throws", async () => {
  const m = sampleMap();
  m.tools = { typescript: "5.9.3", coverage: "istanbul", mutation: "stryker" };
  m.mutated = { sha: "b".repeat(40), date: "2026-10-12" };
  const fn = ((m.modules as Array<Record<string, unknown>>)[0].functions as Array<Record<string, unknown>>)[0];
  fn.stale = true;
  const doc = await buildPublicCode(env, bundledModel(), privacy, "2026-10-17", only({ "DrDustinEdwards/d1-dump": m }).read);
  assert.deepEqual(doc.maps[0].mutated, { sha: "b".repeat(40), date: "2026-10-12" });
  assert.equal(doc.maps[0].modules[0].functions[0].stale, true);
  PublicCodeSchema.parse(doc);
  const bad = { ...m, mutated: { sha: "main", date: "2026-10-12" } };
  await assert.rejects(buildPublicCode(env, bundledModel(), privacy, "2026-10-17", only({ "DrDustinEdwards/d1-dump": bad }).read), /invalid/);
});

test("a map that fails the schema, names another repo, or climbs out of the repo throws", async () => {
  const bad = (m: Record<string, unknown>) => buildPublicCode(env, bundledModel(), privacy, "2026-10-17", only({ "DrDustinEdwards/d1-dump": m }).read);
  await assert.rejects(bad({ ...sampleMap(), sha: "main" }), /code map for DrDustinEdwards\/d1-dump is invalid/);
  await assert.rejects(bad(sampleMap("DrDustinEdwards/germomics")), /names DrDustinEdwards\/germomics/);
  await assert.rejects(bad({ ...sampleMap(), modules: [{ path: "../secrets.ts", loc: 1, imports: [], functions: [] }] }), /invalid/);
  await assert.rejects(bad({ ...sampleMap(), modules: [{ path: "/etc/passwd", loc: 1, imports: [], functions: [] }] }), /invalid/);
});

test("a broken map keeps the last code document and is reported, and the model is still built", async () => {
  const kv = fakeKv({ seed: { [PUBLIC_CODE_KEY]: "last code" } });
  const readers: PublicBuildReaders = {
    listRepos: async () => ({ repos: ALL.map((n): InstalledRepo => ({ full_name: `DrDustinEdwards/${n}`, private: PRIVATE_REPOS.has(n), archived: false, pushed_at: null })) }),
    statsRows: async (_e, _n, systems): Promise<StatsRows> => ({ finished: [], open: [], outcomes: [], evaluations: [], waits: [], rings: [], documents: 0, namespaces: 0, systems, sha: undefined }),
    codeMap: async (_e, repo) => (repo === "DrDustinEdwards/d1-dump" ? { version: 2 } : null),
  };
  const report = await publicBuildTick(fakeEnv({ APP_KV: kv.kv }), NOW, readers);
  assert.ok(report.ran && "codeFailed" in report, report.note);
  assert.match(report.note, /code maps kept from the last build: code map for DrDustinEdwards\/d1-dump is invalid/);
  assert.equal(kv.store.get(PUBLIC_CODE_KEY), "last code");
  assert.ok(kv.store.has(PUBLIC_MODEL_KEY));
  assert.ok(kv.store.has(PUBLIC_BUILD_LAST_KEY), "a broken code map left the day unstamped, so it would retry every tick");

  const good = fakeKv();
  const ok = await publicBuildTick(fakeEnv({ APP_KV: good.kv }), NOW, { ...readers, codeMap: async (_e, repo) => (repo === "DrDustinEdwards/d1-dump" ? sampleMap() : null) });
  assert.ok(ok.ran && !("codeFailed" in ok));
  assert.match(ok.note, /1 code map\(s\) \(d1-dump\)/);
  const doc = PublicCodeSchema.parse(JSON.parse(good.store.get(PUBLIC_CODE_KEY) ?? "null"));
  assert.equal(doc.maps[0].modules[0].functions[0].crap, 210);
  assert.equal(PUBLIC_DOCS.code.key, PUBLIC_CODE_KEY);
});
