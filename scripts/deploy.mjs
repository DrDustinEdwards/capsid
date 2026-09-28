#!/usr/bin/env node
// Deploy with provenance stamped in.
//
// A Cloudflare version id carries no git sha, so this stamps one in and /health serves
// it, which makes "the deployed worker is this commit" checkable.
//
// The sha is passed as a deploy-time --var rather than written into wrangler.jsonc
// (gitignored here, so it cannot carry committed values) or into a generated source file
// (which would either dirty the tree on every deploy or break a fresh clone's
// typecheck). --var attaches it to the deployment itself.
//
// dirty=true when the tree has uncommitted changes: the deployed bytes are then NOT the
// named commit, and /health says so.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

// The Watch Floor app (dashboard/) is served from dashboard/dist as the Worker's static
// assets (wrangler.jsonc.example, "assets"). It is built and held to its size budget
// here, before every deploy, so a deploy never ships a stale or missing app. A failed
// build or budget stops the deploy. dist/ is gitignored, so building does not dirty the
// tree.
function npmRun(args) {
  const run = spawnSync("npm", args, { stdio: "inherit", shell: process.platform === "win32" });
  if (run.status !== 0) {
    console.error(`deploy: npm ${args.join(" ")} failed (exit ${run.status ?? "none"}); nothing was deployed.`);
    process.exit(run.status ?? 1);
  }
}
if (existsSync("dashboard/package.json")) {
  if (!existsSync("dashboard/node_modules")) {
    console.error("deploy: dashboard/node_modules is missing. Run `npm ci --prefix dashboard` first; nothing was deployed.");
    process.exit(1);
  }
  npmRun(["--prefix", "dashboard", "run", "build"]);
  npmRun(["--prefix", "dashboard", "run", "size"]);
}

let sha = "unknown";
let dirty = false;
try {
  sha = git(["rev-parse", "HEAD"]);
  dirty = git(["status", "--porcelain"]).length > 0;
} catch {
  // Deploying from something that is not a git checkout is allowed, but it is recorded as
  // unknown rather than guessed.
  console.warn("deploy: not a git checkout, provenance will report sha=unknown");
}

const builtAt = new Date().toISOString();
const args = [
  "wrangler",
  "deploy",
  "--var",
  `BUILD_SHA:${sha}`,
  "--var",
  `BUILD_DIRTY:${dirty ? "true" : "false"}`,
  "--var",
  `BUILT_AT:${builtAt}`,
  ...process.argv.slice(2),
];

console.log(`deploy: sha=${sha.slice(0, 8)} dirty=${dirty} builtAt=${builtAt}`);
if (dirty) {
  console.warn("deploy: WORKING TREE IS DIRTY. /health will report dirty=true; the deployed bytes are not the named commit.");
}

const result = spawnSync("npx", ["--no-install", ...args], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
