import assert from "node:assert/strict";
import { test } from "node:test";
import { noBloatJobs, npmLockVersions, pnpmLockVersions, workflowPins } from "../src/lockfiles.ts";

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

test("a workflow pin is its repo and ref as written, in any YAML spelling, never the comment beside it", () => {
  const text = [
    "jobs:",
    "  ci:",
    "    uses: Example-Org/devkit/.github/workflows/ci.yml@0123456789abcdef0123456789abcdef01234567 # v0.21.0",
    "  other:",
    "    steps:",
    "      - uses: example-org/action@v2.0.0",
    "      - { uses: 'example-org/action@main' }",
  ].join("\r\n");
  assert.deepEqual(workflowPins(text), [
    { repo: "example-org/devkit", ref: "0123456789abcdef0123456789abcdef01234567" },
    { repo: "example-org/action", ref: "v2.0.0" },
    { repo: "example-org/action", ref: "main" },
  ]);
});

test("a no-bloat caller is off when an input, an if, a job it needs or its triggers turn it off, in any YAML spelling", () => {
  const pin = `DrDustinEdwards/devkit/.github/workflows/pr.yml@${"a".repeat(40)} # v1.0.0`;
  const wf = (
    jobs: string,
    on = "on:\n  pull_request:\n    types: [opened, synchronize, reopened]\n",
  ) => `${on}jobs:\n${jobs}`;
  const off = (text: string) => noBloatJobs(text).map((j) => j.off);
  // On: plain, CRLF, and no-bloat.yml on a schedule (a private repository's weekly run).
  assert.deepEqual(off(wf(`  on:\n    uses: ${pin}\n    with:\n      review: false\n`)), [null]);
  assert.deepEqual(off(wf(`  on:\n    uses: ${pin}\n`).replace(/\n/g, "\r\n")), [null]);
  assert.deepEqual(
    noBloatJobs(
      wf(
        `  weekly:\n    uses: ${pin.replace("pr.yml", "no-bloat.yml")}\n`,
        "on:\n  schedule:\n    - cron: '0 6 * * 1'\n",
      ),
    ),
    [{ job: "weekly", workflow: "no-bloat", off: null }],
  );
  for (const [jobs, why, on] of [
    [
      `  c:\n    uses: ${pin}\n    with: { review: false, no-bloat: false }\n`,
      /passes no-bloat: false/,
    ],
    [
      `  c:\n    uses: ${pin}\n    with:\n      "No-Bloat": false # private\n`,
      /passes no-bloat: false/,
    ],
    [
      `  c:\n    uses: ${pin}\n    with: &w\n      node: \${{ false }}\n`,
      /passes node: \$\{\{ false \}\}/,
    ],
    [`  c:\n    if: false\n    uses: ${pin}\n`, /runs only if false/],
    [
      `  gate:\n    if: false\n    runs-on: x\n    steps: [{ run: echo }]\n  c:\n    needs: gate\n    uses: ${pin}\n`,
      /waits for "gate", which runs only if false/,
    ],
    [
      `  c:\n    uses: ${pin}\n`,
      /filters paths-ignore/,
      "on:\n  pull_request:\n    paths-ignore: ['**']\n",
    ],
    [
      `  c:\n    uses: ${pin}\n`,
      /runs only on \["closed"\]/,
      "on:\n  pull_request:\n    types: [closed]\n",
    ],
    [`  c:\n    uses: ${pin}\n`, /does not run on pull requests/, "on: push\n"],
    [`  c:\n    uses: ${pin}\n  c:\n    uses: ${pin}\n`, /does not parse as YAML/],
  ] as Array<[string, RegExp, string?]>)
    assert.match(String(off(wf(jobs, on))), why);
});
