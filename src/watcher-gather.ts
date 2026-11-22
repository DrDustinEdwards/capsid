import { mapLimit } from "./map-limit";
import { readActionHours, anomalyFindings } from "./anomaly";
import { DEPLOY_ROSTER, readDeployOutcomes, deployFindings } from "./deploy-outcomes";
import { registrableDomain, readExpiries, expiryFindings } from "./domain-expiry";
import { readTlsExpiry, TLS_EXPIRY_KEY } from "./tls-expiry";
import type { Env } from "./env";
import { defaultBranchSha, ciStatus, listRepoTree } from "./github";
import { healthReport } from "./health";
import { readLiveConfig, liveChecks, defaultBranchHead } from "./live-checks";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { checkManualSteps, liveStepReaders } from "./manual-steps";
import { readServerErrors } from "./site-traffic";
import {
  cloudflareCredentials,
  readWebAnalyticsSites,
  readCloudflare,
  readAccessAppNames,
} from "./ops-cloudflare";
import { readPackage, npmVersions } from "./ops-packages";
import { readPackageConfig } from "./ops-package-config";
import { readSiteConfig, type OpsSite, sitesFrom, siteMapDrift } from "./ops-sites";
import { probeSite, readSnapshot } from "./ops-snapshot";
import { OFFACCOUNT_REPORT_KEY, OFFACCOUNT_SITES, OFFACCOUNT_SOURCES } from "./offaccount";
import { readResources } from "./system-facts-store";
import { APP_ROSTER } from "./roster";
import { storeSecrets } from "./secret-presence";
import { readSiteSecrets } from "./watcher-secrets";
import { watchSites } from "./site-watch";
import { readStaleCanon } from "./stale-canon";
import { capsidStatus } from "./status";
import { readRepoMap } from "./unmapped-repos";
import { type Gathered, type Observed, WATCHER_ACTOR } from "./watcher";
import type { WatcherCheck } from "./watcher-checks";
import {
  type Finding,
  type DeployVerdict,
  deployVerdict,
  healthFindings,
  statusFindings,
  type CiRun,
  ciFindings,
  siteMapFindings,
  unmappedRepoFindings,
  repoMapUnreadableFinding,
  siteDownFindings,
  liveFinding,
  finding,
  siteErrorFindings,
  siteCpuFindings,
} from "./watcher-detect";
import {
  BACKUPS_REPO_LABEL,
  type OffaccountReport,
  type WorkflowRun,
  offaccountFindings,
  offaccountDrillFindings,
  offaccountCoverageFindings,
  parseDumpStamp,
} from "./watcher-offaccount";

// The watcher's reads (src/watcher.ts runs the pass), turned into findings by src/watcher-detect.ts.
// Every read is wrapped so one failing surface does not stop the others: silence reads as health.

// How many reads of one roster run together: the pass waits on GitHub and Cloudflare, so
// one at a time spent most of the tick's four minutes (src/map-limit.ts).
const READ_CONCURRENCY = 6;

async function attempt<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    logEvent(
      "WATCHER_READ_FAILED",
      {
        message: `WATCHER_READ_FAILED ${what}: ${errorMessage(err)}`,
      },
      { level: "error" },
    );
    return null;
  }
}

// A run id as an ISO time, or null for none or a name that is not a run id.
const dumpTime = (run: string | null): string | null =>
  run ? (parseDumpStamp(run)?.toISOString() ?? null) : null;

const basename = (path: string): string => path.split("/").filter(Boolean).pop() ?? "";

/** The newest migration filename on master, compared against the live schema_version.
 *  Sorted by name: the files are zero-padded. */
export function newestMigration(names: string[]): string | null {
  const sql = names.filter((n) => n.endsWith(".sql")).sort();
  return sql.length ? sql[sql.length - 1] : null;
}

export async function gatherFindings(
  env: Env,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<Gathered> {
  const out: Finding[] = [];
  const ran = new Set<WatcherCheck>();
  const observed: Observed = {
    health: null,
    offaccount: null,
    ci: [],
    siteMap: null,
    probes: null,
  };

  // No casts on a repo reader's result: attempt() swallows a throw, so a cast would hide
  // a check that never runs. test/watcher-gather.test.ts drives both reads end to end.
  const health = await attempt("health", () => healthReport(env));
  observed.health = health;
  if (health) {
    ran.add("health");
    const head = await attempt("master head", () => defaultBranchSha(env, "capsid"));
    // Master head's own CI run, read only when the deployed sha differs. A deploy
    // still in flight leaves the check un-judged: nothing posted, no open finding cleared.
    let deploy: DeployVerdict | undefined;
    if (head !== null && health.sha && health.sha !== "unknown" && health.sha !== head) {
      const runs = await attempt(
        "head ci run",
        async () => (await ciStatus(env, "capsid", undefined, { ref: head, limit: 10 })).runs,
      );
      deploy = deployVerdict(runs, now);
    }
    if (head !== null && !deploy?.wait) ran.add("master head");
    // An object, so a tree with no migrations (null) differs from a failed read (null).
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

  // The Amazon copy, as capsid-backups' watch.yml last reported it (src/offaccount.ts).
  // An unreadable report skips the check: "cannot see the copy" is not "the copy is dead".
  // The copy workflow's runs ("backups" mapping) are evidence only; a failed read leaves
  // them out and the age findings still fire.
  const report = await attempt("offaccount report", async () => ({
    value: await env.APP_KV.get<OffaccountReport>(OFFACCOUNT_REPORT_KEY, "json"),
  }));
  const copyRuns: WorkflowRun[] | null = await attempt(
    "offaccount runs",
    async () =>
      (await ciStatus(env, "capsid", BACKUPS_REPO_LABEL, { workflow: "offaccount.yml", limit: 5 }))
        .runs,
  );
  const lastCopy = copyRuns?.find((r) => r.status === "completed") ?? null;
  if (report) {
    ran.add("offaccount");
    out.push(...offaccountFindings("capsid", OFFACCOUNT_SITES, report.value, lastCopy, now));
  }
  // The restore drill's own runs, so a monthly drill is not pushed out by the nightly ones.
  const drillRuns: WorkflowRun[] | null = await attempt(
    "offaccount drill",
    async () =>
      (await ciStatus(env, "capsid", BACKUPS_REPO_LABEL, { workflow: "drill.yml", limit: 10 }))
        .runs,
  );
  if (drillRuns) {
    ran.add("offaccount drill");
    out.push(...offaccountDrillFindings("capsid", drillRuns, now));
  }
  // Every D1 database a Worker binds against the ones copied, from the nightly resources
  // model. Before the first build there is nothing to compare, so the check does not run.
  const resources = await attempt("offaccount coverage", () => readResources(env));
  if (resources) {
    ran.add("offaccount coverage");
    out.push(
      ...offaccountCoverageFindings(
        "capsid",
        OFFACCOUNT_SITES.map((s) => OFFACCOUNT_SOURCES[s].database),
        resources.databases,
      ),
    );
  }
  const run = (r: WorkflowRun | null | undefined) =>
    r ? { at: r.created_at ?? null, conclusion: r.conclusion ?? null, url: r.url ?? null } : null;
  if (report) {
    observed.offaccount = {
      reported_at: report.value?.received_at ?? null,
      sites: OFFACCOUNT_SITES.map((site) => ({
        site,
        newest: dumpTime(report.value?.sites[site]?.newest ?? null),
      })),
      last_run: run(lastCopy),
      last_drill: run(
        drillRuns?.find((r) => r.status === "completed" && r.conclusion === "success"),
      ),
    };
  }

  // The ci check counts as run only when every roster repo was read: ownership is per
  // check, not per repo, so an unread repo must not let the others' pass clear its incident.
  let ciRead = 0;
  const ciRuns = await mapLimit(APP_ROSTER, READ_CONCURRENCY, (namespace) =>
    attempt(
      `ci ${namespace}`,
      async (): Promise<CiRun[]> => (await ciStatus(env, namespace, undefined, { limit: 5 })).runs,
    ),
  );
  APP_ROSTER.forEach((namespace, i) => {
    const runs = ciRuns[i] ?? null;
    if (runs) {
      ciRead++;
      out.push(...ciFindings(namespace, runs, now));
    }
    const latest = runs?.find((r) => r.status === "completed") ?? runs?.[0] ?? null;
    observed.ci.push({
      namespace,
      latest: latest
        ? {
            head_sha: latest.head_sha,
            status: latest.status,
            conclusion: latest.conclusion,
            created_at: latest.created_at,
            url: latest.url ?? null,
          }
        : null,
    });
  });
  if (ciRead === APP_ROSTER.length) ran.add("ci");

  // What became of each roster repo's newest deploys (src/deploy-outcomes.ts): a rollback
  // is a finding. Counts as run only when every repo was read, so a failed read never clears one.
  let deploysRead = 0;
  const deployReads = await mapLimit(
    DEPLOY_ROSTER,
    READ_CONCURRENCY,
    // Wrapped, since a repo with no deploy yet reads as null and a failed read does too.
    ({ key, namespace, selector, workflow }) =>
      attempt(`deploys ${key}`, async () => ({
        newest: await readDeployOutcomes(env, namespace, selector, workflow),
      })),
  );
  DEPLOY_ROSTER.forEach(({ key, namespace }, i) => {
    const read = deployReads[i];
    if (!read) return;
    deploysRead++;
    if (read.newest) out.push(...deployFindings(namespace, read.newest, key));
  });
  if (deploysRead === DEPLOY_ROSTER.length) ran.add("deploys");

  // Canon documents a merged pull request left citing a removed, renamed or changed file
  // (src/stale-canon.ts): a digest finding, no job, cleared when the document is rewritten.
  const staleCanon = await attempt("stale canon", () => readStaleCanon(env, now));
  if (staleCanon) {
    if (staleCanon.complete) ran.add("stale canon");
    out.push(...staleCanon.findings);
    logEvent("WATCHER_STALE_CANON", { message: `WATCHER_STALE_CANON ${staleCanon.note}` });
  }

  // The site configuration (src/ops-sites.ts). Unreadable, no site check runs this pass:
  // nothing is probed on a guess, and an open site finding is not cleared on no evidence.
  const config = await attempt("site config", () => readSiteConfig(env.DB));
  const sites: OpsSite[] | null = config ? sitesFrom(config) : null;

  // The configuration against the registered namespaces, both ways.
  const registered = config
    ? await attempt("site map", async () => {
        const { results } = await env.DB.prepare(
          "SELECT namespace FROM namespaces ORDER BY namespace",
        ).all<{ namespace: string }>();
        return (results ?? []).map((r) => r.namespace);
      })
    : null;
  if (config && registered) {
    ran.add("site map");
    observed.siteMap = siteMapDrift(registered, config);
    out.push(...siteMapFindings(observed.siteMap));
  }

  // The App's repos against the namespace mapping, read whole or not at all: a failed or
  // empty read is its own finding and leaves the check un-run (src/unmapped-repos.ts).
  try {
    const repoMap = await readRepoMap(env);
    ran.add("repo map");
    out.push(...unmappedRepoFindings(repoMap));
  } catch (err) {
    const reason = errorMessage(err);
    logEvent(
      "WATCHER_READ_FAILED",
      { message: `WATCHER_READ_FAILED repo map: ${reason}` },
      { level: "error" },
    );
    out.push(repoMapUnreadableFinding(reason));
  }

  // Every configured site, probed in turn; none configured, nothing to judge. A probe
  // with no answer is a result; the check fails only if probing itself throws.
  const probes = sites
    ? await attempt("site probes", async () => {
        return mapLimit(sites, READ_CONCURRENCY, (site) => probeSite(site, fetchImpl, now, health));
      })
    : null;
  // The previous pass's rings, for "down on two probes in a row". An absent snapshot has
  // nothing to compare; a KV read that throws leaves the check un-run, so an open
  // site-down job is not cleared on no evidence.
  const prev = await attempt("previous snapshot", async () => ({
    snapshot: await readSnapshot(env),
  }));
  if (probes) {
    observed.probes = probes;
    if (prev) {
      ran.add("site probes");
      out.push(...siteDownFindings(prev.snapshot, probes));
    }
  }

  // The live checks (src/live-checks.ts): what capsid/policy/live-checks.md says to look
  // at, read through this pass's probes. No document, no check; an unread site leaves the
  // check un-run, so an open finding is not cleared on no evidence.
  if (sites && probes) {
    const live = await attempt("live checks", async () => {
      const config = await readLiveConfig(env.DB);
      const analytics = async () => {
        const credentials = cloudflareCredentials(env);
        if (!credentials.ok) throw new Error(credentials.reason);
        return readWebAnalyticsSites(fetchImpl, credentials.token, credentials.account);
      };
      return liveChecks(
        config,
        sites,
        probes,
        { fetchImpl, head: (namespace) => defaultBranchHead(env, namespace), analytics },
        now,
      );
    });
    if (live) {
      if (live.ran) ran.add("live checks");
      out.push(...live.findings.map(liveFinding));
      // The count beside the verdict: no findings over zero pages read is not a clean bill.
      logEvent("WATCHER_LIVE", {
        message: `WATCHER_LIVE pages ${live.summary.pages_read}/${live.summary.pages_expected} shas ${live.summary.shas_read}/${live.summary.shas_expected} analytics ${live.summary.analytics_read}/${live.summary.analytics_expected} findings ${live.findings.length}`,
      });
    }
  }

  // Every site's health route, and for the sites that opted into Capsid calling their
  // operator API, the repair each failing health check maps to and the weekly tools
  // (src/site-watch.ts); then the red and green mail. A site whose health could not be read
  // leaves the check un-run, so its open finding is not cleared on no evidence.
  if (config && config.some((c) => c.origin && (c.operator || c.health_path))) {
    const repairs = await attempt("site repairs", () =>
      watchSites(env, config, WATCHER_ACTOR, fetchImpl, now),
    );
    if (repairs) {
      if (repairs.complete) ran.add("site repairs");
      out.push(
        ...repairs.findings.map((f) => finding(f.namespace, f.fingerprint, f.headline, f.evidence)),
      );
      if (repairs.lines.length)
        logEvent("WATCHER_SITE_REPAIRS", {
          message: `WATCHER_SITE_REPAIRS ${repairs.lines.join(" | ")}`,
        });
    }
  } else if (config) {
    // No site to read: nothing to judge, so nothing open can be stale.
    ran.add("site repairs");
  }

  // Cloudflare's view of each site: deploys, hourly errors and CPU time (src/ops-cloudflare.ts).
  // With no token or no site nothing is fetched (each site says why) and the check is not run.
  if (sites && sites.length > 0) {
    const cf = await attempt("cloudflare", () => readCloudflare(env, sites, fetchImpl, now));
    if (cf) {
      observed.cloudflare = cf.bySite;
      if (cf.ran) ran.add("cloudflare");
      // Returned 5xx, read apart so a failed edge read leaves the thrown count standing.
      const serverErrors = cf.ran
        ? await attempt("cloudflare 5xx", () => readServerErrors(env, sites, fetchImpl, now))
        : null;
      out.push(
        ...siteErrorFindings(sites, cf.bySite, serverErrors),
        ...siteCpuFindings(sites, cf.bySite),
      );
    } else {
      observed.cloudflare = Object.fromEntries(
        sites.map((s) => [
          s.namespace,
          {
            state: "error",
            reason:
              "the Cloudflare read threw this pass (WATCHER_READ_FAILED cloudflare in the log)",
          } as const,
        ]),
      );
    }
  }

  // Each opted-in site's Worker secret names, set or not (src/secret-presence.ts), for the
  // Portal's convergence view; read here because no Portal request calls Cloudflare.
  const secretSites = (config ?? []).filter(
    (site) =>
      site.origin &&
      site.operator &&
      site.operator.secrets.length > 0 &&
      site.platform === "cloudflare",
  );
  await mapLimit(secretSites, READ_CONCURRENCY, async (site) => {
    if (!site.operator) return;
    const stored = await readSiteSecrets(env, site, observed.cloudflare, now, fetchImpl);
    await attempt(`secret names ${site.namespace}`, () =>
      storeSecrets(env, site.namespace, stored),
    );
  });

  // Agents acting out of pattern, from audit_log (src/anomaly.ts): a finding, never a suspension.
  const actionHours = await attempt("agent anomalies", () =>
    readActionHours(env.DB, now, WATCHER_ACTOR),
  );
  if (actionHours) {
    ran.add("agent anomalies");
    out.push(...anomalyFindings(actionHours, now));
  }

  // Each site's domain registration, by RDAP (src/domain-expiry.ts): a finding 30 and 7
  // days before expiry. Run only when every domain was read, so a failure clears nothing.
  if (config) {
    const domains = [
      ...new Set(
        config
          .map((c) => (c.origin ? registrableDomain(c.origin) : null))
          .filter((d): d is string => d !== null),
      ),
    ].sort();
    const read = await attempt("domains", () => readExpiries(env.APP_KV, domains, fetchImpl, now));
    if (read) {
      observed.expiry = {
        tls: null,
        ...observed.expiry,
        domains: { read_at: now.toISOString(), domains: read.expiries, failed: read.failed },
      };
      out.push(...expiryFindings(read.expiries, now));
      if (read.failed.length === 0) ran.add("domains");
      for (const f of read.failed)
        logEvent(
          "WATCHER_DOMAIN_UNREAD",
          { message: `${f.domain}: ${f.error}` },
          { level: "warn" },
        );
    }
    // Each Cloudflare-hosted site's TLS certificate (src/tls-expiry.ts): kept in KV for the
    // push, which alerts at 21 and 3 days, and shown in the snapshot. No finding. A host that could not be read keeps
    // its last stored date, so a failed read never drops an expiry the push still needs.
    const tls = await attempt("tls", () => readTlsExpiry(env, config, fetchImpl, now));
    if (tls) {
      const stored =
        ((await env.APP_KV.get(TLS_EXPIRY_KEY, "json")) as typeof tls | null)?.hosts ?? [];
      const kept = stored.filter((h) => tls.failed.some((f) => f.host === h.host));
      const merged = { ...tls, hosts: [...tls.hosts, ...kept] };
      await env.APP_KV.put(TLS_EXPIRY_KEY, JSON.stringify(merged));
      observed.expiry = { domains: null, ...observed.expiry, tls: merged };
      for (const f of tls.failed)
        logEvent("WATCHER_TLS_UNREAD", { message: `${f.host}: ${f.error}` }, { level: "warn" });
    }
  }

  // The configured packages, for the Portal's Packages view (src/ops-packages.ts): read,
  // never judged. None configured, nothing fetched; each source fails on its own.
  const packageConfig = await attempt("package config", () => readPackageConfig(env.DB));
  if (packageConfig) {
    const read = await attempt("packages", async () => {
      return mapLimit(packageConfig, READ_CONCURRENCY, (cfg) =>
        readPackage(env, cfg, fetchImpl, now),
      );
    });
    if (read) observed.packages = read;
  }

  // The manual steps blocked jobs name with a "check:" line (src/manual-steps.ts), after
  // the secret names so a secret set since the last pass is seen. Read, never judged; the
  // counts go to stale:steps for the inbox and the stale view.
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
      }),
    ),
  );
  if (steps && steps.seen.length > 0)
    logEvent("WATCHER_STEPS_SEEN", { message: `WATCHER_STEPS_SEEN ${steps.note}` });

  return { findings: out, ran, observed };
}
