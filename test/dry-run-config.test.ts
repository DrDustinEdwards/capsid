import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// scripts/dry-run-config.mjs builds a config for the scorer's `wrangler deploy
// --dry-run`. It used to write wrangler.jsonc, the file a deploy reads, so running it
// on a machine with the real (gitignored) config replaced that config with the
// example plus pins, with no backup. It now writes wrangler.dryrun.jsonc.

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "dry-run-config.mjs");

test("it writes wrangler.dryrun.jsonc and leaves an existing wrangler.jsonc alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "dry-run-config-"));
  try {
    copyFileSync(join(ROOT, "wrangler.jsonc.example"), join(dir, "wrangler.jsonc.example"));
    const real = '{ "name": "the real config, which must survive" }';
    writeFileSync(join(dir, "wrangler.jsonc"), real);

    const run = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);

    assert.equal(readFileSync(join(dir, "wrangler.jsonc"), "utf8"), real, "the real wrangler.jsonc was overwritten");
    assert.ok(existsSync(join(dir, "wrangler.dryrun.jsonc")), "wrangler.dryrun.jsonc was not written");
    assert.doesNotMatch(readFileSync(join(dir, "wrangler.dryrun.jsonc"), "utf8"), /YOUR_[A-Z0-9_]+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the scorer's dry run names the file the script writes", () => {
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "improve-score.yml"), "utf8");
  assert.match(workflow, /wrangler deploy --dry-run --config wrangler\.dryrun\.jsonc/, "the dry run would read wrangler.jsonc, which nothing writes on the runner");
});

// The Capsid Portal app's assets block (wrangler.jsonc.example). run_worker_first true is
// what keeps a browser's /authorize and /console/callback navigations reaching the
// Worker; not_found_handling "none" leaves the single-page fallback to the Worker, after
// the console gate.
test("the example serves the dashboard with every request reaching the Worker first", () => {
  const example = readFileSync(join(ROOT, "wrangler.jsonc.example"), "utf8");
  const line = example.split("\n").find((l) => l.trim().startsWith('"assets"'));
  assert.ok(line, "wrangler.jsonc.example has no assets block");
  const assets = JSON.parse(line.trim().replace(/^"assets":\s*/, "").replace(/,$/, "")) as Record<string, unknown>;
  assert.equal(assets.run_worker_first, true, "run_worker_first must be true, or navigations can be answered with index.html");
  assert.equal(assets.not_found_handling, "none", "the platform's single-page fallback would run before the console gate");
  assert.equal(assets.binding, "ASSETS");
  assert.equal(assets.directory, "./dashboard/dist");
});

test("the dry run drops the assets block, since the scorer builds no dashboard", () => {
  const dir = mkdtempSync(join(tmpdir(), "dry-run-config-"));
  try {
    copyFileSync(join(ROOT, "wrangler.jsonc.example"), join(dir, "wrangler.jsonc.example"));
    const run = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(readFileSync(join(dir, "wrangler.dryrun.jsonc"), "utf8"), /"assets"|ASSETS-/);

    // A missing marker fails loudly rather than keeping the block.
    writeFileSync(join(dir, "wrangler.jsonc.example"), readFileSync(join(ROOT, "wrangler.jsonc.example"), "utf8").replace("// ASSETS-END", "// gone"));
    const broken = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /ASSETS-BEGIN \/ ASSETS-END/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
