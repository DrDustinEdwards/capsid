import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMITS_READ,
  gatherReleaseItems,
  githubReleaseReaders,
  RELEASE_TAG_AUDIT_ACTION,
  RELEASE_TAG_CAP,
  RELEASE_TAGS_SWITCH_KEY,
  versionCommit,
  type ReleasePackage,
  type ReleaseReaders,
} from "../src/maintenance-releases.ts";
import type { Env } from "../src/env.ts";
import { fakeEnv, fakeKv, withFetch, type Route } from "./fakes.ts";

// The maintenance pass's release-tag rule (Capsid improvement list, item 13). A shared
// package's merged version bump is tagged at the commit that set it, never backwards and
// never twice, at most RELEASE_TAG_CAP a run, each audit-logged; the seat's switch turns it
// off. Sample data only: example-org repos, namespace "sample".

const sha = (c: string) => c.repeat(40);
const C1 = sha("1");
const C2 = sha("2");
const C3 = sha("3");

test("the commit that set a version is the oldest of the newest run carrying it, not the newest commit", () => {
  const history = [
    { sha: C3, version: "1.3.0" }, // a dependency change that kept the version
    { sha: C2, version: "1.3.0" }, // the bump
    { sha: C1, version: "1.2.0" },
  ];
  assert.equal(versionCommit(history, "1.3.0", false), C2);
  assert.equal(versionCommit(history.slice(0, 2), "1.3.0", true), C2, "the file's whole history read: its first commit set the version");
  assert.equal(versionCommit(history.slice(0, 2), "1.3.0", false), null, "the run reaches the end of an incomplete read: not known, so not guessed");
  assert.equal(versionCommit([{ sha: C1, version: "1.2.0" }], "1.3.0", true), null, "the newest commit does not carry the version");
  assert.equal(versionCommit([], "1.3.0", true), null);
});

// The rule, on fake readers.

interface Repo {
  version: string | null;
  tags: string[];
  // Newest first.
  history: Array<{ sha: string; version: string | null }>;
  changelog?: string | null;
  tagFails?: string;
}

function readers(repos: Record<string, Repo>, made: Array<[string, string, string]> = [], released: string[] = []): ReleaseReaders {
  const get = (repo: string) => {
    const r = repos[repo];
    if (!r) throw new Error(`GitHub answered 404 for ${repo}`);
    return r;
  };
  return {
    packages: async () => Object.keys(repos).map((repo): ReleasePackage => ({ name: repo.split("/")[1], repo, namespace: "sample" })),
    head: async (repo) => ({ version: get(repo).version, branch: "main" }),
    tags: async (repo) => get(repo).tags,
    manifestCommits: async (repo, _branch, limit) => ({ shas: get(repo).history.slice(0, limit).map((h) => h.sha), complete: get(repo).history.length < limit }),
    versionAt: async (repo, s) => get(repo).history.find((h) => h.sha === s)?.version ?? null,
    changelog: async (repo) => get(repo).changelog ?? null,
    tag: async (repo, tag, s) => {
      const fail = get(repo).tagFails;
      if (fail) throw new Error(fail);
      made.push([repo, tag, s]);
    },
    release: async (repo, tag) => {
      released.push(`${repo}@${tag}`);
      return `https://github.example.com/${repo}/releases/tag/${tag}`;
    },
  };
}

function relEnv(seed: Record<string, string> = {}) {
  const audits: unknown[][] = [];
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (sql.includes("audit_log")) audits.push(args);
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
  return { env: fakeEnv({ DB, APP_KV: fakeKv({ seedToken: true, seed }).kv }) as Env, audits };
}

const BUMPED: Repo = { version: "1.3.0", tags: ["v1.2.0", "v1.1.0"], history: [{ sha: C3, version: "1.3.0" }, { sha: C2, version: "1.3.0" }, { sha: C1, version: "1.2.0" }] };

test("PLANT: a version with no tag is tagged at the commit that set it, audit-logged with repo, tag and sha", async () => {
  const made: Array<[string, string, string]> = [];
  const { env, audits } = relEnv();
  const got = await gatherReleaseItems(env, readers({ "example-org/kit": BUMPED }, made));
  assert.deepEqual(made, [["example-org/kit", "v1.3.0", C2]]);
  assert.equal(got.tagged, 1);
  assert.equal(got.read, 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0][0], "system:maintenance");
  assert.equal(audits[0][1], RELEASE_TAG_AUDIT_ACTION);
  assert.equal(audits[0][2], "sample");
  assert.deepEqual(JSON.parse(audits[0][4] as string), { repo: "example-org/kit", package: "kit", tag: "v1.3.0", sha: C2, release: null, release_error: null });
  assert.deepEqual(got.items.map((i) => i.rule), ["release-tagged"]);
  assert.match(got.items[0].line, /example-org\/kit was tagged v1\.3\.0 at 2{40} \(no CHANGELOG\.md section, so no release\)\. Its bump-consumers workflow runs on the tag\./);
});

test("a CHANGELOG section for the version publishes the release too; none, the tag alone", async () => {
  const released: string[] = [];
  const { env, audits } = relEnv();
  const withNotes = { ...BUMPED, changelog: "# Changelog\n\n## [1.3.0]\n- The sample widget.\n\n## [1.2.0]\n- older" };
  const got = await gatherReleaseItems(env, readers({ "example-org/kit": withNotes }, [], released));
  assert.deepEqual(released, ["example-org/kit@v1.3.0"]);
  assert.equal(JSON.parse(audits[0][4] as string).release, "https://github.example.com/example-org/kit/releases/tag/v1.3.0");
  assert.match(got.items[0].line, /and its release was published/);

  const none: string[] = [];
  await gatherReleaseItems(relEnv().env, readers({ "example-org/kit": { ...BUMPED, changelog: "## [1.2.0]\n- older" } }, [], none));
  assert.deepEqual(none, [], "a release with no section for its version was published");
});

test("THE INNOCENT DIRECTION: a tagged version, by either spelling, is left alone and nothing is written", async () => {
  for (const tags of [["v1.3.0", "v1.2.0"], ["1.3.0"]]) {
    const made: Array<[string, string, string]> = [];
    const { env, audits } = relEnv();
    const got = await gatherReleaseItems(env, readers({ "example-org/kit": { ...BUMPED, tags } }, made));
    assert.deepEqual(made, [], `retagged with tags ${tags.join(", ")}`);
    assert.equal(audits.length, 0);
    assert.deepEqual(got.items, []);
    assert.equal(got.read, 1, "quiet with one package read, not quiet on nothing read");
  }
});

test("PLANT: a version below the newest tag is never tagged, and is listed", async () => {
  const made: Array<[string, string, string]> = [];
  const { env, audits } = relEnv();
  const got = await gatherReleaseItems(env, readers({ "example-org/kit": { ...BUMPED, version: "1.1.5", tags: ["v1.2.0", "v1.1.0"] } }, made));
  assert.deepEqual(made, [], "tagged backwards");
  assert.equal(audits.length, 0);
  assert.deepEqual(got.items.map((i) => i.rule), ["release-backwards"]);
  assert.match(got.items[0].line, /version 1\.1\.5 on main, below its newest tag v1\.2\.0, so v1\.1\.5 was not made/);
});

test("a first release with no tag at all is tagged; a pre-release is listed for a person; no version is skipped", async () => {
  const made: Array<[string, string, string]> = [];
  const repos: Record<string, Repo> = {
    "example-org/fresh": { version: "0.1.0", tags: [], history: [{ sha: C1, version: "0.1.0" }] },
    "example-org/rc": { version: "2.0.0-rc.1", tags: ["v1.0.0"], history: [] },
    "example-org/none": { version: null, tags: [], history: [] },
  };
  const got = await gatherReleaseItems(relEnv().env, readers(repos, made));
  assert.deepEqual(made, [["example-org/fresh", "v0.1.0", C1]], "the file's whole history was read, so its first commit set the version");
  assert.deepEqual(got.items.map((i) => [i.rule, i.line.split(" ")[0]]), [
    ["release-tagged", "example-org/fresh"],
    ["release-untagged", "example-org/rc"],
  ]);
  assert.equal(got.read, 3);
});

test("the commit is not guessed when the run reaches the end of what was read", async () => {
  const made: Array<[string, string, string]> = [];
  const long = Array.from({ length: COMMITS_READ + 5 }, (_, i) => ({ sha: i.toString(16).padStart(40, "0"), version: "1.3.0" }));
  const got = await gatherReleaseItems(relEnv().env, readers({ "example-org/kit": { ...BUMPED, history: long } }, made));
  assert.deepEqual(made, []);
  assert.match(got.items[0].line, /the commit that set it was not found in the last 20 commits to package\.json: tag it by hand/);
});

test(`at most ${RELEASE_TAG_CAP} tags a run; the rest are listed for the next`, async () => {
  const made: Array<[string, string, string]> = [];
  const repos: Record<string, Repo> = {};
  for (let i = 0; i < RELEASE_TAG_CAP + 2; i++) repos[`example-org/kit-${i}`] = BUMPED;
  const { env, audits } = relEnv();
  const got = await gatherReleaseItems(env, readers(repos, made));
  assert.equal(made.length, RELEASE_TAG_CAP);
  assert.equal(audits.length, RELEASE_TAG_CAP, "one audit row per tag");
  const waiting = got.items.filter((i) => i.rule === "release-untagged");
  assert.equal(waiting.length, 2);
  assert.match(waiting[0].line, /waits for the next run \(3 tags are made per run\)/);
});

test("with the switch off, an untagged version is listed and nothing is tagged", async () => {
  const made: Array<[string, string, string]> = [];
  const { env, audits } = relEnv({ [RELEASE_TAGS_SWITCH_KEY]: "off" });
  const got = await gatherReleaseItems(env, readers({ "example-org/kit": BUMPED }, made));
  assert.deepEqual(made, []);
  assert.equal(audits.length, 0);
  assert.deepEqual(got.items.map((i) => i.rule), ["release-untagged"]);
  assert.match(got.items[0].line, /the auto-tag is off \(maintenance:release-tags\), so v1\.3\.0 was not made/);
});

test("a read or a tag that fails is listed as not checked, writes no audit row, and the next package is still read", async () => {
  const made: Array<[string, string, string]> = [];
  const { env, audits } = relEnv();
  const repos: Record<string, Repo> = {
    "example-org/refused": { ...BUMPED, tagFails: "tag v1.3.0 already exists in example-org/refused, or the commit is unknown. Nothing was changed." },
    "example-org/kit": BUMPED,
  };
  const r = readers(repos, made);
  const got = await gatherReleaseItems(env, { ...r, packages: async () => [{ name: "gone", repo: "example-org/gone", namespace: "sample" }, ...(await r.packages())] });
  assert.deepEqual(made, [["example-org/kit", "v1.3.0", C2]]);
  assert.equal(audits.length, 1);
  assert.deepEqual(got.items.map((i) => i.rule), ["releases-not-checked", "releases-not-checked", "release-tagged"]);
  assert.match(got.items[0].line, /GitHub answered 404 for example-org\/gone/);
  assert.match(got.items[1].line, /already exists/);

  const broken = await gatherReleaseItems(env, { ...r, packages: async () => { throw new Error("no such table: shared_packages"); } });
  assert.deepEqual(broken.items.map((i) => [i.rule, i.namespace]), [["releases-not-checked", "capsid"]]);
});

// The real readers, with GitHub faked at fetch: the reads and the one write they make.

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const file = (text: string) => ({ body: { type: "file", encoding: "base64", content: b64(text), size: text.length, sha: "blob" } });
const manifest = (version: string) => file(JSON.stringify({ name: "@example/kit", version }));

test("the GitHub readers find the bump through the App and create only the tag's ref", async () => {
  const atRef: Record<string, string> = { main: "1.3.0", [C3]: "1.3.0", [C2]: "1.3.0", [C1]: "1.2.0" };
  const routes: Record<string, Route> = {
    "GET /repos/example-org/kit": { body: { default_branch: "main" } },
    "GET /repos/example-org/kit/contents/package.json": (_b: unknown, p: URLSearchParams) => manifest(atRef[p.get("ref") ?? "main"]),
    "GET /repos/example-org/kit/tags": { body: [{ name: "v1.2.0" }, { name: "v1.1.0" }] },
    "GET /repos/example-org/kit/commits": { body: [{ sha: C3 }, { sha: C2 }, { sha: C1 }] },
    "GET /repos/example-org/kit/contents/CHANGELOG.md": { status: 404, body: { message: "Not Found" } },
    "POST /repos/example-org/kit/git/refs": { status: 201, body: {} },
  };
  const DB = {
    prepare: (sql: string) => ({
      all: async () => ({
        results: sql.includes("shared_packages")
          ? [{ name: "Kit", repo: "example-org/kit", formerly: "[]", local_paths: "[]" }]
          : [{ namespace: "sample", repos: JSON.stringify([{ repo: "example-org/kit", label: "primary" }]) }],
      }),
      bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }),
    }),
  };
  const env = fakeEnv({ DB, APP_KV: fakeKv({ seedToken: true }).kv }) as Env;
  await withFetch(routes, async (calls) => {
    const got = await gatherReleaseItems(env, githubReleaseReaders(env));
    const writes = calls.filter((c) => c.method !== "GET");
    assert.deepEqual(writes.map((c) => [c.method, c.path, c.body]), [["POST", "/repos/example-org/kit/git/refs", { ref: "refs/tags/v1.3.0", sha: C2 }]]);
    assert.equal(new URLSearchParams(calls.find((c) => c.path.endsWith("/commits"))?.search).get("path"), "package.json");
    assert.deepEqual(got.items.map((i) => [i.rule, i.namespace]), [["release-tagged", "sample"]], "the namespace that maps the repo");
  });
});
