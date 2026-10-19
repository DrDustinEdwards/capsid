#!/usr/bin/env node
// Derive the off-account backup mirror's key, the repo secret BACKUP_CREDENTIAL_KEY.
//
// The Worker holds ONE root secret, IMPROVE_SCORE_SECRET, and derives the key that signs
// requests to /backup/credential from it under its own context string. The mirror repo
// and the restore rehearsal hold only the derived key.
//
// The derivation has to be reproducible outside the Worker to set that secret up. It is
// the same computation as deriveBackupCredentialKey in src/signed-requests.ts:
// HMAC-SHA256(root, "capsid-backup-credential:v1"). test/backup-credential.test.ts runs
// this script and compares the key with the Worker's.
//
// USAGE. The root secret comes from the environment, never from an argument: an argument
// lands in the shell history and in the process list.
//
//   IMPROVE_SCORE_SECRET=... node scripts/derive-backup-key.mjs \
//     | gh secret set BACKUP_CREDENTIAL_KEY --repo DrDustinEdwards/capsid-backups
//
// It prints the derived key and nothing else, so it can be piped. It never prints the
// root secret. Everything explanatory goes to stderr. The old --backup-credential flag is
// accepted and changes nothing.

import { createHmac } from "node:crypto";

// A whitespace-only value counts as unset: it would derive a key from spaces that no
// request ever verifies against. The value itself is used as given, not trimmed, so a
// key derived here matches the Worker's for the same secret.
const rawRoot = process.env.IMPROVE_SCORE_SECRET;
const root = rawRoot && rawRoot.trim() !== "" ? rawRoot : undefined;

const arg = process.argv[2];
if (arg !== undefined && arg !== "--backup-credential") {
  console.error(`derive-backup-key: unknown argument '${arg}'. Usage: IMPROVE_SCORE_SECRET=... node scripts/derive-backup-key.mjs`);
  process.exit(1);
}
if (!root) {
  console.error(
    "derive-backup-key: IMPROVE_SCORE_SECRET is not set in the environment.\n" +
      "  There is no way to read a Worker secret back. If you do not have the value, generate a new one,\n" +
      "  set it with `npx wrangler secret put IMPROVE_SCORE_SECRET`, and re-derive this key from it."
  );
  process.exit(1);
}

const backupKey = createHmac("sha256", root).update("capsid-backup-credential:v1").digest("hex");
console.error("derive-backup-key: derived the backup credential key. Set it as the repo secret BACKUP_CREDENTIAL_KEY");
console.error("derive-backup-key: on DrDustinEdwards/capsid-backups (the mirror) and DrDustinEdwards/capsid (the restore rehearsal).");
process.stdout.write(`${backupKey}\n`);
