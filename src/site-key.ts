import type { Env } from "./env";
import { CF_API, type FetchLike } from "./ops-cloudflare";
import { readSiteRow } from "./ops-sites";
import { auditStatement } from "./store-guards";
import { b64urlFromBytes } from "./encoding";
import { logEvent } from "./log";

// SET A SITE KEY (capsid/rulings/mcp-2026-10-10.md, amendment answer 2: "set_site_key
// (Admin: create a site key and set it on both sides, never shown)"), served as
// capsid_admin_set_site_key. The site key is the site API's key
// (DrDustinEdwards/site-api): the site's Worker holds it as CARREL_SITE_KEY, and Carrel
// holds the same value as SITE_<NAMESPACE>_KEY to call that site. This mints a new one
// and sets it as a secret on both Workers through the Cloudflare API.
//
// THE VALUE IS NEVER SHOWN: not returned, not logged, not in the audit row, not in an
// error. It exists in this invocation's memory and in the two secrets, and nowhere else.
//
// The token is CF_SECRETS_TOKEN, apart from the watcher's read token because it can
// write: Workers Scripts Edit on the account. Unset, nothing is minted. A step-up (a
// recent sign-in) is required for an OAuth session (src/scope.ts STEP_UP).
//
// ORDER. The site first, then Carrel. When the site takes the new key and Carrel does
// not, Carrel's calls to the site are refused until the two match; the answer says so
// and that calling again mints a fresh key and sets both. Nothing is retried silently.

export const CARREL_SCRIPT = "carrel";
export const SITE_SECRET = "CARREL_SITE_KEY";
const SCRIPT = /^[A-Za-z0-9_-]{1,63}$/;
const KEY_BYTES = 32;
const CF_TIMEOUT_MS = 15_000;

/** Carrel's name for a site's key: SITE_<NAMESPACE>_KEY, upper case, dashes as underscores. */
export function carrelSecretName(namespace: string): string {
  return `SITE_${namespace.toUpperCase().replace(/-/g, "_")}_KEY`;
}

/** A new key: 32 random bytes, base64url, 43 characters (site-api refuses under 32). */
export function mintSiteKey(): string {
  return b64urlFromBytes(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

async function putSecret(fetchImpl: FetchLike, token: string, account: string, script: string, name: string, value: string): Promise<{ ok: true } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetchImpl(`${CF_API}/accounts/${account}/workers/scripts/${script}/secrets`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "capsid (set site key)" },
      body: JSON.stringify({ name, text: value, type: "secret_text" }),
      signal: AbortSignal.timeout(CF_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: `no answer from Cloudflare: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}` };
  }
  // Only Cloudflare's own error messages are read back, never the request.
  let messages = "";
  try {
    const body = (await res.json()) as { success?: boolean; errors?: Array<{ message?: string }> };
    if (res.ok && body.success === true) return { ok: true };
    messages = (body.errors ?? []).map((e) => e.message ?? "").filter(Boolean).join("; ");
  } catch {
    messages = "the answer was not JSON";
  }
  const hint = res.status === 403 ? " CF_SECRETS_TOKEN needs Workers Scripts Edit on the account." : "";
  return { ok: false, error: `Cloudflare answered ${res.status}: ${messages || "no error message"}.${hint}` };
}

export async function setSiteKey(env: Env, actor: string, namespace: string, fetchImpl: FetchLike = fetch) {
  const token = env.CF_SECRETS_TOKEN?.trim();
  const account = env.CF_ACCOUNT_ID?.trim() || env.R2_ACCOUNT_ID?.trim();
  if (!token || !account) {
    throw new Error(`no key was minted: ${!token ? "CF_SECRETS_TOKEN is not set" : "neither CF_ACCOUNT_ID nor R2_ACCOUNT_ID is set"}. The seat sets CF_SECRETS_TOKEN, a token with Workers Scripts Edit (docs/portal.md, "Site keys").`);
  }
  const row = await readSiteRow(env.DB, namespace);
  if (!row || row.platform !== "cloudflare" || !row.script || !SCRIPT.test(row.script)) {
    throw new Error(`no key was minted: ${namespace}'s site row names no Cloudflare Worker script, so there is no site Worker to set it on.`);
  }
  const siteScript = row.script;
  const carrelSecret = carrelSecretName(namespace);

  const key = mintSiteKey();
  const site = await putSecret(fetchImpl, token, account, siteScript, SITE_SECRET, key);
  const carrel = site.ok ? await putSecret(fetchImpl, token, account, CARREL_SCRIPT, carrelSecret, key) : null;
  const result = {
    namespace,
    site: { script: siteScript, secret: SITE_SECRET, set: site.ok, ...(site.ok ? {} : { error: site.error }) },
    carrel: carrel
      ? { script: CARREL_SCRIPT, secret: carrelSecret, set: carrel.ok, ...(carrel.ok ? {} : { error: carrel.error }) }
      : { script: CARREL_SCRIPT, secret: carrelSecret, set: false, error: "not attempted: the site Worker did not take the key, so Carrel keeps the key the site still holds" },
  };
  const matched = site.ok && carrel?.ok === true;
  // The record of the change, never the value.
  try {
    await auditStatement(env.DB, actor, "set_site_key", namespace, null, result).run();
  } catch (err) {
    logEvent("error", "AUDIT_INSERT_FAILED", { message: `AUDIT_INSERT_FAILED set_site_key ${namespace}: ${err instanceof Error ? err.message : String(err)}` });
  }
  return {
    ...result,
    matched,
    note: matched
      ? "A new key was minted and set on both Workers. Its value is not shown anywhere. Each Worker serves it from its next request."
      : site.ok
        ? "THE TWO SIDES DIFFER: the site Worker holds the new key and Carrel does not, so Carrel's calls to the site are refused until they match. Call again: it mints a fresh key and sets both."
        : "Nothing changed: the site Worker did not take the key, and Carrel was not touched.",
  };
}
