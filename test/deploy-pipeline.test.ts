import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// Deploy pipeline wiring that no node test can execute (a workflow, docs, and the
// cron entry point, which pulls cloudflare:workers), asserted as text so an edit that
// drops one goes red. The behavioural pieces are in health.test.ts and backup.test.ts.

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("the deploy job refuses to ship against an unapplied migration", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /wrangler d1 migrations list capsid --remote/, "the migration-drift guard is gone");
  assert.match(ci, /No migrations to apply/, "the guard no longer keys on wrangler's confirmation string");
  // The guard must sit in the deploy job before the deploy step, or it shipped
  // first and guarded nothing.
  const listAt = ci.indexOf("migrations list capsid");
  const deployAt = ci.indexOf("npm run deploy");
  assert.ok(listAt > 0 && deployAt > 0 && listAt < deployAt, "the migration check runs after the deploy");
});

test("the scheduled live gate asserts the live sha equals master head", () => {
  const ci = read(".github/workflows/ci.yml");
  // EXPECT_SHA is set on a schedule run too, so the scheduled gate catches drift
  // between master and the deployed sha.
  const expectLine = ci.split("\n").find((l) => l.includes("EXPECT_SHA:")) ?? "";
  assert.match(expectLine, /github\.event_name == 'schedule'/, "the scheduled run no longer asserts the deployed sha");
  assert.match(expectLine, /github\.sha/);
});

// scanner-rule: conventions-verification, enumerate every site. src/index.ts cannot load under node --test
test("both improve crons rethrow after logging, like the backup cron", () => {
  const idx = read("src/index.ts");
  // BACKUP_CRON_THREW is the known-true case that proves this matcher is not
  // vacuously passing.
  for (const marker of ["BACKUP_CRON_THREW", "IMPROVE_OPEN_THREW", "IMPROVE_TICK_THREW"]) {
    const from = idx.indexOf(marker);
    assert.ok(from > 0, `${marker} is missing`);
    // From the log marker to the end of its catch arrow (the first `})` after it).
    const segment = idx.slice(from, from + idx.slice(from).indexOf("})"));
    assert.match(segment, /throw err/, `${marker} logs but does not rethrow, so a failed invocation reports clean`);
  }
});

// rollback on a failed gate

test("the live job rolls back when a gate fails on a run that deployed", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /wrangler@[\d.]+ rollback/, "the live job has no rollback step");
  // Guarded to this run's own deploy. On a scheduled run a red gate usually means the
  // live sha is behind master, and rolling back would move it further away.
  const step = ci.slice(ci.indexOf("Roll back"), ci.indexOf("Reap this run's probe client"));
  assert.match(step, /failure\(\)/, "the rollback step is not conditioned on a failure");
  assert.match(step, /needs\.deploy\.result == 'success'/, "the rollback runs on runs that did not deploy");
  // Both shas, so the rollback can be checked afterwards.
  assert.match(step, /ROLLBACK_FROM|before/i, "the rollback does not report the sha it rolled back from");
  assert.match(step, /ROLLBACK_TO|after/i, "the rollback does not report the sha now live");
});

test("the rollback pins the same wrangler version the deploy uses", () => {
  const ci = read(".github/workflows/ci.yml");
  const pkg = JSON.parse(read("package.json")) as { devDependencies?: Record<string, string> };
  const pinned = pkg.devDependencies?.wrangler;
  assert.ok(pinned, "wrangler is no longer a pinned devDependency");
  // The live job runs without npm ci, so an unpinned npx wrangler would float to
  // latest.
  assert.match(ci, new RegExp(`wrangler@${pinned.replace(/\./g, "\.")} rollback`), `the rollback does not pin wrangler ${pinned}`);
});
