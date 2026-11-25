import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// Asserted as text because no node test can execute a workflow, docs or the cron entry point
// (it pulls cloudflare:workers).

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function deployJob(ci: string): string {
  return ci.slice(ci.indexOf("  deploy:"), ci.indexOf("  scheduled-live:"));
}

test("the pre-deploy guard rebuilds the config, applies the migrations that only add, then builds the Portal", () => {
  // devkit-migrations --apply applies additive migrations and refuses the rest, and the shared
  // workflow deploys after it, so the Worker never ships against a database without its tables.
  const deploy = deployJob(read(".github/workflows/ci.yml"));
  const config = deploy.indexOf("node scripts/ci-config.mjs");
  const apply = deploy.indexOf("npx devkit-migrations migrations --apply capsid");
  const build = deploy.indexOf("npm run build:dashboard");
  assert.ok(config > 0 && apply > config && build > apply, "the pre-deploy guard is out of order");
  assert.match(deploy, /cd dashboard && node .*deploy-install\.mjs/, "the Portal is not installed");
});

test("the deploy's live gate makes gate 8's MCP call with the probe key", () => {
  // Without it gate 8 skips, and a deploy that breaks the connection after sign-in is not rolled back.
  const deploy = deployJob(read(".github/workflows/ci.yml"));
  assert.match(deploy, /VERIFY_TOKEN: \$\{\{ secrets\.CAPSID_LIVE_PROBE_KEY \}\}/);
  assert.match(deploy, /CAPSID_LIVE_PROBE_KEY="\$VERIFY_TOKEN" node scripts\/verify-live\.mjs/);
  // An install that fails is could-not-run, not a refusal that rolls a good deploy back.
  assert.match(deploy, /npm ci --ignore-scripts --no-audit --no-fund \|\| exit 3;/);
});

test("the scheduled check asserts the live sha equals master head, after any push deploy in flight", () => {
  const ci = read(".github/workflows/ci.yml");
  const scheduled = ci.slice(ci.indexOf("  scheduled-live:"));
  // The head is read after the wait step, or the check races a push run still deploying.
  assert.match(scheduled, /EXPECT_SHA: \$\{\{ steps\.head\.outputs\.sha \}\}/);
  const waitAt = scheduled.indexOf("name: Wait for a push deploy still running");
  assert.ok(
    waitAt > 0 && waitAt < scheduled.indexOf("name: verify:live"),
    "the scheduled check no longer waits for a push deploy in flight",
  );
});

// scanner-rule: conventions-verification, enumerate every site. src/index.ts cannot load under node --test
test("every cron branch rethrows after logging, so a failed invocation reports failed", () => {
  const idx = read("src/index.ts");
  // Each branch runs through runTask (src/task-runs.ts), which logs the throw with its tag and
  // rethrows only when told to; nightly jobs go through runCapsidJob, which the cron calls with rethrow.
  assert.match(idx, /runCapsidJob\(env, job, true\)/, "the nightly jobs do not rethrow");
  for (const marker of ["TICK_THREW"]) {
    assert.match(
      idx,
      new RegExp(`tag: "${marker}",\\s+rethrow: true`),
      `${marker} logs but does not rethrow, so a failed invocation reports clean`,
    );
  }
});

// The Watch Floor app (dashboard/) is its own package outside every root gate, so CI has to
// name its typecheck, build and size budget.
test("CI typechecks, builds and budgets the dashboard", () => {
  const ci = read(".github/workflows/ci.yml");
  const checks = ci.slice(ci.indexOf("  checks:"), ci.indexOf("  deploy:"));
  assert.match(
    checks,
    /npm ci --prefix dashboard/,
    "the checks job does not install the dashboard",
  );
  assert.match(
    checks,
    /npm run check:dashboard \|\| status=1/,
    "the checks job does not typecheck the dashboard",
  );
  assert.match(
    checks,
    /run: npm run build:dashboard/,
    "the checks job does not build the dashboard and hold its size budget",
  );
  // Guards a regression: dashboard's "size" script was removed while the deploy kept calling it,
  // so every master deploy failed with "Missing script".
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.match(
    pkg.scripts["build:dashboard"] ?? "",
    /run build && npm run size:dashboard/,
    "build:dashboard no longer runs the size budget after the build",
  );
  assert.ok(
    pkg.scripts["size:dashboard"],
    "build:dashboard runs a size:dashboard script the root does not have",
  );
});
