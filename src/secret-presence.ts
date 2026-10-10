import type { Env } from "./env";
import type { ConvergenceSite, SecretPresence } from "./ops-types";

// THE SECRET PRESENCE OF A SITE'S WORKER (job_09e5f6cbf782; the reader is shared with
// job_5ac1139641e0's credentials inventory). Names, set or not, never a value. The names
// are read from Cloudflare on the watcher's pass (readSecretNames in src/ops-cloudflare.ts,
// with CF_OPS_TOKEN; permission Account / Workers Scripts / Read) and kept here in APP_KV,
// so the Portal shows them without a Portal request ever calling Cloudflare.

const KEY_PREFIX = "site-secrets:";
const KEEP_SECONDS = 7 * 86_400;

export type StoredSecrets = NonNullable<ConvergenceSite["secrets"]> & { read_at: string };

/** Each expected name, set or not, then any name the Worker has that nobody expected. */
export function secretPresence(expected: readonly string[], listed: readonly string[]): SecretPresence[] {
  const have = new Set(listed);
  const want = new Set(expected);
  return [
    ...expected.map((name) => ({ name, set: have.has(name), expected: true })),
    ...[...have].filter((name) => !want.has(name)).sort().map((name) => ({ name, set: true, expected: false })),
  ];
}

export async function storeSecrets(env: Pick<Env, "APP_KV">, namespace: string, value: StoredSecrets): Promise<void> {
  await env.APP_KV.put(KEY_PREFIX + namespace, JSON.stringify(value), { expirationTtl: KEEP_SECONDS });
}

/** What the last pass stored, or null when no pass has read it. */
export async function readStoredSecrets(env: Pick<Env, "APP_KV">, namespace: string): Promise<StoredSecrets | null> {
  const raw = await env.APP_KV.get(KEY_PREFIX + namespace);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSecrets;
    return Array.isArray(parsed.rows) && typeof parsed.read_at === "string" ? parsed : null;
  } catch {
    return null;
  }
}
