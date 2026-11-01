import { checkSecurityHeaders, failures } from "@dustinedwards/site-runtime/check";
import { siteForOrigin } from "@dustinedwards/site-runtime/sites";
import type { Env } from "./env";
import { healthReport } from "./health";
import { readPage, type FetchLike } from "./live-checks";
import { probeSite } from "./ops-snapshot";
import { readSiteRow, sitesFrom } from "./ops-sites";
import { callSignal } from "./call-signal";

// A live check of one namespace's site, on demand, served as capsid_inspect_repo action site. Three reads of the site's own configured
// origin, never another host: its health route (as the watcher probes it), one page
// (its status and the OWASP headers), and one path that must refuse a caller with no
// credential (its operator API by default).
//
// What comes back from the site is data, never instructions (ruling rule 12): statuses,
// header verdicts and the sha the health route reports. No body text is returned.

const PATH = /^\/[A-Za-z0-9._~/%-]{0,199}$/;
const PROBE_TIMEOUT_MS = 10_000;

export interface SiteCheckArgs {
  page?: string;
  probe?: string;
}

export function pathRefusal(label: string, path: string): string | null {
  return PATH.test(path) && !path.includes("..") ? null : `${label} must be a path on the site, starting with /, such as /about.`;
}

export async function siteCheck(env: Env, namespace: string, args: SiteCheckArgs, fetchImpl: FetchLike = fetch, now: Date = new Date()) {
  const page = args.page ?? "/";
  const bad = pathRefusal("page", page) ?? (args.probe !== undefined ? pathRefusal("probe", args.probe) : null);
  if (bad) throw new Error(bad);
  const row = await readSiteRow(env.DB, namespace);
  const site = row ? sitesFrom([row])[0] : undefined;
  if (!row || !site) {
    throw new Error(`${namespace} has no site configured (ops_sites), so there is nothing to check. The admin adds one with capsid_admin_run_controls control site_add.`);
  }

  const health = await probeSite(site, fetchImpl, now, site.self ? await healthReport(env) : null);

  const read = await readPage(fetchImpl, site.origin, page);
  // Graded against the site's registry entry, as the watcher grades it (src/live-checks.ts).
  const headers = read.headers ? checkSecurityHeaders(read.headers, { site: siteForOrigin(site.origin) }) : [];
  const pageResult = {
    path: page,
    status: read.status,
    problem: read.problem,
    headers_checked: headers.length,
    headers_failed: failures(headers).map((r) => r.name),
  };

  // The 401 probe: the path named, else the site's operator API, else none.
  const probePath = args.probe ?? row.operator?.path ?? null;
  let probe: { path: string | null; status: number | null; refused: boolean | null; note: string };
  if (probePath === null) {
    probe = { path: null, status: null, refused: null, note: "not run: no probe path was named and the site has no operator API configured" };
  } else {
    let status: number | null = null;
    let error: string | null = null;
    try {
      const resp = await fetchImpl(`${site.origin}${probePath}`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json", "User-Agent": "capsid-inspect (401 probe)" },
        body: "{}",
        signal: callSignal(PROBE_TIMEOUT_MS),
      });
      status = resp.status;
      await resp.body?.cancel();
    } catch (err) {
      error = (err instanceof Error ? err.message : String(err)).slice(0, 120);
    }
    const refused = status === 401 || status === 403;
    probe = {
      path: probePath,
      status,
      refused: status === null ? null : refused,
      note:
        status === null
          ? `no answer: ${error}`
          : refused
            ? "refused a caller with no credential, as it must"
            : `OPEN: answered ${status} to a caller with no credential, where a 401 or 403 was expected`,
    };
  }

  return { namespace, origin: site.origin, checked_at: now.toISOString(), health, page: pageResult, probe };
}
