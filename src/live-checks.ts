import type { Env } from "./env";
import { ghFetch, getDefaultBranch, getRefSha, resolveRepo } from "./github/client";
import type { OpsSite } from "./ops-sites";
import type { SiteProbe } from "./ops-types/sites";
import type { WebAnalyticsSite } from "./ops-types/views";
import { readCapped } from "@dustinedwards/site-runtime/body";
import { callSignal } from "./call-signal";
import {
  analyticsFinding,
  pageFindings,
  shaFinding,
  slug,
  type LiveFinding,
  type PageRead,
} from "./live-findings";

import { errorMessage } from "@dustinedwards/site-runtime/log";
// THE WATCHER'S LIVE CHECKS (capsid/research/design-automation-for-speed.md, D5). Four checks
// after a deploy: the deployed sha against the default branch, the Web Analytics beacon on
// public pages, a CSP that lets it load and report, and no beacon on pages that must not
// carry one.
//
// WHAT TO CHECK IS A DOCUMENT, NOT CODE. Which pages carry a beacon is a cross-repo rule, so
// it lives at capsid/policy/live-checks.md and is read each pass. No document means no check:
// nothing is probed on a guess. It can only post a job, like every watcher finding. See
// docs/live-checks.md.
//
// Reads only: each page is one GET of the site's own configured origin plus a path the
// document names, so a document cannot point the watcher at another host.

const LIVE_CHECKS_NAMESPACE = "capsid";
const LIVE_CHECKS_PATH = "policy/live-checks.md";

// Bounds, so one document cannot turn a pass into a flood of subrequests. The tick
// already makes GitHub and Cloudflare reads in the same invocation.
const MAX_PAGE_RULES = 20;
const MAX_SHA_RULES = 6;
const MAX_ANALYTICS_RULES = 20;
export const MAX_PAGE_BYTES = 1_048_576;
const PAGE_TIMEOUT_MS = 10_000;
const PATH_PATTERN = /^\/[A-Za-z0-9._~/%-]{0,199}$/;

export type LiveRule =
  | { namespace: string; kind: "beacon"; path: string }
  | { namespace: string; kind: "nobeacon"; path: string }
  | { namespace: string; kind: "headers"; path: string }
  | { namespace: string; kind: "sha" }
  | { namespace: string; kind: "analytics" };

export type LiveConfig = { rules: LiveRule[] } | { error: string };

/**
 * The rules in the document. Only lines that begin `- site ` are read; everything else
 * is prose. A `- site` line that does not parse refuses the whole document, because a
 * rule that silently did not apply reads as a page that was checked and found fine.
 *
 *   - site <namespace> beacon <path>     a CSP on this page that lets the beacon load and report
 *   - site <namespace> nobeacon <path>   no beacon on this page
 *   - site <namespace> headers <path>    the OWASP security headers on this page
 *   - site <namespace> sha               the deployed sha is the default branch's head
 *   - site <namespace> analytics         Web Analytics automatic setup is on for the site's host
 */
export function parseLiveConfig(body: string): LiveConfig {
  const rules: LiveRule[] = [];
  for (const [index, raw] of body.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line !== "- site" && !line.startsWith("- site ")) continue;
    const where = `line ${index + 1} (${line.slice(0, 80)})`;
    const parts = line.slice("- site".length).trim().split(/\s+/);
    const [namespace, kind, path, ...rest] = parts;
    if (!namespace || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(namespace))
      return { error: `${where}: no site namespace` };
    if (kind === "analytics") {
      if (path !== undefined) return { error: `${where}: analytics takes no path` };
      rules.push({ namespace, kind: "analytics" });
      continue;
    }
    if (kind === "sha") {
      if (path !== undefined) return { error: `${where}: sha takes no path` };
      // Capsid's own deploy is the "master head" check; a second finding about the same
      // thing would be two jobs for one problem.
      if (namespace === "capsid")
        return {
          error: `${where}: capsid's deployed sha is already checked by the master head check`,
        };
      rules.push({ namespace, kind: "sha" });
      continue;
    }
    if (kind !== "beacon" && kind !== "nobeacon" && kind !== "headers")
      return { error: `${where}: the rule is beacon, nobeacon, headers, analytics or sha` };
    if (path === undefined || rest.length > 0 || !PATH_PATTERN.test(path)) {
      return {
        error: `${where}: ${kind} needs one path that starts with / and holds only letters, digits and . _ ~ / % - (no query, no host)`,
      };
    }
    rules.push({ namespace, kind, path });
  }
  if (rules.filter((r) => r.kind === "analytics").length > MAX_ANALYTICS_RULES)
    return { error: `more than ${MAX_ANALYTICS_RULES} analytics rules` };
  if (rules.filter((r) => r.kind !== "sha" && r.kind !== "analytics").length > MAX_PAGE_RULES)
    return { error: `more than ${MAX_PAGE_RULES} page rules; each is a fetch inside one pass` };
  if (rules.filter((r) => r.kind === "sha").length > MAX_SHA_RULES)
    return { error: `more than ${MAX_SHA_RULES} sha rules; each is a GitHub read inside one pass` };
  return { rules };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** One GET of a site's page. A page that cannot be judged says why in `problem`: an
 *  error, a non-2xx answer, a redirect off the site (a login), a body that is not HTML,
 *  or one past the size bound. None of those is evidence about the beacon. */
export async function readPage(
  fetchImpl: FetchLike,
  origin: string,
  path: string,
): Promise<PageRead> {
  const unread = (status: number | null, problem: string, gated = false): PageRead => ({
    status,
    headers: null,
    html: null,
    problem,
    gated,
  });
  let res: Response;
  try {
    res = await fetchImpl(`${origin}${path}`, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "capsid-watcher (live checks)", Accept: "text/html" },
      signal: callSignal(PAGE_TIMEOUT_MS),
    });
  } catch (err) {
    return unread(null, `no answer: ${errorMessage(err).slice(0, 120)}`);
  }
  if (res.url) {
    const finalOrigin = new URL(res.url).origin;
    if (finalOrigin !== new URL(origin).origin) {
      await res.body?.cancel();
      return unread(res.status, `redirected off the site to ${finalOrigin}`, true);
    }
  }
  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel();
    return unread(res.status, `answered ${res.status}`, res.status === 401 || res.status === 403);
  }
  const type = res.headers.get("content-type") ?? "";
  if (!/\btext\/html\b/i.test(type)) {
    await res.body?.cancel();
    return unread(res.status, `content-type is ${type || "absent"}, not HTML`);
  }
  const text = await readCapped(res, MAX_PAGE_BYTES);
  if (text === null)
    return unread(
      res.status,
      `page is larger than ${MAX_PAGE_BYTES} bytes, so a beacon count over it would be a guess`,
    );
  return { status: res.status, headers: res.headers, html: text, problem: null, gated: false };
}

/** The default branch's head sha and when it was committed. */
export async function defaultBranchHead(
  env: Env,
  namespace: string,
): Promise<{ sha: string; committed_at: string | null }> {
  const { owner, repo } = await resolveRepo(env, namespace);
  const branch = await getDefaultBranch(env, owner, repo);
  const sha = await getRefSha(env, owner, repo, branch);
  const resp = await ghFetch(
    env,
    owner,
    repo,
    `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`,
  );
  if (!resp.ok) throw new Error(`commit lookup failed for ${sha.slice(0, 7)} (${resp.status})`);
  const body = (await resp.json()) as { commit?: { committer?: { date?: string } | null } };
  return { sha, committed_at: body.commit?.committer?.date ?? null };
}

interface LiveSummary {
  pages_expected: number;
  pages_read: number;
  shas_expected: number;
  shas_read: number;
  analytics_expected: number;
  analytics_read: number;
}

export interface LiveResult {
  findings: LiveFinding[];
  // Whether every configured check was read, so a finding that stops appearing is
  // evidence it is fixed. Not run on a missing document, an invalid one, or any
  // unread page or sha: absence of a read is not absence of a problem.
  ran: boolean;
  summary: LiveSummary;
}

const NOTHING: LiveSummary = {
  pages_expected: 0,
  pages_read: 0,
  shas_expected: 0,
  shas_read: 0,
  analytics_expected: 0,
  analytics_read: 0,
};

export async function readLiveConfig(db: D1Database): Promise<{ body: string } | null> {
  const row = await db
    .prepare(
      "SELECT body FROM documents WHERE namespace = ?1 AND path = ?2 AND status = 'published'",
    )
    .bind(LIVE_CHECKS_NAMESPACE, LIVE_CHECKS_PATH)
    .first<{ body: string | null }>();
  return row && row.body !== null ? { body: row.body } : null;
}

export interface LiveDeps {
  fetchImpl: FetchLike;
  head: (namespace: string) => Promise<{ sha: string; committed_at: string | null }>;
  // The account's Web Analytics sites, read once per pass. Throws, with the reason, when
  // Cloudflare cannot be read (no token, a 403 for a missing permission).
  analytics: () => Promise<WebAnalyticsSite[]>;
}

/**
 * Run every rule in the document. `probes` are this pass's site probes, which carry the
 * deployed sha. A site down on this pass is the site-down check's finding, so its pages
 * and sha are skipped here and the run is not complete.
 */
export async function liveChecks(
  config: { body: string } | null,
  sites: readonly OpsSite[],
  probes: readonly SiteProbe[],
  deps: LiveDeps,
  now: Date,
): Promise<LiveResult> {
  if (config === null) return { findings: [], ran: false, summary: NOTHING };
  const parsed = parseLiveConfig(config.body);
  if ("error" in parsed) {
    return {
      findings: [
        {
          namespace: LIVE_CHECKS_NAMESPACE,
          fingerprint: "live-config-invalid",
          headline: "capsid/policy/live-checks.md does not parse, so no live check is running",
          evidence: [
            parsed.error,
            "Fix the line named; the check reads the document again every pass.",
          ],
        },
      ],
      ran: false,
      summary: NOTHING,
    };
  }
  const findings: LiveFinding[] = [];
  const bySite = new Map(sites.map((s) => [s.namespace, s]));
  const probeFor = new Map(probes.map((p) => [p.namespace, p]));
  let analyticsRead: Promise<{ sites: WebAnalyticsSite[] } | { problem: string }> | undefined;
  const summary: LiveSummary = {
    pages_expected: 0,
    pages_read: 0,
    shas_expected: 0,
    shas_read: 0,
    analytics_expected: 0,
    analytics_read: 0,
  };

  for (const rule of parsed.rules) {
    const site = bySite.get(rule.namespace);
    if (!site) {
      findings.push({
        namespace: LIVE_CHECKS_NAMESPACE,
        fingerprint: `live-config-unknown-site-${rule.namespace}`,
        headline: `capsid/policy/live-checks.md names a site that is not configured: ${rule.namespace}`,
        evidence: [
          "A rule for a site with no origin in Portal Settings never runs.",
          "Add the site there, or remove its lines.",
        ],
      });
      continue;
    }
    const probe = probeFor.get(rule.namespace);
    const counted =
      rule.kind === "sha" ? "shas" : rule.kind === "analytics" ? "analytics" : "pages";
    summary[`${counted}_expected`] += 1;
    if (!probe || probe.state === "down") continue;

    if (rule.kind === "analytics") {
      analyticsRead ??= deps.analytics().then(
        (sites) => ({ sites }),
        (err: unknown) => ({
          problem: errorMessage(err).slice(0, 400),
        }),
      );
      const read = await analyticsRead;
      if ("problem" in read) {
        findings.push({
          namespace: site.namespace,
          fingerprint: `live-analytics-unread-${site.namespace}`,
          headline: `${site.name}'s Web Analytics setting could not be read for the live checks`,
          evidence: [read.problem, "Not read is not clean: the setting was not judged."],
        });
        continue;
      }
      summary.analytics_read += 1;
      const f = analyticsFinding(site, read.sites);
      if (f) findings.push(f);
      continue;
    }
    if (rule.kind === "sha") {
      const head = await deps.head(rule.namespace);
      summary.shas_read += 1;
      const f = shaFinding(site, probe.sha, head, now);
      if (f) findings.push(f);
      continue;
    }
    const page = await readPage(deps.fetchImpl, site.origin, rule.path);
    if (page.problem !== null && page.gated && rule.kind === "nobeacon") {
      summary.pages_read += 1;
      continue;
    }
    if (page.problem !== null) {
      findings.push({
        namespace: site.namespace,
        fingerprint: `live-page-unread-${site.namespace}-${slug(rule.path)}`,
        headline: `${site.name}'s ${rule.path} could not be read for the live checks`,
        evidence: [
          `page: ${site.origin}${rule.path}`,
          page.problem,
          "Not read is not clean: the beacon and CSP on this page were not judged.",
        ],
      });
      continue;
    }
    summary.pages_read += 1;
    findings.push(...pageFindings(site, rule, page));
  }
  const ran =
    summary.pages_read === summary.pages_expected &&
    summary.shas_read === summary.shas_expected &&
    summary.analytics_read === summary.analytics_expected;
  // One finding per fingerprint: two rules for one unknown site, or the same page named
  // twice, are one problem, and the queue refuses a second job under the same title.
  const unique = [...new Map(findings.map((f) => [f.fingerprint, f])).values()];
  return { findings: unique, ran, summary };
}
