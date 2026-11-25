#!/usr/bin/env node
// Derive the off-account backup mirror's key (repo secret BACKUP_CREDENTIAL_KEY): HMAC-SHA256(IMPROVE_SCORE_SECRET, "capsid-backup-credential:v1"),
// the same as deriveBackupCredentialKey in src/signed-requests.ts (test/backup-credential.test.ts compares them).
// The root secret comes from the environment, never an argument (shell history, process list):
//   IMPROVE_SCORE_SECRET=... node scripts/derive-backup-key.mjs \
//     | gh secret set BACKUP_CREDENTIAL_KEY --repo DrDustinEdwards/capsid-backups
// Prints only the derived key, so it can be piped; explanations go to stderr.

import { createHmac } from "node:crypto";

// Whitespace-only counts as unset (it would derive a key nothing verifies). The value is used untrimmed so the key matches the Worker's.
const rawRoot = process.env.IMPROVE_SCORE_SECRET;
const root = rawRoot && rawRoot.trim() !== "" ? rawRoot : undefined;

const arg = process.argv[2];
if (arg !== undefined) {
  console.error(
    `derive-backup-key: unknown argument '${arg}'. Usage: IMPROVE_SCORE_SECRET=... node scripts/derive-backup-key.mjs`,
  );
  process.exit(1);
}
if (!root) {
  console.error(
    "derive-backup-key: IMPROVE_SCORE_SECRET is not set in the environment.\n" +
      "  There is no way to read a Worker secret back. If you do not have the value, generate a new one,\n" +
      "  set it with `npx wrangler secret put IMPROVE_SCORE_SECRET`, and re-derive this key from it.",
  );
  process.exit(1);
}

const backupKey = createHmac("sha256", root).update("capsid-backup-credential:v1").digest("hex");
console.error(
  "derive-backup-key: derived the backup credential key. Set it as the repo secret BACKUP_CREDENTIAL_KEY",
);
console.error(
  "derive-backup-key: on DrDustinEdwards/capsid-backups (the mirror) and DrDustinEdwards/capsid (the restore rehearsal).",
);
process.stdout.write(`${backupKey}\n`);
