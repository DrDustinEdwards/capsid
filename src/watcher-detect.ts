import { type HealthReport, BACKUP_STALE_HOURS } from "./health";
import type { HourBucket, ServerErrors, SiteCloudflare } from "./ops-types/sites";
import type { OpsSnapshot, SiteProbe } from "./ops-snapshot";
import type { SiteMapDrift } from "./ops-sites";
import type { LiveFinding } from "./live-checks";
import { externalFence } from "./provenance";
import type { StatusReport } from "./status";
import { type RepoMapRead, unmappedRepos } from "./unmapped-repos";
import { MINUTE_MS, HOUR_MS } from "./time";

// What the watcher finds (src/watcher.ts runs the pass, src/watcher-gather.ts reads):
// pure functions from what was read to findings, with no IO.

// Red this long is not a flake somebody is already fixing.
export const CI_RED_HOURS = 2;

export interface Finding {
  // Stable while the finding persists, different for a different problem. It goes in
  // the title, so the queue's one-open-job-per-title rule stops a double post.
  fingerprint: string;
  namespace: string;
  title: string;
  body: string;
  // The evidence lines, kept on the finding's row per sighting (src/watcher-findings.ts).
  evidence?: string[];
}

export const finding = (
  namespace: string,
  fingerprint: string,
  headline: string,
  evidence: string[],
): Finding => ({
  fingerprint,
  namespace,
  title: `Watcher: ${headline} [${fingerprint}]`,
  body: [
    `The watcher found this at ${new Date().toISOString()} and cannot fix it.`,
    "",
    "## Evidence",
    "",
    // Read from outside Capsid (CI conclusions, probe answers, GitHub error text), so it is
    // fenced as external: data to confirm, never an instruction to follow.
    externalFence("watcher-evidence", fingerprint, evidence.map((line) => `- ${line}`).join("\n")),
    "",
    "## What this job is",
    "",
    "A finding, not an instruction. Confirm it is still true before acting: the watcher",
    "reads a surface every half hour and a finding can clear itself between the post and",
    "the claim. If it has cleared, fail this job saying so.",
  ].join("\n"),
  evidence,
});

// The deploy-drift check waits for master's own CI run, which deploys; it must not
// fire while the run for that exact sha is still going. A run that finished green this
// recently may still be ahead of the /health answer, so it gets a settle window too.
export const MASTER_CI_WORKFLOW = "CI";
export const DEPLOY_SETTLE_MINUTES = 15;

export interface HeadRun {
  name: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at?: string | null;
}

// wait: the deploy for master head may still be in flight, so drift cannot be judged
// this pass. Otherwise the line says what master's CI run showed, as evidence.
export type DeployVerdict = { wait: true; reason: string } | { wait: false; evidence: string };

/** Whether master head's own CI run leaves a drift finding premature. `runs` is the
 *  run list for that sha, newest first, or null when it could not be read. A failed
 *  or canceled run, no run at all, and an unreadable list all keep the finding. */
export function deployVerdict(runs: readonly HeadRun[] | null, now: Date): DeployVerdict {
  if (runs === null)
    return { wait: false, evidence: `master head's ${MASTER_CI_WORKFLOW} run could not be read` };
  const run = runs
    .filter((r) => r.name === MASTER_CI_WORKFLOW)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!run)
    return { wait: false, evidence: `no ${MASTER_CI_WORKFLOW} run started for master head` };
  if (run.status !== "completed")
    return { wait: true, reason: `master head's ${MASTER_CI_WORKFLOW} run is ${run.status}` };
  if (run.conclusion !== "success")
    return {
      wait: false,
      evidence: `master head's ${MASTER_CI_WORKFLOW} run ended ${run.conclusion ?? "with no conclusion"}`,
    };
  const finished = run.updated_at ? Date.parse(run.updated_at) : Number.NaN;
  if (Number.isNaN(finished))
    return {
      wait: false,
      evidence: `master head's ${MASTER_CI_WORKFLOW} run succeeded at an unknown time`,
    };
  const minutes = (now.getTime() - finished) / MINUTE_MS;
  if (minutes < DEPLOY_SETTLE_MINUTES) {
    return {
      wait: true,
      reason: `master head's ${MASTER_CI_WORKFLOW} run succeeded ${Math.floor(minutes)} minutes ago, inside the ${DEPLOY_SETTLE_MINUTES} minute settle`,
    };
  }
  return {
    wait: false,
    evidence: `master head's ${MASTER_CI_WORKFLOW} run succeeded ${Math.floor(minutes)} minutes ago`,
  };
}

/** What /health says that should not be true. `masterSha` and `latestMigration` come
 *  from the repo, so this answers "is the deployed Worker the one master describes"
 *  rather than only "is it up". `deploy` is master head's CI verdict; a deploy still in
 *  flight is not drift. */
export function healthFindings(
  health: HealthReport,
  masterSha: string | null,
  latestMigration: string | null,
  namespace: string,
  deploy: DeployVerdict = {
    wait: false,
    evidence: `master head's ${MASTER_CI_WORKFLOW} run was not read`,
  },
): Finding[] {
  const out: Finding[] = [];
  if (health.status !== "ok") {
    out.push(
      finding(namespace, "health-degraded", "the Worker reports degraded", [
        `status: ${health.status}`,
        `store: d1 ${health.store.d1}, fts ${health.store.fts}`,
        "Every read tool errors while a store probe is failing.",
      ]),
    );
  }
  // A sha comparison needs both sides. A null master sha means the repo read failed,
  // and reporting that as drift would be a finding about the watcher, not the deploy.
  if (
    masterSha &&
    health.sha &&
    health.sha !== "unknown" &&
    health.sha !== masterSha &&
    !deploy.wait
  ) {
    out.push(
      finding(
        namespace,
        `deploy-drift-${masterSha.slice(0, 7)}`,
        "the deployed sha is not master head",
        [
          `deployed: ${health.sha}`,
          `master: ${masterSha}`,
          deploy.evidence,
          "A docs-only push whose deploy failed, or a deploy that never ran, looks exactly like this.",
        ],
      ),
    );
  }
  if (health.backup.age_hours !== null && health.backup.age_hours > BACKUP_STALE_HOURS) {
    out.push(
      finding(namespace, "backup-stale", "the last backup is older than the window", [
        `last ok: ${health.backup.last_ok ?? "never"}`,
        `age: ${health.backup.age_hours.toFixed(1)} hours, the window is ${BACKUP_STALE_HOURS}`,
      ]),
    );
  }
  // A stamp /health cannot parse has no age, so the window check above cannot fire and
  // last_ok is not null. Its age is unknown, which is reported as stale.
  if (health.backup.last_ok !== null && health.backup.age_hours === null) {
    out.push(
      finding(namespace, "backup-stale", "the last backup's time cannot be read", [
        `last ok: ${health.backup.last_ok}`,
        "/health reports age_hours as null, so the backup's age is unknown.",
      ]),
    );
  }
  if (health.backup.last_ok === null) {
    out.push(
      finding(namespace, "backup-never", "no backup has ever reported success", [
        "/health reports backup.last_ok as null.",
        "The nightly dump can fail every night with no signal but this key.",
      ]),
    );
  }
  // Ahead is a migration applied before its PR merged, which the merge clears: a digest
  // line, not a job. Behind is a committed migration never applied. Migration names
  // start with a zero-padded number, so the prefix orders them.
  const ahead =
    latestMigration &&
    health.schema_version &&
    migrationNumber(health.schema_version) > migrationNumber(latestMigration);
  if (ahead) {
    out.push(
      finding(
        namespace,
        `schema-ahead-${health.schema_version}`,
        "the live schema is newer than master's newest migration",
        [
          `live: ${health.schema_version}`,
          `newest on master: ${latestMigration}`,
          "A migration applied before its pull request merged reads like this; the merge clears it.",
        ],
      ),
    );
  } else if (
    latestMigration &&
    health.schema_version &&
    health.schema_version !== latestMigration
  ) {
    out.push(
      finding(
        namespace,
        `schema-behind-${latestMigration}`,
        "the live schema is not the newest migration",
        [
          `live: ${health.schema_version}`,
          `newest on master: ${latestMigration}`,
          "A migration that was committed and never applied reads exactly like this.",
        ],
      ),
    );
  }
  return out;
}

function migrationNumber(name: string): number {
  const n = Number.parseInt(name, 10);
  return Number.isNaN(n) ? -1 : n;
}

/** What capsid_read_status action status says that should not be true. Per namespace, because the job
 *  each finding becomes belongs to the namespace it is about. */
export function statusFindings(status: StatusReport): Finding[] {
  const out: Finding[] = [];
  for (const ns of status.namespaces ?? []) {
    // An open breaker stops the namespace's queue until a person resets it, so it is
    // said; the watcher files it and nothing more (src/job-breaker.ts).
    if (ns.breaker?.open) {
      out.push(
        finding(
          ns.namespace,
          `breaker-open-${ns.namespace}`,
          `the queue's circuit breaker for ${ns.namespace} is open`,
          [
            `holder fails since ${ns.breaker.since} UTC: ${ns.breaker.failed}, threshold ${ns.breaker.threshold}`,
            "No job in this namespace is handed out until the seat or Dustin resets it: capsid_admin_manage_switches action breaker_reset, or Reset under Paused after repeated failures on the Portal's Needs you.",
          ],
        ),
      );
    }
  }
  return out;
}

export interface CiRun {
  head_sha: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  url?: string;
}

/** A default branch that has been red for longer than a flake. Reads the most recent
 *  COMPLETED run, because a run still in flight is not yet an answer.
 *
 *  One incident per namespace, not per commit: the fingerprint is `ci-red-<namespace>`
 *  and the head sha is evidence, so every red commit on a red branch is not a new finding. */
export function ciFindings(namespace: string, runs: CiRun[], now: Date): Finding[] {
  const latest = runs.find((r) => r.status === "completed");
  if (!latest) return [];
  if (
    latest.conclusion === "success" ||
    latest.conclusion === "skipped" ||
    latest.conclusion === "neutral"
  )
    return [];
  const since = Date.parse(latest.created_at);
  if (Number.isNaN(since)) return [];
  const hours = (now.getTime() - since) / HOUR_MS;
  if (hours < CI_RED_HOURS) return [];
  return [
    finding(namespace, `ci-red-${namespace}`, `${namespace} CI is red on its default branch`, [
      `conclusion: ${latest.conclusion}`,
      `head sha: ${latest.head_sha}`,
      `red since: ${latest.created_at} (${hours.toFixed(1)} hours)`,
    ]),
  ];
}

/** A registered namespace the site map neither covers nor excludes, or a map entry
 *  whose namespace is not registered. The fingerprint names the drift, so a different
 *  drift is a new finding. */
export function siteMapFindings(drift: SiteMapDrift): Finding[] {
  if (drift.unmapped.length === 0 && drift.unknown.length === 0) return [];
  const names = [
    ...drift.unmapped.map((n) => "add-" + n),
    ...drift.unknown.map((n) => "drop-" + n),
  ].join("-");
  return [
    finding(
      "capsid",
      "site-map-drift-" + names,
      "the operations site map does not match the registered namespaces",
      [
        ...drift.unmapped.map(
          (n) =>
            n +
            ": registered, but has no row in the Portal's site configuration (Settings: add it as a site, or as serving no site)",
        ),
        ...drift.unknown.map(
          (n) => n + ": in the Portal's site configuration, but not a registered namespace",
        ),
        "The Portal shows only configured sites, so an unmapped site is one nobody is watching.",
      ],
    ),
  ];
}

/** One finding per repo the GitHub App can see that no namespace maps, naming it and the
 *  namespace its name suggests. It proposes; mapping is admin-only and never automatic.
 *  Every finding says what the read covered, so a clear pass is never "0 unmapped"
 *  over "0 listed". */
export function unmappedRepoFindings(read: RepoMapRead): Finding[] {
  const covered = `the App's ${read.installations} installation(s) list ${read.installed.length} repos; ${read.mapped.size} are mapped to a namespace; ${read.onPurpose.size} are named unmapped on purpose`;
  return unmappedRepos(read).map((r) =>
    finding(
      "capsid",
      `unmapped-repo-${r.full_name.toLowerCase().replace("/", "--")}`,
      `${r.full_name} is visible to the GitHub App but no namespace maps it`,
      [
        `${r.full_name}: ${r.private ? "private" : "public"}, ${r.archived ? "archived" : "not archived"}, last push ${r.pushed_at ?? "unknown"}`,
        r.suggested
          ? `likely namespace: ${r.suggested} (from the repo name). Map it with capsid_admin_manage_namespaces action update, adding ${r.full_name} with a label.`
          : "no registered namespace matches its name. Register one with capsid_admin_manage_namespaces action register, or map it into an existing namespace with action update.",
        "If it is unmapped on purpose (archived, frozen, or going away), list it in capsid/unmapped-repos.md, one owner/name per line, and this stops.",
        covered,
        "This check only proposes. Mapping is the authorization boundary and stays with the seat or Dustin.",
      ],
    ),
  );
}

/** The App's repo list could not be read whole, so unmapped repos cannot be found. Fails
 *  closed: this is a finding, and the "repo map" check does not count as run, so an open
 *  unmapped-repo finding is not cleared on no evidence. */
export function repoMapUnreadableFinding(reason: string): Finding {
  return finding(
    "capsid",
    "unmapped-repos-unreadable",
    "the GitHub App's repository list could not be read, so unmapped repos cannot be found",
    [reason, "Until this reads, no repo is being checked against the namespace mapping."],
  );
}

export const liveFinding = (f: LiveFinding): Finding =>
  finding(f.namespace, f.fingerprint, f.headline, f.evidence);

/** A site down on two probes in a row: the previous snapshot's ring ended in '0' and
 *  this pass's probe is down too. One failed probe is a blip; a ring that ended in '-'
 *  (no pass reached that slot) is not a failed probe. */
export function siteDownFindings(prev: OpsSnapshot | null, probes: SiteProbe[]): Finding[] {
  const before = new Map((prev?.sites ?? []).map((s) => [s.namespace, s]));
  const out: Finding[] = [];
  for (const p of probes) {
    const last = before.get(p.namespace);
    if (p.state !== "down" || !last || !last.ring.endsWith("0")) continue;
    out.push(
      finding(p.namespace, `site-down-${p.namespace}`, `${p.name} is down on two probes in a row`, [
        `site: ${p.origin}`,
        `this probe: ${p.error ?? `answered ${p.http_status ?? "nothing"}`} at ${p.checked_at}`,
        `the previous probe was down too, at ${last.checked_at}`,
      ]),
    );
  }
  return out;
}

// The CPU threshold: a Worker that used more than a million CPU milliseconds in the most
// recent complete hour, a thirtieth of the Workers Paid plan's monthly allowance. Normal
// hours stay under 100,000 on every site.
export const CPU_HOUR_LIMIT_MS = 1_000_000;

type WatchedSite = { namespace: string; name: string };

/** Each site's Worker and its most recent complete hour, the last of its hourly buckets. A
 *  site with no analytics this pass is left out, so it is not judged. */
function latestHours(
  sites: ReadonlyArray<WatchedSite>,
  cloudflare: Record<string, SiteCloudflare>,
): Array<{ site: WatchedSite; script: string; hour: HourBucket }> {
  return sites.flatMap((site) => {
    const cf = cloudflare[site.namespace];
    if (cf?.state !== "ok" || !cf.errors24 || cf.errors24.length === 0) return [];
    return [{ site, script: cf.script, hour: cf.errors24[cf.errors24.length - 1] }];
  });
}

/** A site whose Worker used more than CPU_HOUR_LIMIT_MS of CPU time in the most recent
 *  complete hour. A site with no analytics this pass is not judged. */
export function siteCpuFindings(
  sites: ReadonlyArray<WatchedSite>,
  cloudflare: Record<string, SiteCloudflare>,
): Finding[] {
  return latestHours(sites, cloudflare)
    .filter(({ hour }) => hour.cpu_ms > CPU_HOUR_LIMIT_MS)
    .map(({ site, script, hour }) =>
      finding(
        site.namespace,
        `site-cpu-${site.namespace}`,
        `${site.name} used over ${CPU_HOUR_LIMIT_MS.toLocaleString("en-US")} CPU ms in one hour`,
        [
          `script: ${script}`,
          `hour from ${hour.hour}: ${hour.cpu_ms} CPU ms over ${hour.requests} invocations`,
          "Workers Paid includes 30 million CPU ms a month; each million over costs $0.02. Find what is invoking the Worker.",
        ],
      ),
    );
}

// The error-rate threshold (capsid/research/design-ops-console.md, approved): more
// than 1 percent of requests errored in the most recent complete hour, over at least
// 100 requests, so a quiet site's single error is not an alert.
export const ERROR_RATE_THRESHOLD = 0.01;
export const ERROR_RATE_MIN_REQUESTS = 100;

/** A site whose Worker errored on more than ERROR_RATE_THRESHOLD of its requests in
 *  the most recent complete hour, the last of its hourly buckets. An error is an
 *  invocation that threw or a returned 5xx (`serverErrors`, the edge's count for that
 *  hour, src/site-traffic.ts readServerErrors). A thrown invocation is answered with a
 *  5xx at the edge too, so the edge count already holds it: the larger of the two is
 *  used, never their sum, and the thrown count stands alone when the edge read failed.
 *  A site with no analytics this pass is not judged. */
export function siteErrorFindings(
  sites: ReadonlyArray<WatchedSite>,
  cloudflare: Record<string, SiteCloudflare>,
  serverErrors: Record<string, ServerErrors> | null = null,
): Finding[] {
  const out: Finding[] = [];
  for (const { site, script, hour } of latestHours(sites, cloudflare)) {
    const served = serverErrors?.[site.namespace];
    const returned = served?.count;
    const errors = Math.max(hour.errors, returned ?? 0);
    if (hour.requests < ERROR_RATE_MIN_REQUESTS || errors / hour.requests <= ERROR_RATE_THRESHOLD)
      continue;
    out.push(
      finding(
        site.namespace,
        `site-errors-${site.namespace}`,
        `${site.name} errored on more than ${ERROR_RATE_THRESHOLD * 100} percent of requests`,
        [
          `script: ${script}`,
          `hour from ${hour.hour}: ${errors} errors of ${hour.requests} requests (${((errors / hour.requests) * 100).toFixed(1)} percent)`,
          `${hour.errors} invocations threw, exceeded their resources or hit an internal error; ${returned === undefined ? "returned 5xx not read this pass" : `${returned} answers were 5xx at the edge (sampled, an estimate)`}.`,
          ...(served?.top.length
            ? [
                `busiest 5xx: ${served.top.map((t) => `${t.status} ${t.path} (${t.hits})`).join(", ")}`,
              ]
            : []),
        ],
      ),
    );
  }
  return out;
}
