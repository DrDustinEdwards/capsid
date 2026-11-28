import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  deriveBackupCredentialKey,
  mintBackupCredential,
  parseBackupCredentialRequest,
  verifyBackupCredentialRequest,
} from "../src/signed-requests.ts";
import {
  OFFACCOUNT_AUDIT_SOURCES,
  OFFACCOUNT_AUDITS,
  OFFACCOUNT_SITES,
  OFFACCOUNT_SOURCES,
} from "../src/offaccount.ts";
import { fakeEnv, withFetch } from "./fakes.ts";

// The off-account copy job signs a request with a derived key and receives a one-hour read-only credential; the route is test-integration/signed-endpoints.

test("a stale timestamp is refused in both directions", async () => {
  const env = fakeEnv({ IMPROVE_SCORE_SECRET: "root-secret" });
  const now = new Date("2026-09-07T06:00:00Z");
  const body = JSON.stringify({ jti: "0123456789" });
  const key = await deriveBackupCredentialKey("root-secret");
  const { createHmac } = await import("node:crypto");
  for (const timestamp of ["2026-09-07T04:00:00Z", "2026-09-07T08:00:00Z"]) {
    const sig = createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");
    const verdict = await verifyBackupCredentialRequest(
      env,
      { timestamp, signature: sig, body },
      now,
    );
    assert.equal(
      verdict.ok,
      false,
      `timestamp ${timestamp} was admitted against now=${now.toISOString()}`,
    );
  }
});

test("parseBackupCredentialRequest: a jti is required, the site defaults to capsid, only a pinned site is read, and the body cannot pick the bucket", () => {
  for (const body of ["not json", JSON.stringify({}), JSON.stringify({ jti: "short" })])
    assert.equal(parseBackupCredentialRequest(body).ok, false, body);
  const none = parseBackupCredentialRequest(JSON.stringify({ jti: "0123456789" }));
  assert.ok(none.ok && none.jti === "0123456789" && none.site === "capsid");
  for (const site of OFFACCOUNT_SITES) {
    const parsed = parseBackupCredentialRequest(JSON.stringify({ jti: "0123456789", site }));
    assert.ok(parsed.ok && parsed.site === site, site);
  }
  for (const site of [
    "sample",
    "CAPSID",
    "",
    "constructor",
    "__proto__",
    5,
    null,
    ["capsid"],
    { bucket: "capsid-media" },
  ]) {
    const parsed = parseBackupCredentialRequest(JSON.stringify({ jti: "0123456789", site }));
    assert.match(
      parsed.ok ? "(admitted)" : parsed.refusal,
      /names no known site/,
      JSON.stringify(site),
    );
  }
  const scoped = parseBackupCredentialRequest(
    JSON.stringify({ jti: "0123456789", site: "foxing", bucket: "capsid-media", prefix: "" }),
  );
  assert.ok(scoped.ok);
  assert.deepEqual(Object.keys(scoped).sort(), ["jti", "ok", "site"]);
});

test("every pinned site mints object-read-only on its OWN bucket, backups/json/ and files/, and nothing else", async () => {
  const asked: string[] = [];
  await withFetch(
    {
      "POST /client/v4/accounts/acct-1/r2/temp-access-credentials": (body: unknown) => {
        const request = body as Record<string, unknown>;
        asked.push(String(request.bucket));
        assert.equal(request.permission, "object-read-only");
        assert.equal(request.ttlSeconds, 3600);
        assert.equal(request.parentAccessKeyId, "backup-parent-key-id");
        assert.deepEqual(request.prefixes, ["backups/json/", "files/"]);
        return {
          body: {
            success: true,
            result: { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" },
          },
        };
      },
    },
    async () => {
      const env = fakeEnv({
        R2_TEMP_CRED_TOKEN: "t",
        R2_BACKUP_PARENT_ACCESS_KEY_ID: "backup-parent-key-id",
        R2_ACCOUNT_ID: "acct-1",
      });
      for (const site of OFFACCOUNT_SITES) {
        const minted = await mintBackupCredential(env, site);
        assert.ok(minted.ok, `${site}: mint refused: ${minted.ok ? "" : minted.refusal}`);
        assert.equal(
          minted.credential.bucket,
          OFFACCOUNT_SOURCES[site].bucket,
          `${site} was minted on another bucket`,
        );
        assert.equal(minted.credential.prefix, "backups/json/");
        assert.equal(minted.credential.files_prefix, "files/");
      }
    },
  );
  assert.deepEqual(
    asked,
    OFFACCOUNT_SITES.map((site) => OFFACCOUNT_SOURCES[site].bucket),
  );
});

test("an audit log is minted on its own bucket and tool-calls/ alone; a body cannot name both or an unknown one", async () => {
  const asked: { bucket: unknown; prefixes: unknown }[] = [];
  await withFetch(
    {
      "POST /client/v4/accounts/acct-1/r2/temp-access-credentials": (body: unknown) => {
        const request = body as Record<string, unknown>;
        asked.push({ bucket: request.bucket, prefixes: request.prefixes });
        return {
          body: {
            success: true,
            result: { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" },
          },
        };
      },
    },
    async () => {
      const env = fakeEnv({
        R2_TEMP_CRED_TOKEN: "t",
        R2_BACKUP_PARENT_ACCESS_KEY_ID: "backup-parent-key-id",
        R2_ACCOUNT_ID: "acct-1",
      });
      for (const audit of OFFACCOUNT_AUDITS) {
        const parsed = parseBackupCredentialRequest(JSON.stringify({ jti: "0123456789", audit }));
        assert.ok(parsed.ok && parsed.audit === audit);
        const minted = await mintBackupCredential(env, undefined, audit);
        assert.ok(minted.ok);
        assert.equal(minted.credential.prefix, "tool-calls/");
      }
    },
  );
  assert.deepEqual(
    asked,
    OFFACCOUNT_AUDITS.map((audit) => ({
      bucket: OFFACCOUNT_AUDIT_SOURCES[audit],
      prefixes: ["tool-calls/"],
    })),
  );
  assert.equal(
    parseBackupCredentialRequest(
      JSON.stringify({ jti: "0123456789", audit: "capsid-mcp", site: "foxing" }),
    ).ok,
    false,
  );
  for (const audit of ["foxing", "constructor", "", 5]) {
    assert.equal(
      parseBackupCredentialRequest(JSON.stringify({ jti: "0123456789", audit })).ok,
      false,
    );
  }
});

const DERIVE_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "derive-backup-key.mjs",
);

test("the derive script prints exactly the key the Worker verifies, never the root, and refuses a missing root or an argument", async () => {
  const run = (args: string[], root: string | undefined) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.IMPROVE_SCORE_SECRET;
    if (root !== undefined) env.IMPROVE_SCORE_SECRET = root;
    return spawnSync(process.execPath, [DERIVE_SCRIPT, ...args], { encoding: "utf8", env });
  };
  const root = "a-test-root-secret";
  const good = run([], root);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout, `${await deriveBackupCredentialKey(root)}\n`);
  assert.ok(!good.stdout.includes(root) && !good.stderr.includes(root));
  for (const [args, value] of [
    [[], undefined],
    [[], "   "],
    [["capsid"], "x"],
  ] as const) {
    const refused = run([...args], value);
    assert.notEqual(refused.status, 0, JSON.stringify([args, value]));
    assert.equal(refused.stdout, "");
  }
});
