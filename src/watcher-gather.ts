import { mapLimit } from "./map-limit";
import { attempt, READ_CONCURRENCY, type Pass } from "./watcher-gather-base";
import { gatherPlatform } from "./watcher-gather-platform";
import { readActionHours, anomalyFindings } from "./anomaly";
import { registrableDomain, readExpiries, expiryFindings } from "./domain-expiry";
import { readTlsExpiry, TLS_EXPIRY_KEY } from "./tls-expiry";
import type { Env } from "./env";
import { readLiveConfig, liveChecks, defaultBranchHead } from "./live-checks";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { checkManualSteps, liveStepReaders } from "./manual-steps";
import { readServerErrors } from "./site-traffic";
import {
  cloudflareCredentials,
  readWebAnalyticsSites,
  readCloudflare,
  readSecretNames,
  readAccessAppNames,
} from "./ops-cloudflare";
import { readPackage, npmVersions } from "./ops-packages";
import { readPackageConfig } from "./ops-package-config";
import { readSiteConfig, type OpsSite, sitesFrom, siteMapDrift } from "./ops-sites";
import { probeSite, readSnapshot } from "./ops-snapshot";
import { secretPresence, storeSecrets } from "./secret-presence";
import { watchSites } from "./site-watch";
import { readRepoMap } from "./unmapped-repos";
import { type Gathered, type Observed, WATCHER_ACTOR } from "./watcher";
import type { WatcherCheck } from "./watcher-checks";
import {
  type Finding,
  siteMapFindings,
  unmappedRepoFindings,
  repoMapUnreadableFinding,
  siteDownFindings,
  liveFinding,
  finding,
  siteErrorFindings,
  siteCpuFindings,
} from "./watcher-detect";

// The watcher's reads (src/watcher.ts runs the pass), turned into findings by src/watcher-detect.ts.
// Every read is wrapped so one failing surface does not stop the others: silence reads as health.

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

  const pass: Pass = { env, now, fetchImpl, out, ran, observed };
  const health = await gatherPlatform(pass);

  // The site configuration, read each pass (src/ops-sites.ts). Unreadable, every site
  // check below cannot run this pass: nothing is probed on a guess, and an open site
  // finding is not cleared on no evidence.
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

  // The App's repos against the namespace mapping. Read whole or not at all: a failed
  // or empty read is its own finding and leaves the check un-run (src/unmapped-repos.ts).
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

  // Every configured site, probed in turn. With none configured nothing is probed and
  // the check has nothing to judge. A probe that gets no answer is a result, not a
  // failure of the check; the check fails only if probing itself throws.
  const probes = sites
    ? await attempt("site probes", async () => {
        return mapLimit(sites, READ_CONCURRENCY, (site) => probeSite(site, fetchImpl, now, health));
      })
    : null;
  // The previous pass's rings, for "down on two probes in a row". A snapshot that is
  // absent or unreadable (readSnapshot logs it) has no previous probe to compare; a
  // KV read that throws means the check cannot judge, so it does not count as run and
  // an open site-down job is not cleared on no evidence.
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

  // Every site's health route, and for the sites that opted into Capsid calling their operator API,
  // the repair each failing health check maps to and the weekly tools (src/site-watch.ts); then the
  // red and green mail.
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

  // Cloudflare's view of each site: deploys, and hourly errors and CPU time (src/ops-cloudflare.ts).
  // With no token nothing is fetched, each site says why, and the check is not run.
  // With no site configured there is nothing to read, and nothing is fetched.
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

  // The secret names of each opted-in site's Worker (src/secret-presence.ts), for the
  // Portal's convergence view: names only, set or not, read here because no Portal request
  // calls Cloudflare. Each site's read stands alone and stores its own reason on failure.
  const secretSites = (config ?? []).filter(
    (site) =>
      site.origin &&
      site.operator &&
      site.operator.secrets.length > 0 &&
      site.platform === "cloudflare",
  );
  await mapLimit(secretSites, READ_CONCURRENCY, async (site) => {
    if (!site.operator) return;
    const read_at = now.toISOString();
    const expected = site.operator.secrets;
    const cfState = observed.cloudflare?.[site.namespace];
    const script = site.script ?? (cfState?.state === "ok" ? cfState.script : null);
    const credentials = cloudflareCredentials(env);
    const stored = !credentials.ok
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
    await attempt(`secret names ${site.namespace}`, () =>
      storeSecrets(env, site.namespace, stored),
    );
  });

  // Agents acting out of their usual pattern, from audit_log (src/anomaly.ts, OWASP item
  // 6). A finding only, never a suspension.
  const actionHours = await attempt("agent anomalies", () =>
    readActionHours(env.DB, now, WATCHER_ACTOR),
  );
  if (actionHours) {
    ran.add("agent anomalies");
    out.push(...anomalyFindings(actionHours, now));
  }

  // Each configured site's domain registration, by RDAP (src/domain-expiry.ts): a
  // finding 30 and 7 days before it expires. The check counts as run only when every
  // domain was read, so a failed read never clears an open finding.
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

  // The configured packages, for the Portal's Packages view (src/ops-packages.ts).
  // Read, never judged: no finding comes from a package. With none configured nothing
  // is fetched; each package's sources fail on their own inside readPackage.
  const packageConfig = await attempt("package config", () => readPackageConfig(env.DB));
  if (packageConfig) {
    const read = await attempt("packages", async () => {
      return mapLimit(packageConfig, READ_CONCURRENCY, (cfg) =>
        readPackage(env, cfg, fetchImpl, now),
      );
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
      }),
    ),
  );
  if (steps && steps.seen.length > 0)
    logEvent("WATCHER_STEPS_SEEN", { message: `WATCHER_STEPS_SEEN ${steps.note}` });

  return { findings: out, ran, observed };
}
