import type { Env } from "./env";
import { errorMessage } from "@dustinedwards/site-runtime/log";
import { cloudflareCredentials, readSecretNames } from "./ops-cloudflare";
import type { OpsSiteConfig } from "./ops-sites";
import type { SiteCloudflare } from "./ops-types/sites";
import { secretPresence } from "./secret-presence";

/** The secret names of one opted-in site's Worker as the convergence view stores them:
 *  names only, set or not. A read that cannot be made stores its own reason, so one
 *  site's failure never stops another's (src/watcher-gather.ts calls this per site). */
export async function readSiteSecrets(
  env: Env,
  site: OpsSiteConfig,
  cloudflare: Record<string, SiteCloudflare> | undefined,
  now: Date,
  fetchImpl: typeof fetch,
) {
  const read_at = now.toISOString();
  const expected = site.operator!.secrets;
  const cfState = cloudflare?.[site.namespace];
  const script = site.script ?? (cfState?.state === "ok" ? cfState.script : null);
  const credentials = cloudflareCredentials(env);
  return !credentials.ok
    ? { state: "error" as const, script, rows: [], reason: credentials.reason, read_at }
    : !script
      ? {
          state: "error" as const,
          script: null,
          rows: [],
          reason:
            "the Worker script is not known: name it on the site's row, or let the Cloudflare read resolve it",
          read_at,
        }
      : await readSecretNames(fetchImpl, credentials.token, credentials.account, script).then(
          (names) => ({
            state: "ok" as const,
            script,
            rows: secretPresence(expected, names),
            reason: null,
            read_at,
          }),
          (err: unknown) => ({
            state: "error" as const,
            script,
            rows: [],
            reason: errorMessage(err).slice(0, 300),
            read_at,
          }),
        );
}
