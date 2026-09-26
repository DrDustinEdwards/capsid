import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  deriveBackupCredentialKey,
  deriveScoreKey,
  mintBackupCredential,
  parseBackupCredentialRequest,
  verifyBackupCredentialRequest,
} from "../src/improve-scorer.ts";
import { ROSTER } from "../src/improve-schema.ts";
import { fakeEnv, withFetch } from "./fakes.ts";
import { sourceFiles } from "./source-files.ts";

// The off-account backup credential. The mirror job in the
// private capsid-backups repo holds no long-lived R2 secret: it signs a request
// with a backup-specific derived key and receives a one-hour object-read-only
// credential scoped to backups/json/ on capsid-media. Same envelope as the
// holdout credential, different key, different bucket, different parent token.

test("the backup credential key derives from the root with its own context, unequal to every score key", async () => {
  const root = "root-secret";
  const backup = await deriveBackupCredentialKey(root);
  assert.match(backup, /^[0-9a-f]{64}$/);
  assert.equal(backup, await deriveBackupCredentialKey(root), "derivation must be deterministic");
  assert.ok(ROSTER.length > 0, "the roster is empty, so no score key was compared");
  for (const namespace of ROSTER) {
    assert.notEqual(backup, await deriveScoreKey(root, namespace), `the backup key collides with the ${namespace} score key`);
  }
});

test("the mint asks for object-read-only, one hour, backups/json/ on capsid-media, from the BACKUP parent", async () => {
  await withFetch(
    {
      "POST /client/v4/accounts/acct-1/r2/temp-access-credentials": (body: unknown) => {
        const request = body as Record<string, unknown>;
        assert.equal(request.bucket, "capsid-media");
        assert.equal(request.permission, "object-read-only");
        assert.equal(request.ttlSeconds, 3600);
        assert.equal(request.parentAccessKeyId, "backup-parent-key-id");
        assert.deepEqual(request.prefixes, ["backups/json/"]);
        return { body: { success: true, result: { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" } } };
      },
    },
    async () => {
      const env = fakeEnv({
        R2_TEMP_CRED_TOKEN: "cf-api-token",
        R2_BACKUP_PARENT_ACCESS_KEY_ID: "backup-parent-key-id",
        R2_ACCOUNT_ID: "acct-1",
      });
      const minted = await mintBackupCredential(env);
      assert.ok(minted.ok, `mint refused: ${minted.ok ? "" : minted.refusal}`);
      assert.equal(minted.credential.bucket, "capsid-media");
      assert.equal(minted.credential.prefix, "backups/json/");
      assert.equal(minted.credential.endpoint, "https://acct-1.r2.cloudflarestorage.com");
      assert.equal(minted.credential.session_token, "ST");
    }
  );
});

test("an unconfigured backup mint is a clear 503 naming R2_BACKUP_PARENT_ACCESS_KEY_ID", async () => {
  await withFetch({}, async (calls) => {
    const minted = await mintBackupCredential(fakeEnv({ R2_TEMP_CRED_TOKEN: "t", R2_ACCOUNT_ID: "a" }));
    assert.equal(minted.ok, false);
    assert.equal(minted.ok ? 0 : minted.status, 503);
    assert.match(minted.ok ? "" : minted.refusal, /R2_BACKUP_PARENT_ACCESS_KEY_ID/);
    assert.equal(calls.length, 0);
  });
});

test("verification refuses a bad signature and admits a good one", async () => {
  const env = fakeEnv({ IMPROVE_SCORE_SECRET: "root-secret" });
  const now = new Date("2026-09-07T06:00:00Z");
  const timestamp = "2026-09-07T05:59:00Z";
  const body = JSON.stringify({ jti: "0123456789" });
  const key = await deriveBackupCredentialKey("root-secret");
  const { createHmac } = await import("node:crypto");
  const good = createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");

  const bad = await verifyBackupCredentialRequest(env, { timestamp, signature: "0".repeat(64), body }, now);
  assert.equal(bad.ok, false);

  const ok = await verifyBackupCredentialRequest(env, { timestamp, signature: good, body }, now);
  assert.equal(ok.ok, true, `a correctly signed request was refused: ${ok.ok ? "" : ok.refusal}`);

  // A ROSTER key must not open the backup endpoint: the derivation contexts differ.
  const scoreKey = await deriveScoreKey("root-secret", "capsid");
  const cross = createHmac("sha256", scoreKey).update(`${timestamp}.${body}`).digest("hex");
  const refused = await verifyBackupCredentialRequest(env, { timestamp, signature: cross, body }, now);
  assert.equal(refused.ok, false, "a namespace score key signed its way into the backup credential");
});

test("a stale timestamp is refused in both directions", async () => {
  const env = fakeEnv({ IMPROVE_SCORE_SECRET: "root-secret" });
  const now = new Date("2026-09-07T06:00:00Z");
  const body = JSON.stringify({ jti: "0123456789" });
  const key = await deriveBackupCredentialKey("root-secret");
  const { createHmac } = await import("node:crypto");
  for (const timestamp of ["2026-09-07T04:00:00Z", "2026-09-07T08:00:00Z"]) {
    const sig = createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");
    const verdict = await verifyBackupCredentialRequest(env, { timestamp, signature: sig, body }, now);
    assert.equal(verdict.ok, false, `timestamp ${timestamp} was admitted against now=${now.toISOString()}`);
  }
});

test("the request body must carry a jti", () => {
  assert.equal(parseBackupCredentialRequest("not json").ok, false);
  assert.equal(parseBackupCredentialRequest(JSON.stringify({})).ok, false);
  assert.equal(parseBackupCredentialRequest(JSON.stringify({ jti: "short" })).ok, false);
  const good = parseBackupCredentialRequest(JSON.stringify({ jti: "0123456789" }));
  assert.ok(good.ok && good.jti === "0123456789");
});

// The refusal each signed endpoint returns is checked against the real Worker in
// test-integration/signed-endpoints.test.ts.

// scanner-rule: CLAUDE.md, improve loop rule, applied to the backup parent key, the same way it
// limits HOLDOUT. Only the scorer and the env declaration may name it.
test("ONLY src/improve-scorer.ts names the backup parent key id", () => {
  const offenders = sourceFiles()
    .filter((f) => f.name !== "improve-scorer.ts" && f.name !== "env.ts")
    .flatMap((f) =>
      f.text
        .split("\n")
        .map((line, i) => ({ file: f.name, line: i + 1, text: line.trim() }))
        .filter((l) => !l.text.startsWith("//") && l.text.includes("R2_BACKUP_PARENT_ACCESS_KEY_ID"))
    );
  assert.deepEqual(offenders.map((o) => `src/${o.file}:${o.line}`), []);
});

test("the derive script's --backup-credential key is exactly the key the Worker verifies", async () => {
  // The script is a plain .mjs that restates the derivation, so the two are compared
  // by running it, as test/improve-derive-key.test.ts does for the score keys.
  const root = "a-test-root-secret";
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "improve-derive-key.mjs");
  const result = spawnSync(process.execPath, [script, "--backup-credential"], {
    encoding: "utf8",
    env: { ...process.env, IMPROVE_SCORE_SECRET: root },
  });
  assert.equal(result.status, 0, `the script refused the flag: ${result.stderr}`);
  assert.equal(result.stdout, `${await deriveBackupCredentialKey(root)}\n`, "the script and src/improve-scorer.ts derive different backup keys");
});
