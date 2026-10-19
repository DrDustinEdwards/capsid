import { sha256Hex } from "./auth";
import { bytesToHex } from "./encoding";
import type { Env } from "./env";
import { systemAudit } from "./doc-statements";

export interface MintedOperatorKey {
  action: "mint_operator_key";
  key: string;
  hash: string;
  // The OPERATOR_KEY_HASH line, `ro:<hash>`. The tier lives on the entry, so it is
  // the operator's decision.
  entry: string;
  grant: "read-only";
  already_listed: boolean;
  next_step: string;
  command: string;
  warning: string;
}

// capsid_admin_control_improve action mint_operator_key. Mints a read-only operator key
// and prints the command that installs its hash. It does not install it: a Worker that
// can widen its own authorization list does not have one. The key is returned once and
// stored nowhere, not even the hash in the audit row, because OPERATOR_KEY_HASH is the
// verifier; the row gets a fingerprint.
export async function mintOperatorKey(env: Env, actor: string): Promise<MintedOperatorKey> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // Hex through bytesToHex (src/encoding.ts).
  const key = `capsid_${bytesToHex(bytes)}`;
  // The `ro:` prefix goes on the list entry, not the key: src/auth.ts compares the
  // key's hash to each entry with the prefix stripped. Backwards, this mints a write key.
  const hash = await sha256Hex(key);
  const entry = `ro:${hash}`;
  const existing = (env.OPERATOR_KEY_HASH ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const alreadyListed = existing.includes(entry);
  const next = alreadyListed ? existing : [...existing, entry];
  await env.DB.batch([
    systemAudit(env.DB, "operator-key-minted", null, {
      // Tells two mints apart without being usable as a verifier.
      fingerprint: hash.slice(0, 8),
      grant: "read-only",
    }, actor),
  ]);
  return {
    action: "mint_operator_key",
    key,
    hash,
    entry,
    grant: "read-only",
    already_listed: alreadyListed,
    next_step:
      "This key does NOTHING until its hash is in OPERATOR_KEY_HASH. Run the command below from a machine with wrangler and this account. The Worker deliberately cannot do it: a Worker that can widen its own authorization list does not have one.",
    command: `npx wrangler secret put OPERATOR_KEY_HASH
# then paste, on one line:
${next.join(",")}`,
    warning:
      "The key is shown ONCE and is stored nowhere: not in KV, not in a document, and not in the audit row. Copy it now. Lose it and mint another, then remove the stale hash from the list above. Revoke by removing a hash and putting the secret again.",
  };
}
