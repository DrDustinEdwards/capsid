import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// scripts/reap-probe-clients.mjs reads the probe client id from PROBE_CLIENT_FILE.
// Only an ABSENT file means gate 2 registered nothing. A file that exists and cannot
// be read used to be treated the same way: "Nothing to delete", exit 0, and a probe
// client left in the OAuth keyspace with nothing saying so.

const SCRIPT = join(import.meta.dirname, "..", "scripts", "reap-probe-clients.mjs");

function reap(file: string) {
  // No Cloudflare credentials: both cases must stop before any request is made.
  const env = { ...process.env, PROBE_CLIENT_FILE: file, CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "" };
  return spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env });
}

test("an absent probe-client file is nothing to delete, and an unreadable one is a failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "reap-"));
  try {
    const absent = reap(join(dir, "missing.txt"));
    assert.equal(absent.status, 0);
    assert.match(absent.stdout, /Nothing to delete/);

    // A directory exists and cannot be read as a file (EISDIR).
    const unreadable = reap(dir);
    assert.equal(unreadable.status, 1, `exit ${unreadable.status}: ${unreadable.stdout}${unreadable.stderr}`);
    assert.match(unreadable.stderr, /could not read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
