import { hmacHex } from "./auth";
import { safeEqual } from "@dustinedwards/site-runtime/compare";
import type { Env } from "./env";
import { isOffaccountSite, OFFACCOUNT_DEFAULT_SITE, OFFACCOUNT_SITES, OFFACCOUNT_SOURCES, type OffaccountSite } from "./offaccount";
import { readCapped } from "@dustinedwards/site-runtime/body";
import { MINUTE_MS } from "./time";

// The signed endpoints that are not MCP: the backup mirror's credential mint here, and
// the bench's three (src/bench.ts). Each is HMAC over timestamp and body, refused
// outside a time window and replay-protected by a jti the database claims.

// Signed with a backup-specific key derived under its own context, so the mirror job's
// key opens read access to backups/json/ on a pinned site's backup bucket
// (src/offaccount.ts) and nothing else. Not under /ops/: an /ops/ path would invite
// adding the operator-key check.
export const BACKUP_CREDENTIAL_PATH = "/backup/credential";

// A signature older than this is refused. It bounds replay to the window in which a
// request is still plausibly in flight; a CI job that takes over half an hour to POST
// its own result has a different problem.
const SIGNATURE_MAX_AGE_MS = 30 * MINUTE_MS;

// A signed request is a few hundred bytes of JSON. This is three orders of magnitude
// of headroom and still refuses a body that is trying to be something else.
export const MAX_REPORT_BYTES = 16_384;

// Reads a body from the stream and aborts once it exceeds `max` bytes, so an
// oversized body is refused before it is fully in memory or reaches the HMAC.
// request.text() would buffer it all first.
export async function readBoundedText(
  request: { body: ReadableStream<Uint8Array> | null },
  max: number
): Promise<{ ok: true; text: string } | { ok: false }> {
  // The family's one capped reader (site-runtime ./body): counted as it arrives, null over the ceiling.
  const text = await readCapped(request, max);
  return text === null ? { ok: false } : { ok: true, text };
}

// Claims a request's nonce, or refuses it. The database decides, not the code. A KV
// get-then-put has nothing atomic between its round trips, so two requests carrying one
// captured signature both read absent and both proceed, and with the signature valid 30
// minutes either side, a captured POST could be replayed for an hour. An INSERT against
// the primary key has no such window: a returned row means this call claimed the nonce.
// RETURNING, not meta.changes. Fails closed on a database error, because these endpoints
// mint credentials and record evidence. The table keeps its first name, improve_jti
// (migrations/0004), from the improve loop that first used it.
export async function claimJti(
  db: D1Database,
  scope: string,
  jti: string
): Promise<{ ok: true } | { ok: false; status: number; refusal: string }> {
  try {
    const { results } = await db
      .prepare(
        `INSERT INTO improve_jti (scope, jti) VALUES (?1, ?2)
         ON CONFLICT(scope, jti) DO NOTHING
         RETURNING jti`
      )
      .bind(scope, jti)
      .all<{ jti: string }>();
    if (results.length === 1) return { ok: true };
    return { ok: false, status: 409, refusal: "replay: this signed request (jti) was already accepted" };
  } catch (err) {
    return {
      ok: false,
      status: 503,
      refusal: `could not verify replay status (${err instanceof Error ? err.message : String(err)}); refusing the request`,
    };
  }
}

// The backup mirror's key: IMPROVE_SCORE_SECRET, the Worker's one root secret, under
// the backup's own context string, so it differs from the job and policy signing key
// (src/signed-docs.ts) by construction. The version segment is in the string so a
// rotation is a one-character change. scripts/derive-backup-key.mjs computes the same
// value to set the repo secret.
export async function deriveBackupCredentialKey(rootSecret: string): Promise<string> {
  return hmacHex(rootSecret, "capsid-backup-credential:v1");
}

// Timestamp and body joined by a dot. The timestamp is inside the signature, or an
// attacker could rewrite it to defeat the age check.
function signaturePayload(timestamp: string, body: string): string {
  return `${timestamp}.${body}`;
}

type HmacFail = { ok: false; status: number; refusal: string };

async function verifyHmac(
  env: Pick<Env, "IMPROVE_SCORE_SECRET">,
  signed: { timestamp: string; signature: string; body: string },
  now: Date,
  opts: {
    deriveKey: (root: string) => Promise<string>;
    missingSecret: string;
    badSig: string;
  }
): Promise<{ ok: true } | HmacFail> {
  if (!env.IMPROVE_SCORE_SECRET) {
    return { ok: false, status: 503, refusal: opts.missingSecret };
  }
  const at = Date.parse(signed.timestamp);
  if (Number.isNaN(at)) return { ok: false, status: 400, refusal: "missing or unparseable timestamp header" };
  const age = now.getTime() - at;
  // Both directions: a future timestamp is as much a replay handle as a past one. The
  // tolerance is sized for a few minutes of clock skew.
  if (age > SIGNATURE_MAX_AGE_MS || age < -SIGNATURE_MAX_AGE_MS) {
    return { ok: false, status: 401, refusal: `request timestamp is ${Math.round(age / 1000)}s from now, outside the accepted window` };
  }
  const key = await opts.deriveKey(env.IMPROVE_SCORE_SECRET);
  const expected = await hmacHex(key, signaturePayload(signed.timestamp, signed.body));
  if (!await safeEqual(signed.signature.trim().toLowerCase(), expected)) {
    return { ok: false, status: 401, refusal: opts.badSig };
  }
  return { ok: true };
}

function parseJsonBody(body: string): { ok: true; parsed: unknown } | { ok: false; refusal: string } {
  try {
    return { ok: true, parsed: JSON.parse(body) };
  } catch {
    return { ok: false, refusal: "the credential request body is not JSON" };
  }
}

function jtiOf(parsed: unknown): { ok: true; jti: string } | { ok: false; refusal: string } {
  const jti = (parsed as { jti?: unknown } | null)?.jti;
  if (typeof jti !== "string" || jti.length < 8 || jti.length > 128) {
    return { ok: false, refusal: "the credential request body must carry a jti of 8 to 128 characters" };
  }
  return { ok: true, jti };
}

// The mirror reads backups within minutes of asking; an hour is generous headroom and
// far under the API's 7-day ceiling.
const CREDENTIAL_TTL_SECONDS = 3600;

// Everything the mirror job needs to run `aws s3 sync` with no long-lived repo secret,
// including the endpoint so the account id lives in no repo either.
export interface ScopedCredential {
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  expires_in: number;
}

// The call to the temp-access-credentials API: object-read-only, one hour, one bucket,
// one prefix, derived from the named parent token. The parent's secret never leaves the
// dashboard; the Worker holds only its access key id and the mint token.
async function mintScopedCredential(
  env: Env,
  scope: { bucket: string; prefix: string; parentAccessKeyId: string }
): Promise<{ ok: true; credential: ScopedCredential } | { ok: false; status: number; refusal: string }> {
  const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.R2_ACCOUNT_ID}/r2/temp-access-credentials`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.R2_TEMP_CRED_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket: scope.bucket,
      parentAccessKeyId: scope.parentAccessKeyId,
      permission: "object-read-only",
      ttlSeconds: CREDENTIAL_TTL_SECONDS,
      prefixes: [scope.prefix],
    }),
  });
  if (!resp.ok) {
    return { ok: false, status: 502, refusal: `the temp-access-credentials API answered ${resp.status}: ${(await resp.text()).slice(0, 300)}` };
  }
  const data = (await resp.json()) as { result?: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string } };
  const minted = data.result;
  if (!minted?.accessKeyId || !minted.secretAccessKey || !minted.sessionToken) {
    return { ok: false, status: 502, refusal: "the temp-access-credentials API answered without the three credential fields" };
  }
  return {
    ok: true,
    credential: {
      access_key_id: minted.accessKeyId,
      secret_access_key: minted.secretAccessKey,
      session_token: minted.sessionToken,
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      bucket: scope.bucket,
      prefix: scope.prefix,
      expires_in: CREDENTIAL_TTL_SECONDS,
    },
  };
}

const BACKUP_DUMP_PREFIX = "backups/json/";

// Derived from its own parent token. One parent covers every pinned site's bucket; the
// bucket each mint is scoped to comes from the pinned table, never the caller.
export async function mintBackupCredential(
  env: Env,
  site: OffaccountSite = OFFACCOUNT_DEFAULT_SITE
): Promise<{ ok: true; credential: ScopedCredential } | { ok: false; status: number; refusal: string }> {
  if (!env.R2_TEMP_CRED_TOKEN || !env.R2_BACKUP_PARENT_ACCESS_KEY_ID || !env.R2_ACCOUNT_ID) {
    return {
      ok: false,
      status: 503,
      refusal:
        "backup credential minting is not configured. Set R2_TEMP_CRED_TOKEN, R2_BACKUP_PARENT_ACCESS_KEY_ID and R2_ACCOUNT_ID with wrangler secret put.",
    };
  }
  return mintScopedCredential(env, {
    bucket: OFFACCOUNT_SOURCES[site].bucket,
    prefix: BACKUP_DUMP_PREFIX,
    parentAccessKeyId: env.R2_BACKUP_PARENT_ACCESS_KEY_ID,
  });
}

// A jti and an optional site. The site only picks a row of the pinned table, so an
// unknown one is refused here, before the jti is spent or anything is minted.
export function parseBackupCredentialRequest(
  body: string
): { ok: true; jti: string; site: OffaccountSite } | { ok: false; refusal: string } {
  const json = parseJsonBody(body);
  if (!json.ok) return json;
  const jti = jtiOf(json.parsed);
  if (!jti.ok) return jti;
  const site = (json.parsed as { site?: unknown } | null)?.site;
  if (site === undefined) return { ok: true, jti: jti.jti, site: OFFACCOUNT_DEFAULT_SITE };
  if (typeof site !== "string" || !isOffaccountSite(site)) {
    return { ok: false, refusal: `the credential request names no known site; the sites are ${OFFACCOUNT_SITES.join(", ")}` };
  }
  return { ok: true, jti: jti.jti, site };
}

// Verified in a window both directions, with a timing-safe compare, refusing on anything
// missing, against the backup-specific key, so this key opens nothing else.
export async function verifyBackupCredentialRequest(
  env: Pick<Env, "IMPROVE_SCORE_SECRET">,
  signed: { timestamp: string; signature: string; body: string },
  now: Date
): Promise<{ ok: true } | { ok: false; status: number; refusal: string }> {
  return verifyHmac(env, signed, now, {
    deriveKey: deriveBackupCredentialKey,
    missingSecret: "backup credentials are not configured: IMPROVE_SCORE_SECRET is unset",
    badSig: "backup credential signature does not verify",
  });
}

// The bench endpoints' check, under the same rules as the backup's, against the bench
// key. The key is its own Worker secret, BENCH_SECRET, not derived from
// IMPROVE_SCORE_SECRET: the owner set it up without that root to hand (docs/bench.md),
// so a captured backup request opens nothing here and rotating it touches nothing else.
export async function verifyBenchRequest(
  env: Pick<Env, "BENCH_SECRET">,
  signed: { timestamp: string; signature: string; body: string },
  now: Date
): Promise<{ ok: true } | { ok: false; status: number; refusal: string }> {
  return verifyHmac({ IMPROVE_SCORE_SECRET: env.BENCH_SECRET }, signed, now, {
    deriveKey: async (key) => key,
    missingSecret: "bench reporting is not configured: BENCH_SECRET is unset",
    badSig: "bench request signature does not verify",
  });
}