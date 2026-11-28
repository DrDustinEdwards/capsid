import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "dry-run-config.mjs");
const EXAMPLE = readFileSync(join(ROOT, "wrangler.jsonc.example"), "utf8");

test("it writes wrangler.dryrun.jsonc without the assets block, leaves wrangler.jsonc alone, and fails on a lost marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "dry-run-config-"));
  try {
    copyFileSync(join(ROOT, "wrangler.jsonc.example"), join(dir, "wrangler.jsonc.example"));
    const real = '{ "name": "the real config, which must survive" }';
    writeFileSync(join(dir, "wrangler.jsonc"), real);
    const run = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(join(dir, "wrangler.jsonc"), "utf8"), real);
    assert.ok(existsSync(join(dir, "wrangler.dryrun.jsonc")));
    const dry = readFileSync(join(dir, "wrangler.dryrun.jsonc"), "utf8");
    assert.doesNotMatch(dry, /YOUR_[A-Z0-9_]+/);
    // `npm run types` builds no dashboard.
    assert.doesNotMatch(dry, /"assets"|ASSETS-/);

    writeFileSync(join(dir, "wrangler.jsonc.example"), EXAMPLE.replace("// ASSETS-END", "// gone"));
    const broken = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /ASSETS-BEGIN \/ ASSETS-END/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
