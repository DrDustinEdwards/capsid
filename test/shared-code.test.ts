import assert from "node:assert/strict";
import { test } from "node:test";
import { behindBy, gitSpec, latestTag, presetSpec, sharedCodeView, type SharedConfig } from "../src/shared-code.ts";

// The Shared code view's rules (job_584b4e7f2824), on what was read rather than on GitHub.
// Sample data only: example-org repos, namespace "sample".

const NOW = new Date("2026-10-10T07:00:00.000Z");
const TAGS = ["v0.1.0", "v0.2.0", "v0.3.0", "v0.10.0", "latest", "v0.3.0-rc.1"];

test("a git dependency is read from every spelling npm writes, with its tag", () => {
  assert.deepEqual(gitSpec("github:Example-Org/Kit#v0.2.0"), { repo: "example-org/kit", ref: "v0.2.0" });
  assert.deepEqual(gitSpec("git+ssh://git@github.com/example-org/kit.git#v0.2.0"), { repo: "example-org/kit", ref: "v0.2.0" });
  assert.deepEqual(gitSpec("git+https://github.com/example-org/kit.git"), { repo: "example-org/kit", ref: null });
  assert.deepEqual(gitSpec("https://github.com/example-org/kit#v1.0.0"), { repo: "example-org/kit", ref: "v1.0.0" });
  assert.deepEqual(gitSpec("example-org/kit#v1.0.0"), { repo: "example-org/kit", ref: "v1.0.0" });
  assert.equal(gitSpec("^1.2.3"), null);
  assert.equal(gitSpec("file:../kit"), null);
  assert.equal(gitSpec("example-org/kit"), null, "a bare a/b is not a repo");
  assert.deepEqual(presetSpec("github>example-org/devkit"), { repo: "example-org/devkit", ref: null });
  assert.deepEqual(presetSpec("github>example-org/devkit:node#v2.0.0"), { repo: "example-org/devkit", ref: "v2.0.0" });
  assert.equal(presetSpec("config:recommended"), null);
});

test("the newest release is by version, not by text, and behind counts the releases after the pin", () => {
  assert.equal(latestTag(TAGS), "v0.10.0");
  assert.equal(latestTag(["latest"]), null);
  assert.equal(behindBy("v0.2.0", TAGS), 2, "v0.3.0 and v0.10.0 are newer");
  assert.equal(behindBy("v0.10.0", TAGS), 0);
  assert.equal(behindBy("main", TAGS), null, "a branch is not a release");
  assert.equal(behindBy(null, TAGS), null);
});

const KIT: SharedConfig = { name: "Kit", repo: "example-org/kit", formerly: ["example-org/old-kit"], local_paths: ["sample:packages/kit", "sample-b:packages/kit"] };
const DEVKIT: SharedConfig = { name: "devkit", repo: "example-org/devkit", formerly: [], local_paths: [] };

function app(namespace: string, deps: Record<string, string>, blobs: string[], presets: string[] = [], lockVersions: Record<string, string> = {}) {
  return { namespace, name: namespace.toUpperCase(), blobs: new Set(blobs), manifests: [{ path: "package.json", deps, lockVersions }], presets, error: null };
}

test("PLANT: an app pinned two releases behind, one current, one through the old name, and a local copy still there", () => {
  const view = sharedCodeView(
    [KIT, DEVKIT],
    new Map<string, string[] | string>([["Kit", TAGS], ["devkit", ["v1.0.0"]]]),
    [
      app("sample", { "@example/kit": "github:example-org/kit#v0.2.0" }, ["package.json", "packages/kit/index.ts"], ["github>example-org/devkit"]),
      app("sample-b", { "@example/kit": "github:example-org/old-kit#v0.10.0", react: "19.0.0" }, ["package.json"]),
      app("sample-c", { "@example/kit": "git+https://github.com/example-org/kit.git" }, ["package.json"], [], { "@example/kit": "v0.3.0" }),
      { namespace: "sample-d", name: "SAMPLE-D", blobs: null, manifests: [], presets: [], error: "its file tree could not be read" },
    ],
    NOW
  );
  assert.equal(view.apps_read, 3, "the read count says how many apps the answer covers");
  assert.deepEqual(view.apps_failed, [{ namespace: "sample-d", error: "its file tree could not be read" }]);
  const kit = view.packages.find((p) => p.name === "Kit")!;
  assert.equal(kit.latest, "v0.10.0");
  assert.deepEqual(
    kit.users.map((u) => [u.namespace, u.pinned, u.behind, u.via_old_name]),
    [
      ["sample", "v0.2.0", 2, false],
      ["sample-b", "v0.10.0", 0, true],
      ["sample-c", "v0.3.0", 1, false],
    ]
  );
  assert.equal(kit.behind, 2, "two apps are at least one release behind");
  assert.deepEqual(kit.local_copies, [
    { namespace: "sample", path: "packages/kit", present: true },
    { namespace: "sample-b", path: "packages/kit", present: false },
  ]);
  assert.equal(kit.local_left, 1);
  const devkit = view.packages.find((p) => p.name === "devkit")!;
  assert.deepEqual(devkit.users.map((u) => [u.namespace, u.where, u.pinned, u.behind]), [["sample", "renovate", null, null]]);
});

test("a package whose tags could not be read says why, and still lists who uses it", () => {
  const view = sharedCodeView([KIT], new Map([["Kit", "GitHub answered 404 for example-org/kit's tags"]]), [app("sample", { "@example/kit": "github:example-org/kit#v0.2.0" }, ["package.json"])], NOW);
  assert.equal(view.packages[0].tags_error, "GitHub answered 404 for example-org/kit's tags");
  assert.equal(view.packages[0].latest, null);
  assert.equal(view.packages[0].users[0].behind, null, "behind is unknown, not zero, without the tags");
});
