import { readActionHours, readToolHours, anomalyFindings, toolRateFindings } from "./anomaly";
import { DEPLOY_ROSTER, readDeployOutcomes, deployFindings } from "./deploy-outcomes";
import { registrableDomain, readExpiries, expiryFindings } from "./domain-expiry";
import type { Env } from "./env";
import { defaultBranchSha, ciStatus, listRepoTree } from "./github";
import { healthReport } from "./health";
import { readLiveConfig, liveChecks, defaultBranchHead } from "./live-checks";
import { logEvent } from "@dustinedwards/site-runtime/log";
import { checkManualSteps, liveStepReaders } from "./manual-steps";
import { cloudflareCredentials, readWebAnalyticsSites, readCloudflare, readSecretNames, readAccessAppNames } from "./ops-cloudflare";
import { readPackageConfig, readPackage, npmVersions } from "./ops-packages";
import { readSiteConfig, type OpsSite, sitesFrom, siteMapDrift } from "./ops-sites";
import { type SiteProbe, probeSite, readSnapshot } from "./ops-snapshot";
import type { PackageSnapshot } from "./ops-types/sites";
import { APP_ROSTER } from "./roster";
import { secretPresence, storeSecrets } from "./secret-presence";
import { watchSites } from "./site-watch";
import { readStaleCanon } from "./stale-canon";
import { capsidStatus } from "./status";
import { readRepoMap } from "./unmapped-repos";
import { type Gathered, type Observed, WATCHER_ACTOR } from "./watcher";
import type { WatcherCheck } from "./watcher-checks";
import { type Finding, type DeployVerdict, deployVerdict, healthFindings, statusFindings, MIRROR_DUMP_PREFIX, MIRROR_REPO_LABEL, type MirrorRun, newestDump, mirrorFindings, latestMirrorRun, type CiRun, ciFindings, siteMapFindings, unmappedRepoFindings, repoMapUnreadableFinding, siteDownFindings, liveFinding, finding, siteErrorFindings, siteCpuFindings } from "./watcher-detect";

// The watcher's reads (src/watcher.ts runs the pass): every surface it checks, read
// once per pass and turned into findings by src/watcher-detect.ts.
//
// Every read is wrapped so one failing surface does not stop the others being
// checked. A watcher that goes silent because GitHub was slow is worse than one that
// reports three of its four checks, because silence reads as health.

async function attempt<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    logEvent("WATCHER_READ_FAILED", { message: `WATCHER_READ_FAILED ${what}: ${err instanceof Error ? err.message : String(err)}` }, { level: "error" });
    return null;
  }
}

const basename = (path: string): string => path.split("/").filter(Boolean).pop() ?? "";

/** The newest migration filename on master, compared against the live schema_version.
 *  Sorted by name: the files are zero-padded. */
export function newestMigration(names: string[]): string | null {
  const sql = names.filter((n) => n.endsWith(".sql")).sort();
  return sql.length ? sql[sql.length - 1] : null;
}

export async function gatherFindings(env: Env, now: Date, fetchImpl: typeof fetch = fetch): Promise<Gathered> {
  const out: Finding[] = [];
  const ran = new Set<WatcherCheck>();
  const observed: Observed = { health: null, mirror: null, ci: [], siteMap: null, probes: null };

  // No casts on a repo reader's result, so a renamed field fails `npm run check`.
  // attempt() swallows a throw, so a cast would hide a check that never runs.
  // test/watcher-gather.test.ts drives both reads end to end.
  const health = await attempt("health", () => healthReport(env));
  observed.health = health;
  if (health) {
    ran.add("health");
    const head = await attempt("master head", () => defaultBranchSha(env, "capsid"));
    // Master head's own CI run, read only when the deployed sha differs. A deploy
    // still in flight leaves the check un-judged this pass: nothing is posted and an
    // open drift finding is not cleared on it.
    let deploy: DeployVerdict | undefined;
    if (head !== null && health.sha && health.sha !== "unknown" && health.sha !== head) {
      const runs = await attempt("head ci run", async () => (await ciStatus(env, "capsid", undefined, { ref: head, limit: 10 })).runs);
      deploy = deployVerdict(runs, now);
    }
    if (head !== null && !deploy?.wait) ran.add("master head");
    // Wrapped in an object so a tree with no migrations (null) is told apart from a
    // read that failed (also null from attempt).
    const migrations = await attempt("migrations", async () => {
      const tree = await listRepoTree(env, "capsid", "migrations");
      return { newest: newestMigration(tree.entries.map((e) => basename(e.path))) };
    });
    if (migrations !== null) ran.add("migrations");
    out.push(...healthFindings(health, head ?? null, migrations?.newest ?? null, "capsid", deploy));
  }

  const status = await attempt("status", () => capsidStatus(env));
  if (status) {
    ran.add("status");
    out.push(...statusFindings(status));
  }

  // The off-account mirror, resolved through the capsid namespace mapping (selector
  // "backups"). A failed dump read skips the check: "cannot see the mirror" is not
  // "the mirror is dead", and an outage must not file a job every half hour. A failed
  // run read degrades to an empty list, so the stale-dump finding still fires.
  const dumps = await attempt("mirror dumps", async () => {
    const tree = await listRepoTree(env, "capsid", MIRROR_DUMP_PREFIX, undefined, MIRROR_REPO_LABEL);
    return tree.entries;
  });
  if (dumps) {
    ran.add("mirror dumps");
    const runs: MirrorRun[] | null = await attempt("mirror runs", async () => (await ciStatus(env, "capsid", MIRROR_REPO_LABEL, { limit: 10 })).runs);
    if (runs) ran.add("mirror runs");
    const newest = newestDump(dumps);
    out.push(...mirrorFindings("capsid", newest, runs ?? [], now));
    const last = runs ? latestMirrorRun(runs) : null;
    observed.mirror = {
      newest_dump: newest?.toISOString() ?? null,
      last_run: last ? { at: last.created_at ?? null, conclusion: last.conclusion ?? null, url: last.url ?? null } : null,
    };
  }

  // The ci check counts as run only when every roster repo was read. A ci-red
  // fingerprint names its namespace, but ownership is per check, not per repo, so a
  // repo that could not be read must not let the others' pass clear its incident.
  let ciRead = 0;
  for (const namespace of APP_ROSTER) {
    const runs: CiRun[] | null = await attempt(`ci ${namespace}`, async () => (await ciStatus(env, namespace, undefined, { limit: 5 })).runs);
    if (runs) {
      ciRead++;
      out.push(...ciFindings(namespace, runs, now));
    }
    const latest = runs?.find((r) => r.status === "completed") ?? runs?.[0] ?? null;
    observed.ci.push({
      namespace,
      latest: latest
        ? { head_sha: latest.head_sha, status: latest.status, conclusion: latest.conclusion, created_at: latest.created_at, url: latest.url ?? null }
        : null,
    });
  }
  if (ciRead === APP_ROSTER.length) ran.add("ci");

  // What became of each roster repo's newest deploys (src/deploy-outcomes.ts, the merge
  // pipeline's PR 6): recorded in deploy_outcomes, and a rollback is a finding. The check
  // counts as run only when every repo was read, so a failed read never clears one.
  let deploysRead = 0;
  for (const namespace of DEPLOY_ROSTER) {
    // Wrapped, since a repo with no deploy yet reads as null and a failed read does too.
    const read = await attempt(`deploys ${namespace}`, async () => ({ newest: await readDeployOutcomes(env, namespace) }));
    if (!read) continue;
    deploysRead++;
    if (read.newest) out.push(...deployFindings(namespace, read.newest));
  }
  if (deploysRead === DEPLOY_ROSTER.length) ran.add("deploys");

  // Canon documents a merged pull request left citing a removed, renamed or changed file
  // (src/stale-canon.ts, improvement item 23). A digest finding: it posts no job, and it
  // clears when the document is next written or stops citing the path.
  const staleCanon = await attempt("stale canon", () => readStaleCanon(env, now));
  if (staleCanon) {
    if (staleCanon.complete) ran.add("stale canon");
    out.push(...staleCanon.findings);
    logEvent("WATCHER_STALE_CANON", { message: `WATCHER_STALE_CANON ${staleCanon.note}` });
  }

  // The site configuration, read each pass (src/ops-sites.ts). Unreadable, every site
  // check below cannot run this pass: nothing is probed on a guess, and an open site
  // finding is not cleared on no evidence.
  const config = await attempt("site config", () => readSiteConfig(env.DB));
  const sites: OpsSite[] | null = config ? sitesFrom(config) : null;

  // The configuration against the registered namespaces, both ways.
  const registered = config
    ? await attempt("site map", async () => {
        const { results } = await env.DB.prepare("SELECT namespace FROM namespaces ORDER BY namespace").all<{ namespace: string }>();
        return (results ?? []).map((r) => r.namespace);
      })
    : null;
  if (config && registered) {
    ran.add("site map");
    observed.siteMap = siteMapDrift(registered, config);
    out.push(...siteMapFindings(observed.siteMap));
  }

  // The App's repos against the namespace mapping. Read whole or not at all: a failed
  // or empty read is its own finding and leaves the check un-run (src/unmapped-repos.ts).
  try {
    const repoMap = await readRepoMap(env);
    ran.add("repo map");
    out.push(...unmappedRepoFindings(repoMap));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logEvent("WATCHER_READ_FAILED", { message: `WATCHER_READ_FAILED repo map: ${reason}` }, { level: "error" });
    out.push(repoMapUnreadableFinding(reason));
  }

  // Every configured site, probed in turn. With none configured nothing is probed and
  // the check has nothing to judge. A probe that gets no answer is a result, not a
  // failure of the check; the check fails only if probing itself throws.
  const probes = sites
    ? await attempt("site probes", async () => {
        const results: SiteProbe[] = [];
        for (const site of sites) results.push(await probeSite(site, fetchImpl, now, health));
        return results;
      })
    : null;
  // The previous pass's rings, for "down on two probes in a row". A snapshot that is
  // absent or unreadable (readSnapshot logs it) has no previous probe to compare; a
  // KV read that throws means the check cannot judge, so it does not count as run and
  // an open site-down job is not cleared on no evidence.
  const prev = await attempt("previous snapshot", async () => ({ snapshot: await readSnapshot(env) }));
  if (probes) {
    observed.probes = probes;
    if (prev) {
      ran.add("site probes");
      out.push(...siteDownFindings(prev.snapshot, probes));
    }
  }

  // The live checks (src/live-checks.ts): what capsid/policy/live-checks.md says to
  // look at, read through the probes this pass just made. No document, no check. A site
  // that could not be read this pass leaves the check un-run, so an open finding is not
  // cleared on no evidence.
  if (sites && probes) {
    const live = await attempt("live checks", async () => {
      const config = await readLiveConfig(env.DB);
      const analytics = async () => {
        const credentials = cloudflareCredentials(env);
        if (!credentials.ok) throw new Error(credentials.reason);
        return readWebAnalyticsSites(fetchImpl, credentials.token, credentials.account);
      };
      return liveChecks(config, sites, probes, { fetchImpl, head: (namespace) => defaultBranchHead(env, namespace), analytics }, now);
    });
    if (live) {
      if (live.ran) ran.add("live checks");
      out.push(...live.findings.map(liveFinding));
      // The count beside the verdict: no findings over zero pages read is not a clean bill.
      logEvent("WATCHER_LIVE", { message: `WATCHER_LIVE pages ${live.summary.pages_read}/${live.summary.pages_expected} shas ${live.summary.shas_read}/${live.summary.shas_expected} analytics ${live.summary.analytics_read}/${live.summary.analytics_expected} findings ${live.findings.length}` });
    }
  }

  // The sites that opted into Capsid calling their operator API (src/site-watch.ts): the
  // repair each failing health check maps to, the weekly tools, and the red and green
  // mail. A site whose health could not be read leaves the check un-run, so its open
  // finding is not cleared on no evidence.
  if (config && config.some((c) => c.origin && c.operator)) {
    const repairs = await attempt("site repairs", () => watchSites(env, config, WATCHER_ACTOR, fetchImpl, now));
    if (repairs) {
      if (repairs.complete) ran.add("site repairs");
      out.push(...repairs.findings.map((f) => finding(f.namespace, f.fingerprint, f.headline, f.evidence)));
      if (repairs.lines.length) logEvent("WATCHER_SITE_REPAIRS", { message: `WATCHER_SITE_REPAIRS ${repairs.lines.join(" | ")}` });
    }
  } else if (config) {
    // No site opted in: nothing to judge, so nothing open can be stale.
    ran.add("site repairs");
  }

  // Cloudflare's view of each site: deploys, and hourly errors and CPU time (src/ops-cloudflare.ts).
  // With no token nothing is fetched, each site says why, and the check is not run.
  // With no site configured there is nothing to read, and nothing is fetched.
  if (sites && sites.length > 0) {
    const cf = await attempt("cloudflare", () => readCloudflare(env, sites, fetchImpl, now));
    if (cf) {
      observed.cloudflare = cf.bySite;
      if (cf.ran) ran.add("cloudflare");
      out.push(...siteErrorFindings(sites, cf.bySite), ...siteCpuFindings(sites, cf.bySite));
    } else {
      observed.cloudflare = Object.fromEntries(
        sites.map((s) => [s.namespace, { state: "error", reason: "the Cloudflare read threw this pass (WATCHER_READ_FAILED cloudflare in the log)" } as const])
      );
    }
  }

  // The secret names of each opted-in site's Worker (src/secret-presence.ts), for the
  // Portal's convergence view: names only, set or not, read here because no Portal request
  // calls Cloudflare. Each site's read stands alone and stores its own reason on failure.
  for (const site of config ?? []) {
    if (!site.origin || !site.operator || site.operator.secrets.length === 0 || site.platform !== "cloudflare") continue;
    const read_at = now.toISOString();
    const expected = site.operator.secrets;
    const cfState = observed.cloudflare?.[site.namespace];
    const script = site.script ?? (cfState?.state === "ok" ? cfState.script : null);
    const credentials = cloudflareCredentials(env);
    const stored = !credentials.ok
      ? { state: "error" as const, script, rows: [], reason: credentials.reason, read_at }
      : !script
        ? { state: "error" as const, script: null, rows: [], reason: "the Worker script is not known: name it on the site's row, or let the Cloudflare read resolve it", read_at }
        : await readSecretNames(fetchImpl, credentials.token, credentials.account, script).then(
            (names) => ({ state: "ok" as const, script, rows: secretPresence(expected, names), reason: null, read_at }),
            (err: unknown) => ({ state: "error" as const, script, rows: [], reason: (err instanceof Error ? err.message : String(err)).slice(0, 300), read_at })
          );
    await attempt(`secret names ${site.namespace}`, () => storeSecrets(env, site.namespace, stored));
  }

  // Agents acting out of their usual pattern, from audit_log (src/anomaly.ts, OWASP item
  // 6). A finding only, never a suspension (Dustin, D4 of 2026-10-03).
  // The hook receiver's tool-use rows, on their own series, rule and check (D1 of
  // 2026-10-03), so a failed read of one never holds the other's findings open. The two
  // reads are independent and run together.
  const [actionHours, toolHours] = await Promise.all([
    attempt("agent anomalies", () => readActionHours(env.DB, now, WATCHER_ACTOR)),
    attempt("tool anomalies", () => readToolHours(env.DB, now, WATCHER_ACTOR)),
  ]);
  if (actionHours) {
    ran.add("agent anomalies");
    out.push(...anomalyFindings(actionHours, now));
  }
  if (toolHours) {
    ran.add("tool anomalies");
    out.push(...toolRateFindings(toolHours, now));
  }

  // Each configured site's domain registration, by RDAP (src/domain-expiry.ts): a
  // finding 30 and 7 days before it expires. The check counts as run only when every
  // domain was read, so a failed read never clears an open finding.
  if (config) {
    const domains = [...new Set(config.map((c) => (c.origin ? registrableDomain(c.origin) : null)).filter((d): d is string => d !== null))].sort();
    const read = await attempt("domains", () => readExpiries(env.APP_KV, domains, fetchImpl, now));
    if (read) {
      out.push(...expiryFindings(read.expiries, now));
      if (read.failed.length === 0) ran.add("domains");
      for (const f of read.failed) logEvent("WATCHER_DOMAIN_UNREAD", { message: `${f.domain}: ${f.error}` }, { level: "warn" });
    }
  }

  // The configured packages, for the Portal's Packages view (src/ops-packages.ts).
  // Read, never judged: no finding comes from a package. With none configured nothing
  // is fetched; each package's sources fail on their own inside readPackage.
  const packageConfig = await attempt("package config", () => readPackageConfig(env.DB));
  if (packageConfig) {
    const read = await attempt("packages", async () => {
      const results: PackageSnapshot[] = [];
      for (const cfg of packageConfig) results.push(await readPackage(env, cfg, fetchImpl, now));
      return results;
    });
    if (read) observed.packages = read;
  }

  // The manual steps blocked jobs name with a "check:" line (src/manual-steps.ts): after
  // the secret names above, so a secret set since the last pass is seen on this one. Read,
  // never judged: no finding comes from a step, and the counts go to stale:steps for the
  // inbox and the stale view.
  const steps = await attempt("manual steps", () =>
    checkManualSteps(
      env,
      now,
      liveStepReaders(env, {
        npmVersions: (name) => npmVersions(fetchImpl, name),
        accessAppNames: async () => {
          const credentials = cloudflareCredentials(env);
          if (!credentials.ok) throw new Error(credentials.reason);
          return readAccessAppNames(fetchImpl, credentials.token, credentials.account);
        },
      })
    )
  );
  if (steps && steps.seen.length > 0) logEvent("WATCHER_STEPS_SEEN", { message: `WATCHER_STEPS_SEEN ${steps.note}` });

  return { findings: out, ran, observed };
}
