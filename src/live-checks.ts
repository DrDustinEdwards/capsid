import { checkSecurityHeaders, failures } from "@dustinedwards/security-headers/check";
import type { Env } from "./env";
import { ghFetch, getDefaultBranch, getRefSha, resolveRepo } from "./github/client";
import type { OpsSite } from "./ops-sites";
import type { SiteProbe } from "./ops-types";

// THE WATCHER'S LIVE CHECKS (capsid/research/design-automation-for-speed.md, D5, ruled
// by Dustin 2026-10-04). Four things Dustin checked by hand with PowerShell after a
// deploy, read by the Worker instead: the deployed sha against the default branch, the
// Web Analytics beacon on public pages, a CSP that lets the beacon load and report,
// and no beacon on pages that must not carry one (conventions 7.9).
//
// WHAT TO CHECK IS A DOCUMENT, NOT CODE. Which pages carry a beacon is a cross-repo
// rule (conventions 7.9), so it lives in Capsid's store at capsid/policy/live-checks.md,
// beside the other policies, and is read each pass. No document means the check does not
// run: nothing is probed on a guess. It judges nothing but what it is told to look at,
// and it can only post a job, like every watcher finding. See docs/live-checks.md.
//
// Reads only. Each page is one GET of the site's own configured origin plus a path the
// document names, so a document cannot point the watcher at another host.

const LIVE_CHECKS_NAMESPACE = "capsid";
const LIVE_CHECKS_PATH = "policy/live-checks.md";

const BEACON_SCRIPT_HOST = "static.cloudflareinsights.com";
const BEACON_REPORT_HOST = "cloudflareinsights.com";

// A push whose deploy has had this long and still has not reached the site is a finding.
// Shorter and the watcher would file a job every time a pass landed inside a normal
// deploy (CI takes about seven minutes).
export const DEPLOY_GRACE_MINUTES = 45;

// Bounds, so one document cannot turn a pass into a flood of subrequests. The tick
// already makes GitHub and Cloudflare reads in the same invocation.
export const MAX_PAGE_RULES = 20;
export const MAX_SHA_RULES = 6;
export const MAX_PAGE_BYTES = 1_048_576;
const PAGE_TIMEOUT_MS = 10_000;
const PATH_PATTERN = /^\/[A-Za-z0-9._~/%-]{0,199}$/;

export type LiveRule =
  | { namespace: string; kind: "beacon"; path: string }
  | { namespace: string; kind: "nobeacon"; path: string }
  | { namespace: string; kind: "headers"; path: string }
  | { namespace: string; kind: "sha" };

export type LiveConfig = { rules: LiveRule[] } | { error: string };

/**
 * The rules in the document. Only lines that begin `- site ` are read; everything else
 * is prose. A `- site` line that does not parse refuses the whole document, because a
 * rule that silently did not apply reads as a page that was checked and found fine.
 *
 *   - site <namespace> beacon <path>     one beacon on this page, and a CSP that allows it
 *   - site <namespace> nobeacon <path>   no beacon on this page
 *   - site <namespace> headers <path>    the OWASP security headers on this page
 *   - site <namespace> sha               the deployed sha is the default branch's head
 */
export function parseLiveConfig(body: string): LiveConfig {
  const rules: LiveRule[] = [];
  for (const [index, raw] of body.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line !== "- site" && !line.startsWith("- site ")) continue;
    const where = `line ${index + 1} (${line.slice(0, 80)})`;
    const parts = line.slice("- site".length).trim().split(/\s+/);
    const [namespace, kind, path, ...rest] = parts;
    if (!namespace || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(namespace)) return { error: `${where}: no site namespace` };
    if (kind === "sha") {
      if (path !== undefined) return { error: `${where}: sha takes no path` };
      // Capsid's own deploy is the "master head" check; a second finding about the same
      // thing would be two jobs for one problem.
      if (namespace === "capsid") return { error: `${where}: capsid's deployed sha is already checked by the master head check` };
      rules.push({ namespace, kind: "sha" });
      continue;
    }
    if (kind !== "beacon" && kind !== "nobeacon" && kind !== "headers") return { error: `${where}: the rule is beacon, nobeacon, headers or sha` };
    if (path === undefined || rest.length > 0 || !PATH_PATTERN.test(path)) {
      return { error: `${where}: ${kind} needs one path that starts with / and holds only letters, digits and . _ ~ / % - (no query, no host)` };
    }
    rules.push({ namespace, kind, path });
  }
  if (rules.filter((r) => r.kind !== "sha").length > MAX_PAGE_RULES) return { error: `more than ${MAX_PAGE_RULES} page rules; each is a fetch inside one pass` };
  if (rules.filter((r) => r.kind === "sha").length > MAX_SHA_RULES) return { error: `more than ${MAX_SHA_RULES} sha rules; each is a GitHub read inside one pass` };
  return { rules };
}

// THE PAGE.

/** Scripts on the page that load the Web Analytics beacon. A script tag whose own
 *  attributes name the beacon host. A beacon a page injects with inline script, or one
 *  Cloudflare adds in the browser, is not in the delivered HTML and is not counted. */
export function beaconCount(html: string): number {
  let count = 0;
  for (const tag of html.matchAll(/<script\b[^>]*>/gi)) {
    if (new RegExp(`\\bsrc\\s*=\\s*["']?(?:https?:)?//${BEACON_SCRIPT_HOST.replace(/\./g, "\\.")}/`, "i").test(tag[0])) count++;
  }
  return count;
}

type Directives = Map<string, string[]>;

/** One Content-Security-Policy header value as its enforced policies, each a map of
 *  directive to sources. A header can carry several, comma separated; every one
 *  applies. The first occurrence of a directive in a policy wins, as in the spec. */
export function parseCsp(header: string): Directives[] {
  return header
    .split(",")
    .map((policy) => {
      const directives: Directives = new Map();
      for (const part of policy.split(";")) {
        const [name, ...sources] = part.trim().split(/\s+/);
        if (!name) continue;
        const key = name.toLowerCase();
        if (!directives.has(key)) directives.set(key, sources);
      }
      return directives;
    })
    .filter((d) => d.size > 0);
}

function hostMatches(source: string, host: string): boolean {
  const s = source.toLowerCase();
  if (s === "*" || s === "https:") return true;
  // Scheme, path and port do not change which host a source names. The beacon is always
  // https, which an http: source upgrades to.
  const bare = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:(\d+|\*)$/, "");
  if (bare === host) return true;
  // A wildcard needs a subdomain, so *.cloudflareinsights.com does not name the apex.
  return bare.startsWith("*.") && host.endsWith(bare.slice(1));
}

export interface CspVerdict {
  ok: boolean;
  why: string | null;
}

/**
 * Whether every enforced policy lets a script load from the beacon host. A directive a
 * policy omits falls back to default-src, and a policy with neither allows it. A
 * 'strict-dynamic' script-src ignores host sources, so the beacon, which carries no
 * nonce, is blocked however its host is listed.
 */
export function cspAllowsBeaconScript(policies: Directives[]): CspVerdict {
  for (const policy of policies) {
    const sources = policy.get("script-src") ?? policy.get("default-src");
    if (!sources) continue;
    if (sources.some((s) => s.toLowerCase() === "'strict-dynamic'")) {
      return { ok: false, why: "script-src uses 'strict-dynamic', which ignores host sources, and the beacon script has no nonce" };
    }
    if (sources.length === 0 || sources.some((s) => s.toLowerCase() === "'none'")) {
      return { ok: false, why: `script-src allows no script (${sources.join(" ") || "empty"})` };
    }
    if (!sources.some((s) => hostMatches(s, BEACON_SCRIPT_HOST))) {
      return { ok: false, why: `script-src (${sources.join(" ")}) does not list ${BEACON_SCRIPT_HOST}` };
    }
  }
  return { ok: true, why: null };
}

/**
 * Whether every enforced policy lets the beacon report. Cloudflare sends it to the
 * site's own /cdn-cgi/rum when the site is proxied through Cloudflare, so 'self' is
 * enough there; any other host sends it to cloudflareinsights.com
 * (developers.cloudflare.com/web-analytics/faq).
 */
export function cspAllowsBeaconReport(policies: Directives[], platform: "cloudflare" | "vercel"): CspVerdict {
  for (const policy of policies) {
    const sources = policy.get("connect-src") ?? policy.get("default-src");
    if (!sources) continue;
    if (sources.length === 0 || sources.some((s) => s.toLowerCase() === "'none'")) {
      return { ok: false, why: `connect-src allows no connection (${sources.join(" ") || "empty"})` };
    }
    const self = platform === "cloudflare" && sources.some((s) => s.toLowerCase() === "'self'");
    if (!self && !sources.some((s) => hostMatches(s, BEACON_REPORT_HOST))) {
      return { ok: false, why: `connect-src (${sources.join(" ")}) does not list ${BEACON_REPORT_HOST}${platform === "cloudflare" ? " or 'self'" : ""}` };
    }
  }
  return { ok: true, why: null };
}

// FINDINGS.

export interface LiveFinding {
  namespace: string;
  fingerprint: string;
  headline: string;
  evidence: string[];
}

/** A page's path as one fingerprint-safe word: "/" is root, "/a/b" is a-b. */
export const slug = (path: string): string => path.replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "root";

export interface PageRead {
  status: number | null;
  headers: Headers | null;
  html: string | null;
  // Why this is not a readable HTML page, or null when it is.
  problem: string | null;
  // The page was not served to an anonymous visitor: a login redirect off the site, or a
  // 401 or 403. For a page that must carry no beacon that is the answer wanted, not a
  // page that could not be read.
  gated: boolean;
}

/** The findings one beacon or nobeacon rule produces from one page read. A page that
 *  could not be read yields none about the beacon (not read is not absent); the caller
 *  reports it as unread. */
export function pageFindings(site: Pick<OpsSite, "namespace" | "name" | "origin" | "platform">, rule: Extract<LiveRule, { path: string }>, page: PageRead): LiveFinding[] {
  if (page.problem !== null || page.html === null || page.headers === null) return [];
  const url = `${site.origin}${rule.path}`;
  const where = slug(rule.path);
  const count = beaconCount(page.html);
  const out: LiveFinding[] = [];
  if (rule.kind === "headers") {
    // The package's own check, so the oracle (OWASP's defaults and its test vectors) lives
    // in one place and the watcher holds no second copy.
    const results = checkSecurityHeaders(page.headers);
    if (results.length === 0) throw new Error("checkSecurityHeaders returned no results, so a pass would mean nothing was checked");
    const failed = failures(results);
    if (failed.length > 0) {
      out.push({
        namespace: site.namespace,
        fingerprint: `live-headers-${site.namespace}-${where}`,
        headline: `${site.name} is missing security headers on a page that must carry them`,
        evidence: [`page: ${url}`, `${failed.length} of ${results.length} header checks failed`, ...failed.slice(0, 12).map((r) => `${r.name}: ${r.detail}`)],
      });
    }
    return out;
  }
  if (rule.kind === "nobeacon") {
    if (count > 0) {
      out.push({
        namespace: site.namespace,
        fingerprint: `live-beacon-present-${site.namespace}-${where}`,
        headline: `${site.name} carries the Web Analytics beacon on a page that must not`,
        evidence: [`page: ${url}`, `beacon scripts in the delivered HTML: ${count}`, "Conventions 7.9 keeps private and signed-in pages out of analytics. Cache-Control: no-transform stops Cloudflare injecting it."],
      });
    }
    return out;
  }
  if (count !== 1) {
    out.push({
      namespace: site.namespace,
      fingerprint: `live-beacon-count-${site.namespace}-${where}`,
      headline: `${site.name} serves ${count} Web Analytics beacons on a public page, not one`,
      evidence: [`page: ${url}`, `beacon scripts in the delivered HTML: ${count}, expected 1`, count === 0 ? "No beacon means no traffic is counted for this page." : "Two beacons count every visit twice."],
    });
  }
  const header = page.headers.get("content-security-policy");
  if (header) {
    const policies = parseCsp(header);
    const script = cspAllowsBeaconScript(policies);
    if (!script.ok) {
      out.push({
        namespace: site.namespace,
        fingerprint: `live-csp-script-${site.namespace}-${where}`,
        headline: `${site.name}'s CSP blocks the Web Analytics beacon script`,
        evidence: [`page: ${url}`, script.why ?? "", `header: ${header.slice(0, 300)}`],
      });
    }
    const report = cspAllowsBeaconReport(policies, site.platform);
    if (!report.ok) {
      out.push({
        namespace: site.namespace,
        fingerprint: `live-csp-report-${site.namespace}-${where}`,
        headline: `${site.name}'s CSP blocks the Web Analytics beacon from reporting`,
        evidence: [`page: ${url}`, report.why ?? "", `header: ${header.slice(0, 300)}`],
      });
    }
  }
  return out;
}

/** The sha finding for one site, or null. `committedAt` is when the default branch's head
 *  was committed; a head younger than the grace is a deploy still in flight. */
export function shaFinding(
  site: Pick<OpsSite, "namespace" | "name">,
  deployed: string | null,
  head: { sha: string; committed_at: string | null },
  now: Date
): LiveFinding | null {
  if (deployed === null) {
    return {
      namespace: site.namespace,
      fingerprint: `live-sha-unreported-${site.namespace}`,
      headline: `${site.name} is set to be checked against its default branch but reports no deployed sha`,
      evidence: ["The site's health route did not report a sha, so the rule in capsid/policy/live-checks.md cannot be judged.", "Either the route does not report one or the rule should go."],
    };
  }
  // A health route may report a short sha; either side may be the prefix.
  if (deployed.length >= 7 && (head.sha.startsWith(deployed) || deployed.startsWith(head.sha))) return null;
  const committed = head.committed_at ? Date.parse(head.committed_at) : Number.NaN;
  if (Number.isNaN(committed)) return null;
  const minutes = (now.getTime() - committed) / 60_000;
  if (minutes < DEPLOY_GRACE_MINUTES) return null;
  return {
    namespace: site.namespace,
    fingerprint: `live-sha-drift-${site.namespace}-${head.sha.slice(0, 7)}`,
    headline: `${site.name}'s deployed sha is not its default branch head`,
    evidence: [
      `deployed: ${deployed}`,
      `default branch head: ${head.sha}, committed ${head.committed_at}`,
      `${Math.floor(minutes)} minutes ago, past the ${DEPLOY_GRACE_MINUTES} minute grace`,
      "A merge whose deploy failed or never ran looks exactly like this.",
    ],
  };
}

// READING.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function readCapped(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: await res.text(), truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), truncated: false };
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return { text, truncated: true };
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** One GET of a site's page. A page that cannot be judged says why in `problem`: an
 *  error, a non-2xx answer, a redirect off the site (a login), a body that is not HTML,
 *  or one past the size bound. None of those is evidence about the beacon. */
export async function readPage(fetchImpl: FetchLike, origin: string, path: string): Promise<PageRead> {
  const unread = (status: number | null, problem: string, gated = false): PageRead => ({ status, headers: null, html: null, problem, gated });
  let res: Response;
  try {
    res = await fetchImpl(`${origin}${path}`, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "capsid-watcher (live checks)", Accept: "text/html" },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
  } catch (err) {
    return unread(null, `no answer: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
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
  const { text, truncated } = await readCapped(res, MAX_PAGE_BYTES);
  if (truncated) return unread(res.status, `page is larger than ${MAX_PAGE_BYTES} bytes, so a beacon count over it would be a guess`);
  return { status: res.status, headers: res.headers, html: text, problem: null, gated: false };
}

/** The default branch's head sha and when it was committed. */
export async function defaultBranchHead(env: Env, namespace: string): Promise<{ sha: string; committed_at: string | null }> {
  const { owner, repo } = await resolveRepo(env, namespace);
  const branch = await getDefaultBranch(env, owner, repo);
  const sha = await getRefSha(env, owner, repo, branch);
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`);
  if (!resp.ok) throw new Error(`commit lookup failed for ${sha.slice(0, 7)} (${resp.status})`);
  const body = (await resp.json()) as { commit?: { committer?: { date?: string } | null } };
  return { sha, committed_at: body.commit?.committer?.date ?? null };
}

export interface LiveSummary {
  pages_expected: number;
  pages_read: number;
  shas_expected: number;
  shas_read: number;
}

export interface LiveResult {
  findings: LiveFinding[];
  // Whether every configured check was read, so a finding that stops appearing is
  // evidence it is fixed. Not run on a missing document, an invalid one, or any
  // unread page or sha: absence of a read is not absence of a problem.
  ran: boolean;
  summary: LiveSummary;
}

const NOTHING: LiveSummary = { pages_expected: 0, pages_read: 0, shas_expected: 0, shas_read: 0 };

export async function readLiveConfig(db: D1Database): Promise<{ body: string } | null> {
  const row = await db
    .prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2 AND status = 'published'")
    .bind(LIVE_CHECKS_NAMESPACE, LIVE_CHECKS_PATH)
    .first<{ body: string | null }>();
  return row && row.body !== null ? { body: row.body } : null;
}

export interface LiveDeps {
  fetchImpl: FetchLike;
  head: (namespace: string) => Promise<{ sha: string; committed_at: string | null }>;
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
  now: Date
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
          evidence: [parsed.error, "Fix the line named; the check reads the document again every pass."],
        },
      ],
      ran: false,
      summary: NOTHING,
    };
  }
  const findings: LiveFinding[] = [];
  const bySite = new Map(sites.map((s) => [s.namespace, s]));
  const probeFor = new Map(probes.map((p) => [p.namespace, p]));
  const summary: LiveSummary = { pages_expected: 0, pages_read: 0, shas_expected: 0, shas_read: 0 };

  for (const rule of parsed.rules) {
    const site = bySite.get(rule.namespace);
    if (!site) {
      findings.push({
        namespace: LIVE_CHECKS_NAMESPACE,
        fingerprint: `live-config-unknown-site-${rule.namespace}`,
        headline: `capsid/policy/live-checks.md names a site that is not configured: ${rule.namespace}`,
        evidence: ["A rule for a site with no origin in Portal Settings never runs.", "Add the site there, or remove its lines."],
      });
      continue;
    }
    const probe = probeFor.get(rule.namespace);
    const counted = rule.kind === "sha" ? "shas" : "pages";
    summary[`${counted}_expected`] += 1;
    if (!probe || probe.state === "down") continue;

    if (rule.kind === "sha") {
      const head = await deps.head(rule.namespace);
      summary.shas_read += 1;
      const f = shaFinding(site, probe.sha, head, now);
      if (f) findings.push(f);
      continue;
    }
    const page = await readPage(deps.fetchImpl, site.origin, rule.path);
    if (page.problem !== null && page.gated && rule.kind === "nobeacon") {
      // Not served to the public, which is what the rule asks for.
      summary.pages_read += 1;
      continue;
    }
    if (page.problem !== null) {
      findings.push({
        namespace: site.namespace,
        fingerprint: `live-page-unread-${site.namespace}-${slug(rule.path)}`,
        headline: `${site.name}'s ${rule.path} could not be read for the live checks`,
        evidence: [`page: ${site.origin}${rule.path}`, page.problem, "Not read is not clean: the beacon and CSP on this page were not judged."],
      });
      continue;
    }
    summary.pages_read += 1;
    findings.push(...pageFindings(site, rule, page));
  }
  const ran = summary.pages_read === summary.pages_expected && summary.shas_read === summary.shas_expected;
  // One finding per fingerprint: two rules for one unknown site, or the same page named
  // twice, are one problem, and the queue refuses a second job under the same title.
  const unique = [...new Map(findings.map((f) => [f.fingerprint, f])).values()];
  return { findings: unique, ran, summary };
}
