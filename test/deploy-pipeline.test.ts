import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// Deploy pipeline wiring that no node test can execute (a workflow, docs, and the
// cron entry point, which pulls cloudflare:workers), asserted as text so an edit that
// drops one goes red. The behavioral pieces are in health.test.ts and backup.test.ts.

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("the deploy job applies the migrations that only add, before the deploy", () => {
  const ci = read(".github/workflows/ci.yml");
  // devkit-migrations --apply (devkit, tested there) applies additive migrations and refuses the rest. It must sit in
  // the deploy job before the deploy step, or the Worker shipped against a database without its tables.
  const applyAt = ci.indexOf("npx devkit-migrations migrations --apply capsid");
  const deployAt = ci.indexOf("npm run deploy");
  assert.ok(applyAt > 0, "the deploy no longer applies its migrations");
  assert.ok(deployAt > 0 && applyAt < deployAt, "the migrations are applied after the deploy");
});

test("the scheduled live gate asserts the live sha equals master head, after any push deploy in flight", () => {
  const ci = read(".github/workflows/ci.yml");
  // EXPECT_SHA is set on a schedule run too, so the scheduled gate catches drift between master and the deployed
  // sha. It is the head read after the wait step, or the gate races a push run still deploying (2026-11-01).
  const expectLine = ci.split("\n").find((l) => l.includes("EXPECT_SHA:")) ?? "";
  assert.match(expectLine, /github\.event_name == 'schedule' && steps\.head\.outputs\.sha/, "the scheduled run no longer asserts the deployed sha");
  assert.match(expectLine, /needs\.deploy\.result == 'success' && github\.sha/);
  const waitAt = ci.indexOf("name: Wait for a push deploy still running");
  assert.ok(waitAt > 0 && waitAt < ci.indexOf("name: verify:live"), "the schedule run no longer waits for a push deploy in flight");
});

// scanner-rule: conventions-verification, enumerate every site. src/index.ts cannot load under node --test
test("every cron branch rethrows after logging, so a failed invocation reports failed", () => {
  const idx = read("src/index.ts");
  // Each branch runs through runTask (src/task-runs.ts), which logs the throw with
  // its tag and rethrows it only when told to; test/task-runs.test.ts runs both.
  for (const marker of ["BACKUP_CRON_THREW", "TICK_THREW", "SKILLS_REFRESH_THREW"]) {
    assert.match(idx, new RegExp(`tag: "${marker}", rethrow: true`), `${marker} logs but does not rethrow, so a failed invocation reports clean`);
  }
});

// rollback on a failed gate

test("the live job rolls back when a gate fails on a run that deployed", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /node_modules\/\.bin\/wrangler rollback/, "the live job has no rollback step");
  // Guarded to this run's own deploy. On a scheduled run a red gate usually means the
  // live sha is behind master, and rolling back would move it further away.
  // The rollback is the job's last step since the probe-client reaper went with DCR.
  const step = ci.slice(ci.indexOf("Roll back"));
  assert.match(step, /failure\(\)/, "the rollback step is not conditioned on a failure");
  assert.match(step, /needs\.deploy\.result == 'success'/, "the rollback runs on runs that did not deploy");
  // Both shas, so the rollback can be checked afterwards.
  assert.match(step, /ROLLBACK_FROM|before/i, "the rollback does not report the sha it rolled back from");
  assert.match(step, /ROLLBACK_TO|after/i, "the rollback does not report the sha now live");
});

test("the live gate's verify step carries the probe key, so gate 8 makes its MCP call in CI", () => {
  // Without it gate 8 skips, and a deploy that breaks the connection after sign-in is
  // not rolled back (job_bb06c9be24c4). The exit-1 rollback itself is the test above.
  const ci = read(".github/workflows/ci.yml");
  const verify = ci.slice(ci.indexOf("- name: verify:live"), ci.indexOf("Roll back"));
  assert.match(verify, /CAPSID_LIVE_PROBE_KEY: \$\{\{ secrets\.CAPSID_LIVE_PROBE_KEY \}\}/);
});

test("PLANT: the rollback runs the lockfile's wrangler, installed without scripts, never npx", () => {
  // npx --yes wrangler@<pin> resolved wrangler's own dependency ranges at job time,
  // beside the deploy token (Grok audit 2026-10, U3). npm ci installs the lockfile's
  // tree, the same wrangler the deploy uses, and runs no install script.
  const ci = read(".github/workflows/ci.yml");
  const step = ci.slice(ci.indexOf("- name: Roll back the deploy this run shipped"));
  assert.doesNotMatch(step, /^\s+npx\s/m, "the rollback fetches wrangler through npx");
  const install = step.search(/npm ci --ignore-scripts/);
  const rollback = step.search(/node_modules\/\.bin\/wrangler rollback/);
  assert.ok(install > -1, "the rollback step does not install from the lockfile with scripts off");
  assert.ok(rollback > install, "the rollback does not run the wrangler that install put in node_modules");
  const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version?: string }> };
  const pkg = JSON.parse(read("package.json")) as { devDependencies?: Record<string, string> };
  assert.equal(lock.packages["node_modules/wrangler"]?.version, pkg.devDependencies?.wrangler, "the lockfile's wrangler is not the pinned one");
});

// The Watch Floor app (dashboard/) is its own package, outside every root gate, so CI
// has to name it: its typecheck against src/ops-types/, its build and size budget,
// and its install in both the checks job and the deploy job (scripts/deploy.mjs builds
// it into the Worker's assets).
test("CI typechecks, builds and budgets the dashboard, and installs it wherever it is built", () => {
  const ci = read(".github/workflows/ci.yml");
  const checks = ci.slice(ci.indexOf("  checks:"), ci.indexOf("  deploy:"));
  const deploy = ci.slice(ci.indexOf("  deploy:"), ci.indexOf("  live:"));
  assert.match(checks, /npm ci --prefix dashboard/, "the checks job does not install the dashboard");
  assert.match(checks, /npm run check:dashboard \|\| status=1/, "the checks job does not typecheck the dashboard");
  assert.match(checks, /run: npm run build:dashboard/, "the checks job does not build the dashboard and hold its size budget");
  assert.match(deploy, /npm ci --prefix dashboard/, "the deploy job does not install the dashboard that scripts/deploy.mjs builds");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["build:dashboard"] ?? "", /run build && .*run size/, "build:dashboard no longer runs the size budget after the build");
  const deployScript = read("scripts/deploy.mjs");
  assert.ok(deployScript.indexOf('"run", "size"') > deployScript.indexOf('"run", "build"') && deployScript.indexOf('"run", "size"') < deployScript.indexOf('"deploy",'), "scripts/deploy.mjs must build and budget the dashboard before wrangler deploy");
});

// The app's browser tests (dashboard/e2e) drive the BUILT app, so CI runs them after
// the build step, with a browser installed first. A Preview click that did nothing on
// the live Portal passed every other step in this job.
test("CI runs the app's browser tests after the dashboard build, with Chromium installed", () => {
  const ci = read(".github/workflows/ci.yml");
  const checks = ci.slice(ci.indexOf("  checks:"), ci.indexOf("  deploy:"));
  const build = checks.indexOf("run: npm run build:dashboard");
  const install = checks.indexOf("playwright install --with-deps chromium");
  const run = checks.indexOf("run: npm run test:browser");
  assert.ok(build > -1 && install > -1 && run > -1, "the checks job does not build the dashboard, install Chromium and run the browser tests");
  assert.ok(build < run && install < run, "the browser tests must run after the build and the browser install");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["test:browser"], "npm --prefix dashboard run e2e");
  const dash = JSON.parse(read("dashboard/package.json")) as { scripts: Record<string, string> };
  assert.equal(dash.scripts.e2e, "playwright test");
});
