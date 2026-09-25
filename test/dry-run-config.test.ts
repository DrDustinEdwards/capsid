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
