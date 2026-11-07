import assert from "node:assert/strict";
import { test } from "node:test";
import { npmLockVersions, pnpmLockVersions, workflowPins } from "../src/lockfiles.ts";

// The versions model reads what a repo installed, not only what it asks for. Sample data only.

test("pnpm: a workspace's npm and git dependencies, peers stripped, the git version from packages", () => {
  const lock = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    devDependencies:",
    "      '@example/kit':",
    "        specifier: github:example-org/kit#v0.3.0",
    "        version: https://codeload.github.com/example-org/kit/tar.gz/aaaa(react@19.0.0)",
    "",
    "  apps/web:",
    "    dependencies:",
    "      '@example/kit':",
    "        specifier: github:example-org/kit#v0.2.0",
    "        version: https://codeload.github.com/example-org/kit/tar.gz/bbbb(react@19.0.0)",
    "      sample-charts:",
    "        specifier: ^1.0.0",
    "        version: 1.4.2(react@19.0.0)",
    "",
    "packages:",
    "",
    "  '@example/kit@https://codeload.github.com/example-org/kit/tar.gz/aaaa':",
    "    resolution: {tarball: https://codeload.github.com/example-org/kit/tar.gz/aaaa}",
    "    version: 0.3.0",
    "",
    "  '@example/kit@https://codeload.github.com/example-org/kit/tar.gz/bbbb':",
    "    version: 0.2.0",
  ].join("\n");
  const names = ["@example/kit", "sample-charts", "absent"];
  assert.deepEqual(pnpmLockVersions(lock, "", "apps/web", names), {
    "@example/kit": "v0.2.0",
    "sample-charts": "v1.4.2",
  });
  assert.deepEqual(pnpmLockVersions(lock, "", "", names), { "@example/kit": "v0.3.0" });
});

test("npm: a workspace's own copy wins over the hoisted one", () => {
  const lock = JSON.stringify({
    packages: {
      "node_modules/sample-charts": { version: "1.4.2" },
      "site/node_modules/sample-charts": { version: "1.3.0" },
    },
  });
  assert.deepEqual(npmLockVersions(lock, "", "site", ["sample-charts"]), {
    "sample-charts": "v1.3.0",
  });
  assert.deepEqual(npmLockVersions(lock, "", "", ["sample-charts"]), { "sample-charts": "v1.4.2" });
  assert.deepEqual(
    npmLockVersions(lock, "site", "site", ["sample-charts"]),
    { "sample-charts": "v1.4.2" },
    "a lockfile in the manifest's own folder is that folder's root",
  );
});

test("a workflow pin is the version Renovate writes beside the sha, or the ref when it is one", () => {
  const text = [
    "jobs:",
    "  ci:",
    "    uses: Example-Org/devkit/.github/workflows/ci.yml@0123456789abcdef0123456789abcdef01234567 # v0.21.0",
    "  other:",
    "    steps:",
    "      - uses: example-org/action@v2.0.0",
    "      - uses: example-org/action@main",
  ].join("\n");
  assert.deepEqual(workflowPins(text), [
    { repo: "example-org/devkit", pinned: "v0.21.0" },
    { repo: "example-org/action", pinned: "v2.0.0" },
    { repo: "example-org/action", pinned: null },
  ]);
});
