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
import { deriveTaskKey } from "../src/signed-docs.ts";
import {
  OFFACCOUNT_AUDIT_SOURCES,
  OFFACCOUNT_AUDITS,
  OFFACCOUNT_SITES,
  OFFACCOUNT_SOURCES,
} from "../src/offaccount.ts";
// @ts-expect-error scripts/ is plain .mjs with no declarations (see test/canary.test.ts).
import { R2 } from "../scripts/bindings.mjs";
import { fakeEnv, withFetch } from "./fakes.ts";
import { sourceFiles } from "./source-files.ts";

// The off-account backup credential. The Amazon copy job in the
// private capsid-backups repo holds no long-lived R2 secret: it signs a request
// with a backup-specific derived key and receives a one-hour object-read-only
// credential scoped to backups/json/ on capsid-media, from its own parent token.

test("verification refuses a bad signature and admits a good one", async () => {
  const env = fakeEnv({ IMPROVE_SCORE_SECRET: "root-secret" });
  const now = new Date("2026-09-07T06:00:00Z");
  const timestamp = "2026-09-07T05:59:00Z";
  const body = JSON.stringify({ jti: "0123456789" });
  const key = await deriveBackupCredentialKey("root-secret");
  const { createHmac } = await import("node:crypto");
  const good = createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");

  const bad = await verifyBackupCredentialRequest(
    env,
    { timestamp, signature: "0".repeat(64), body },
    now,
  );
  assert.equal(bad.ok, false);

  const ok = await verifyBackupCredentialRequest(env, { timestamp, signature: good, body }, now);
  assert.equal(ok.ok, true, `a correctly signed request was refused: ${ok.ok ? "" : ok.refusal}`);

  // The signed-document key must not open the backup endpoint: the derivation contexts differ.
  const taskKey = await deriveTaskKey("root-secret");
  const cross = createHmac("sha256", taskKey).update(`${timestamp}.${body}`).digest("hex");
  const refused = await verifyBackupCredentialRequest(
    env,
    { timestamp, signature: cross, body },
    now,
  );
  assert.equal(
    refused.ok,
    false,
    "the signed-document key signed its way into the backup credential",
  );
});

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

test("the request body must carry a jti", () => {
  assert.equal(parseBackupCredentialRequest("not json").ok, false);
  assert.equal(parseBackupCredentialRequest(JSON.stringify({})).ok, false);
  assert.equal(parseBackupCredentialRequest(JSON.stringify({ jti: "short" })).ok, false);
  const good = parseBackupCredentialRequest(JSON.stringify({ jti: "0123456789" }));
  assert.ok(good.ok && good.jti === "0123456789");
});

// The site field (capsid/rulings/backups-offaccount-2026-10-10.md): one endpoint mints
// for every pinned site, and the bucket comes from src/offaccount.ts, never the body.

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

test("capsid's backup bucket is the MEDIA pin, and no two sites share a backup bucket", () => {
  assert.equal(
    OFFACCOUNT_SOURCES.capsid.bucket,
    R2.name,
    "capsid's backup bucket drifted from the MEDIA pin in scripts/bindings.mjs",
  );
  const buckets = OFFACCOUNT_SITES.map((site) => OFFACCOUNT_SOURCES[site].bucket);
  assert.equal(new Set(buckets).size, buckets.length, "two sites share a backup bucket");
});

test("a request with no site is capsid's, and a pinned site in the body is read through", () => {
  const none = parseBackupCredentialRequest(JSON.stringify({ jti: "0123456789" }));
  assert.ok(none.ok);
  assert.equal(none.site, "capsid");
  for (const site of OFFACCOUNT_SITES) {
    const parsed = parseBackupCredentialRequest(JSON.stringify({ jti: "0123456789", site }));
    assert.ok(parsed.ok, `${site} was refused`);
    assert.equal(parsed.site, site);
  }
});

test("an unknown, empty, inherited or non-string site is refused, naming the sites", () => {
  for (const site of [
    "dustinedwards-backups",
    "sample",
    "CAPSID",
    "",
    "constructor",
    "__proto__",
    "toString",
    5,
    null,
    ["capsid"],
    { bucket: "capsid-media" },
  ]) {
    const parsed = parseBackupCredentialRequest(JSON.stringify({ jti: "0123456789", site }));
    assert.equal(parsed.ok, false, `site ${JSON.stringify(site)} was admitted`);
    assert.equal(
      parsed.ok ? "" : parsed.refusal,
      "the credential request names no known site; the sites are capsid, germomics, txasm, foxing, foxhound, dustinedwards, julieedwards, carrel, bsw",
    );
  }
});

test("a body cannot name its own bucket or prefix: only site picks the scope", () => {
  const parsed = parseBackupCredentialRequest(
    JSON.stringify({ jti: "0123456789", site: "foxing", bucket: "capsid-media", prefix: "" }),
  );
  assert.ok(parsed.ok);
  assert.deepEqual(Object.keys(parsed).sort(), ["jti", "ok", "site"]);
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

// The refusal each signed endpoint returns is checked against the real Worker in
// test-integration/signed-endpoints.test.ts.

// scanner-rule: the backup parent key has one reader. Only the minting module and the env
// declaration may name it.
test("ONLY src/signed-requests.ts names the backup parent key id", () => {
  const offenders = sourceFiles()
    .filter((f) => f.name !== "signed-requests.ts" && f.name !== "env.ts")
    .flatMap((f) =>
      f.text
        .split("\n")
        .map((line, i) => ({ file: f.name, line: i + 1, text: line.trim() }))
        .filter(
          (l) => !l.text.startsWith("//") && l.text.includes("R2_BACKUP_PARENT_ACCESS_KEY_ID"),
        ),
    );
  assert.deepEqual(
    offenders.map((o) => `src/${o.file}:${o.line}`),
    [],
  );
});

const DERIVE_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "derive-backup-key.mjs",
);

test("the derive script's key is exactly the key the Worker verifies", async () => {
  // The script is a plain .mjs that restates the derivation, so the two are compared
  // by running it.
  const root = "a-test-root-secret";
  const result = spawnSync(process.execPath, [DERIVE_SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, IMPROVE_SCORE_SECRET: root },
  });
  assert.equal(result.status, 0, `the script refused: ${result.stderr}`);
  assert.equal(
    result.stdout,
    `${await deriveBackupCredentialKey(root)}\n`,
    "the script and src/signed-requests.ts derive different backup keys",
  );
  assert.ok(
    !result.stdout.includes(root) && !result.stderr.includes(root),
    "the script printed the root secret",
  );
});

test("the derive script refuses a missing or blank root secret and an unknown argument", () => {
  for (const value of [undefined, "   "]) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.IMPROVE_SCORE_SECRET;
    if (value !== undefined) env.IMPROVE_SCORE_SECRET = value;
    const result = spawnSync(process.execPath, [DERIVE_SCRIPT], { encoding: "utf8", env });
    assert.notEqual(result.status, 0, `a root secret of ${JSON.stringify(value)} was accepted`);
    assert.equal(result.stdout, "");
  }
  const unknown = spawnSync(process.execPath, [DERIVE_SCRIPT, "capsid"], {
    encoding: "utf8",
    env: { ...process.env, IMPROVE_SCORE_SECRET: "x" },
  });
  assert.notEqual(unknown.status, 0);
  assert.equal(unknown.stdout, "");
});
