#!/usr/bin/env node
// Makes the VAPID key that signs phone alerts (site-runtime ./web-push) and sets it as the Worker secret VAPID_PRIVATE_KEY without printing it (CLAUDE.md, public repo rule).
// Run once by the seat from the repo root with wrangler signed in: node scripts/vapid-keys.mjs
// The Worker is named (--name capsid-mcp) because the seat's clones hold no wrangler.jsonc; npx runs through the shell on Windows (npx.cmd).
// Rerunning replaces the key and every device must turn alerts on again, since a subscription is bound to its key. Prints only the public half.

import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";

const pair = /** @type {CryptoKeyPair} */ (
  await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])
);
const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
const secret = JSON.stringify({ kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y });
const raw = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));

const put = spawnSync(
  "npx",
  ["wrangler", "secret", "put", "VAPID_PRIVATE_KEY", "--name", "capsid-mcp"],
  {
    input: secret,
    stdio: ["pipe", "inherit", "inherit"],
    shell: process.platform === "win32",
  },
);
if (put.status !== 0) {
  console.error(
    `wrangler secret put VAPID_PRIVATE_KEY exited ${put.status}; nothing was stored. The key was not printed and is gone; run this again.`,
  );
  process.exit(1);
}
console.log(
  `VAPID_PRIVATE_KEY is set. Its public key, which the Portal hands each browser: ${Buffer.from(raw).toString("base64url")}`,
);
