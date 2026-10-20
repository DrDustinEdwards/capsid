import type { Env } from "./env";
import type { Agent } from "./agents";
import { noFlags } from "./agents-schema";
import { BACKUP_STALE_HOURS, healthReport, type HealthReport } from "./health";
import { ciStatus, defaultBranchSha, listRepoTree } from "./github";
import { capsidStatus, type StatusReport } from "./status";
import { APP_ROSTER } from "./roster";
import { postJob } from "./jobs";
import { OPEN_JOB_STATUSES } from "./jobs-schema";
import { markJobFailed, readJob } from "./jobs-transition";
import { CLEARED_SUMMARY, d1FindingMemory, onSighting, type FindingMemory, type FindingRow } from "./watcher-findings";
import { readRepoMap, unmappedRepos, type RepoMapRead } from "./unmapped-repos";
import { readSiteConfig, siteMapDrift, sitesFrom, type OpsSite, type SiteMapDrift } from "./ops-sites";
import { npmVersions, readPackage, readPackageConfig, weekStatement } from "./ops-packages";
import { cloudflareCredentials, readAccessAppNames, readCloudflare, readSecretNames, readWebAnalyticsSites } from "./ops-cloudflare";
import { checkManualSteps, liveStepReaders } from "./manual-steps";
import { secretPresence, storeSecrets } from "./secret-presence";
import { defaultBranchHead, liveChecks, readLiveConfig, type LiveFinding } from "./live-checks";
import type { PackageSnapshot, SiteCloudflare } from "./ops-types";
import { externalFence } from "./provenance";
import { anomalyFindings, readActionHours, readToolHours, toolRateFindings } from "./anomaly";
import { archiveRevokedAgents } from "./agents-archive";
import { expiryFindings, readExpiries, registrableDomain } from "./domain-expiry";
import { DEPLOY_ROSTER, deployFindings, readDeployOutcomes } from "./deploy-outcomes";
import { readStaleCanon } from "./stale-canon";
import {
  buildSnapshot,
  probeSite,
  readSnapshot,
  writeSnapshot,
  type CiObservation,
  type MirrorObservation,
  type OpsSnapshot,
  type SiteProbe,
} from "./ops-snapshot";
import { logEvent } from "./log";
import { watchSites } from "./site-watch";

// The watcher looks at the surface every half hour and, when something is wrong,
// posts a job. It holds no blast-radius flag, cannot claim a job and cannot fix
// anything. A watcher that could act on what it found would be an unattended agent
// deciding at 03:00 what to do about a red default branch, so it writes the finding
// down with the evidence and a named caller picks it up.
//
// Deduplication has two layers. The queue's own rule: `post` refuses a duplicate
// while a job with the same (namespace, title) is open, and the title carries the
// fingerprint. And the watcher's memory of each finding across jobs
// (src/watcher-findings.ts, the watcher_findings table): an open job alone forgot a
// finding the moment a person superseded or failed its job, and the next pass filed it
// again. The row remembers that a person ended it, and a cleared finding stays quiet
// for REOPEN_QUIET_MS before it may be filed again.

const WATCHER_NAME = "watcher";
export const WATCHER_ACTOR = `agent:${WATCHER_NAME}`;

const WATCHER_CADENCE_KEY = "watcher:cadence-minutes";
export const WATCHER_LAST_KEY = "watcher:last";

// KV-configurable. The tick runs every five minutes, so all but one invocation in six
// returns after a single KV read.
export const DEFAULT_CADENCE_MINUTES = 30;

// The floor. Zero or a negative number would run every check on every tick, which
// turns a bounded cost into an unbounded one, so an unusable value falls back rather
// than being obeyed.
const MIN_CADENCE_MINUTES = 5;

// Red this long is not a flake somebody is already fixing.
export const CI_RED_HOURS = 2;

// The off-account mirror's window, and it is not BACKUP_STALE_HOURS.
//
// BACKUP_STALE_HOURS is the local dump, measured from a key this Worker writes
// itself. This measures the newest dump present in the backups repo
// (MIRROR_REPO_LABEL, below), which this Worker only observes. The mirror's schedule
// lives in that repo and can change without this one hearing, so one constant
// standing for both would go wrong silently the day it does.
//
// 36 hours is the daily cadence plus slack. The newest dump is stamped at the backup
// cron's 09:00 UTC and the mirror picks it up hours later, so just before 09:00 UTC
// the freshest possible dump is already about 24 hours old before the mirror has run.
// A tighter window would fire every morning.
export const MIRROR_STALE_HOURS = 36;

// The repo is never named in this module: it is resolved from the capsid namespace's
// mapping, which is the authorization boundary. A hardcoded owner/name would be a
// second copy of that mapping outside the boundary.
const MIRROR_REPO_LABEL = "backups";
export const MIRROR_DUMP_PREFIX = "backups/json";

// How many findings one pass will post. If every check fires at once, the queue gets
// ten jobs and the rest are found again next pass, which is better than a tick that
// posts fifty and times out.
export const MAX_FINDINGS_PER_PASS = 10;

// The watcher's identity inside the Worker, matching the minted `watcher` role in
// scripts/mint-agents.mjs (every namespace, write, `capsid_work_jobs.post`, no flags), so the
// credential a person can mint and the identity the tick uses are the same authority.
// Spelled here because the tick has no bearer token to present.
// test/watcher.test.ts fails if they drift.
export function watcherAgent(): Agent {
  return {
    id: WATCHER_ACTOR,
    name: WATCHER_NAME,
    kind: "cron",
    actor: WATCHER_ACTOR,
    scopes: {
      namespaces: "*",
      repos: [],
      tools: ["capsid_work_jobs", "capsid_work_jobs.post"],
      grants: ["write"],
      flags: noFlags(),
    },
    admin: false,
    row: null,
  };
}

export async function cadenceMinutes(env: Env): Promise<number> {
  try {
    const raw = await env.APP_KV.get(WATCHER_CADENCE_KEY);
    if (raw === null) return DEFAULT_CADENCE_MINUTES;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < MIN_CADENCE_MINUTES) return DEFAULT_CADENCE_MINUTES;
    return Math.floor(parsed);
  } catch {
    // An unreadable store means the default.
    return DEFAULT_CADENCE_MINUTES;
  }
}

export type DueVerdict = { due: true; reason: string } | { due: false; reason: string };

export function passDue(lastIso: string | null, minutes: number, now: Date): DueVerdict {
  if (!lastIso) return { due: true, reason: "the watcher has not run yet." };
  const last = Date.parse(lastIso);
  // A corrupt stamp runs the pass: an extra pass is cheap, a watcher that silently
  // stopped is not.
  if (Number.isNaN(last)) return { due: true, reason: `last-run stamp '${lastIso}' does not parse; running rather than blocking.` };
  const elapsed = (now.getTime() - last) / 60000;
  if (elapsed < minutes) return { due: false, reason: `${Math.floor(elapsed)} of ${minutes} minutes since the last pass.` };
  return { due: true, reason: `${Math.floor(elapsed)} minutes since the last pass, cadence is ${minutes}.` };
}

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

const finding = (namespace: string, fingerprint: string, headline: string, evidence: string[]): Finding => ({
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

// The deploy-drift check waits for master's own CI run, which deploys. On 2026-10-10
// it fired twice (a160f99, e654650) while the CI run for that exact sha was still
// running, and both deployed green minutes later. A run that finished green this
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
 *  or cancelled run, no run at all, and an unreadable list all keep the finding. */
export function deployVerdict(runs: readonly HeadRun[] | null, now: Date): DeployVerdict {
  if (runs === null) return { wait: false, evidence: `master head's ${MASTER_CI_WORKFLOW} run could not be read` };
  const run = runs
    .filter((r) => r.name === MASTER_CI_WORKFLOW)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!run) return { wait: false, evidence: `no ${MASTER_CI_WORKFLOW} run started for master head` };
  if (run.status !== "completed") return { wait: true, reason: `master head's ${MASTER_CI_WORKFLOW} run is ${run.status}` };
  if (run.conclusion !== "success") return { wait: false, evidence: `master head's ${MASTER_CI_WORKFLOW} run ended ${run.conclusion ?? "with no conclusion"}` };
  const finished = run.updated_at ? Date.parse(run.updated_at) : Number.NaN;
  if (Number.isNaN(finished)) return { wait: false, evidence: `master head's ${MASTER_CI_WORKFLOW} run succeeded at an unknown time` };
  const minutes = (now.getTime() - finished) / 60_000;
  if (minutes < DEPLOY_SETTLE_MINUTES) {
    return { wait: true, reason: `master head's ${MASTER_CI_WORKFLOW} run succeeded ${Math.floor(minutes)} minutes ago, inside the ${DEPLOY_SETTLE_MINUTES} minute settle` };
  }
  return { wait: false, evidence: `master head's ${MASTER_CI_WORKFLOW} run succeeded ${Math.floor(minutes)} minutes ago` };
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
  deploy: DeployVerdict = { wait: false, evidence: `master head's ${MASTER_CI_WORKFLOW} run was not read` }
): Finding[] {
  const out: Finding[] = [];
  if (health.status !== "ok") {
    out.push(
      finding(namespace, "health-degraded", "the Worker reports degraded", [
        `status: ${health.status}`,
        `store: d1 ${health.store.d1}, fts ${health.store.fts}`,
        "Every read tool errors while a store probe is failing.",
      ])
    );
  }
  // A sha comparison needs both sides. A null master sha means the repo read failed,
  // and reporting that as drift would be a finding about the watcher, not the deploy.
  if (masterSha && health.sha && health.sha !== "unknown" && health.sha !== masterSha && !deploy.wait) {
    out.push(
      finding(namespace, `deploy-drift-${masterSha.slice(0, 7)}`, "the deployed sha is not master head", [
        `deployed: ${health.sha}`,
        `master: ${masterSha}`,
        deploy.evidence,
        "A docs-only push whose deploy failed, or a deploy that never ran, looks exactly like this.",
      ])
    );
  }
  if (health.backup.age_hours !== null && health.backup.age_hours > BACKUP_STALE_HOURS) {
    out.push(
      finding(namespace, "backup-stale", "the last backup is older than the window", [
        `last ok: ${health.backup.last_ok ?? "never"}`,
        `age: ${health.backup.age_hours.toFixed(1)} hours, the window is ${BACKUP_STALE_HOURS}`,
      ])
    );
  }
  // A stamp /health cannot parse has no age, so the window check above cannot fire and
  // last_ok is not null. Its age is unknown, which is reported as stale.
  if (health.backup.last_ok !== null && health.backup.age_hours === null) {
    out.push(
      finding(namespace, "backup-stale", "the last backup's time cannot be read", [
        `last ok: ${health.backup.last_ok}`,
        "/health reports age_hours as null, so the backup's age is unknown.",
      ])
    );
  }
  if (health.backup.last_ok === null) {
    out.push(
      finding(namespace, "backup-never", "no backup has ever reported success", [
        "/health reports backup.last_ok as null.",
        "The nightly dump can fail every night with no signal but this key.",
      ])
    );
  }
  // Ahead is a migration applied before its PR merged, which the merge clears: a digest
  // line, not a job. Behind is a committed migration never applied. Migration names
  // start with a zero-padded number, so the prefix orders them.
  const ahead =
    latestMigration && health.schema_version && migrationNumber(health.schema_version) > migrationNumber(latestMigration);
  if (ahead) {
    out.push(
      finding(namespace, `schema-ahead-${health.schema_version}`, "the live schema is newer than master's newest migration", [
        `live: ${health.schema_version}`,
        `newest on master: ${latestMigration}`,
        "A migration applied before its pull request merged reads like this; the merge clears it.",
      ])
    );
  } else if (latestMigration && health.schema_version && health.schema_version !== latestMigration) {
    out.push(
      finding(namespace, `schema-behind-${latestMigration}`, "the live schema is not the newest migration", [
        `live: ${health.schema_version}`,
        `newest on master: ${latestMigration}`,
        "A migration that was committed and never applied reads exactly like this.",
      ])
    );
  }
  return out;
}

function migrationNumber(name: string): number {
  const n = Number.parseInt(name, 10);
  return Number.isNaN(n) ? -1 : n;
}

/** What capsid_run_improve action status says that should not be true. Per namespace, because the job
 *  each finding becomes belongs to the namespace it is about. */
export function statusFindings(status: StatusReport): Finding[] {
  const out: Finding[] = [];
  for (const ns of status.namespaces ?? []) {
    // An open breaker stops the namespace's queue until a person resets it, so it is
    // said; the watcher files it and nothing more (src/job-breaker.ts).
    if (ns.breaker?.open) {
      out.push(
        finding(ns.namespace, `breaker-open-${ns.namespace}`, `the queue's circuit breaker for ${ns.namespace} is open`, [
          `holder fails since ${ns.breaker.since} UTC: ${ns.breaker.failed}, threshold ${ns.breaker.threshold}`,
          "No job in this namespace is handed out until the seat or Dustin resets it: capsid_admin_control_improve action breaker_reset, or Reset under Paused after repeated failures on the Portal's Needs you.",
        ])
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
 *  and the head sha is evidence. It carried the sha until 2026-09-29, and every red
 *  commit on a red branch was filed as a new finding (13 times in three days). */
export function ciFindings(namespace: string, runs: CiRun[], now: Date): Finding[] {
  const latest = runs.find((r) => r.status === "completed");
  if (!latest) return [];
  if (latest.conclusion === "success" || latest.conclusion === "skipped" || latest.conclusion === "neutral") return [];
  const since = Date.parse(latest.created_at);
  if (Number.isNaN(since)) return [];
  const hours = (now.getTime() - since) / 3_600_000;
  if (hours < CI_RED_HOURS) return [];
  return [
    finding(namespace, `ci-red-${namespace}`, `${namespace} CI is red on its default branch`, [
      `conclusion: ${latest.conclusion}`,
      `head sha: ${latest.head_sha}`,
      `red since: ${latest.created_at} (${hours.toFixed(1)} hours)`,
    ]),
  ];
}

// The off-account mirror. Measure the dump, not the attempt. A credential request
// proves the mirror started; a run can pass its credential step and then fail before
// the dump lands. Only a dump proves a backup exists.
//
// The timestamp comes from the directory name, not the commit date or message. The
// mirror writes backups/json/<dump timestamp>/, so the directory names are the thing
// being asked about. A commit date answers "when did the mirror last push", which is
// the same only while the mirror is healthy, and a commit message would couple this
// check to how the other repo words its commits.

// `2026-09-12T09-00-11-132Z` as the backup writes it. Anchored, so a stray directory
// yields null rather than looking like a fresh backup.
const DUMP_STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

export function parseDumpStamp(name: string): Date | null {
  const m = DUMP_STAMP.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  const at = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The newest dump present, from listRepoTree entries under backups/json/. Null when
 *  none of the entries parse, which is "no dump" and not "a very old dump". */
export function newestDump(entries: Array<{ path?: string }>): Date | null {
  let newest: Date | null = null;
  for (const entry of entries) {
    const name = (entry.path ?? "").split("/").filter(Boolean).pop() ?? "";
    const at = parseDumpStamp(name);
    if (at && (!newest || at > newest)) newest = at;
  }
  return newest;
}

export interface MirrorRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  created_at?: string;
  url?: string;
}

/** The mirror's latest completed run, matched on workflow name (what the runs API
 *  returns). */
function latestMirrorRun(runs: MirrorRun[]): MirrorRun | null {
  return runs.find((r) => r.status === "completed" && (r.name ?? "").toLowerCase().includes("mirror")) ?? null;
}

/** The dump age decides whether there is a finding; the run conclusion explains why.
 *  Three states need three different actions, so they are three findings, and
 *  collapsing them is how the third one gets missed: a green run with no new dump is
 *  the one a conclusion-first check cannot see at all. */
export function mirrorFindings(
  namespace: string,
  newest: Date | null,
  runs: MirrorRun[],
  now: Date
): Finding[] {
  // No dump at all is its own fact. "Never mirrored" is a setup that never worked;
  // "stopped mirroring" is a regression in one that did.
  if (newest === null) {
    return [
      finding(namespace, "mirror-no-dump", "the off-account mirror holds no dump at all", [
        "No directory under backups/json/ parses as a dump timestamp.",
        "Either the mirror has never succeeded, or the layout changed and this check is reading the wrong place.",
      ]),
    ];
  }

  const hours = (now.getTime() - newest.getTime()) / 3_600_000;
  if (hours < MIRROR_STALE_HOURS) return [];

  const age = `newest dump: ${newest.toISOString()} (${hours.toFixed(1)} hours old, the window is ${MIRROR_STALE_HOURS})`;
  const latest = latestMirrorRun(runs);

  // (b) Nothing has run. The schedule is off, Actions is off, or the repo is archived.
  if (!latest) {
    return [
      finding(namespace, "mirror-not-running", "the off-account mirror is stale and its workflow has not run", [
        age,
        "No completed mirror run was returned for this repo.",
        "A disabled schedule, Actions turned off, or an archived repo all look like this.",
      ]),
    ];
  }

  const conclusion = latest.conclusion ?? "none";
  const green = conclusion === "success" || conclusion === "skipped" || conclusion === "neutral";

  // (c) Green and no dump, which a conclusion-first check reports as healthy.
  if (green) {
    return [
      finding(namespace, "mirror-green-no-dump", "the off-account mirror ran green and no new dump appeared", [
        age,
        `last run: ${latest.created_at ?? "unknown"} concluded ${conclusion}`,
        latest.url ? `run: ${latest.url}` : "no run url reported",
        "A commit step that no-ops, or a sync that wrote nothing, passes CI and backs up nothing.",
      ]),
    ];
  }

  // (a) Ran and failed.
  return [
    finding(namespace, `mirror-run-failed-${conclusion}`, "the off-account mirror's workflow is failing", [
      age,
      `last run: ${latest.created_at ?? "unknown"} concluded ${conclusion}`,
      latest.url ? `run: ${latest.url}` : "no run url reported",
      "The mirror commits the dump in its last step, so a red run anywhere earlier means no backup landed.",
    ]),
  ];
}

export interface WatcherReport {
  ran: boolean;
  note: string;
  posted: string[];
  cleared: string[];
}

/** The fingerprints of every open watcher job, over every open status rather than
 *  queued alone. The map decides what the pass skips posting, and a queued-only read
 *  would miss a claimed or blocked copy and post a duplicate.
 *
 *  A claimed or blocked job is still never closed: closing it underneath its owner
 *  would lose work. That guarantee lives in `clearFinding`'s keyed UPDATE, which
 *  moves a row only out of `queued`, so the wider read cannot close anything more. */
export async function openWatcherFingerprints(env: Env): Promise<Map<string, string>> {
  const placeholders = OPEN_JOB_STATUSES.map((_, i) => `?${i + 2}`).join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id, title FROM jobs WHERE posted_by = ?1 AND status IN (${placeholders})`
  )
    .bind(WATCHER_ACTOR, ...OPEN_JOB_STATUSES)
    .all<{ id: string; title: string }>();
  const open = new Map<string, string>();
  for (const row of results ?? []) {
    const match = /\[([^\]]+)\]\s*$/.exec(row.title);
    if (match) open.set(match[1], row.id);
  }
  return open;
}

/** A finding that is no longer found: the job is marked failed with "cleared", since
 *  nobody did the work. Keyed on queued, so a job claimed between the read and the
 *  write is not closed underneath its driver; RETURNING, not meta.changes. */
export async function clearFinding(env: Env, id: string, now: Date, summary: string = CLEARED_SUMMARY): Promise<boolean> {
  const job = await readJob(env.DB, id);
  if (!job || job.status !== "queued" || job.posted_by !== WATCHER_ACTOR) return false;
  // The mirror document closes in the same batch as the row (snapshot invariant, test/write-invariants.test.ts),
  // and the batch is guarded on the status read above, so a job claimed in between is
  // left alone.
  const result = await markJobFailed(env, job, "queued", summary, "job-cleared", WATCHER_ACTOR, {}, now);
  return result.failed;
}

// One pass, with the IO injected. Order: gather, clear what is no longer found, post
// what is new. Clearing first stops a finding that flickers off and on being refused
// as a duplicate of the job about to be closed.

// Which check produces each fingerprint. An open job is cleared only when the check
// that would find it again actually ran: a failed read is not evidence the problem
// went away. A fingerprint no check owns is cleared.
export const WATCHER_CHECKS = [
  "health",
  "master head",
  "migrations",
  "status",
  "mirror dumps",
  "mirror runs",
  "ci",
  "site map",
  "repo map",
  "site probes",
  "cloudflare",
  "live checks",
  "site repairs",
  "agent anomalies",
  "tool anomalies",
  "domains",
  "deploys",
  "stale canon",
] as const;
export type WatcherCheck = (typeof WATCHER_CHECKS)[number];

const OWNERS: ReadonlyArray<readonly [RegExp, WatcherCheck]> = [
  [/^(health-degraded|backup-stale|backup-never)$/, "health"],
  [/^deploy-drift-/, "master head"],
  [/^schema-behind-/, "migrations"],
  [/^schema-ahead-/, "migrations"],
  [/^breaker-open-/, "status"],
  [/^mirror-no-dump$/, "mirror dumps"],
  [/^(mirror-not-running$|mirror-run-failed-|mirror-green-no-dump$)/, "mirror runs"],
  [/^ci-red-/, "ci"],
  [/^site-map-drift-/, "site map"],
  [/^unmapped-repo/, "repo map"],
  [/^site-down-/, "site probes"],
  [/^site-errors-/, "cloudflare"],
  [/^live-config-/, "live checks"],
  [/^live-/, "live checks"],
  [/^site-health-/, "site repairs"],
  [/^site-weekly-/, "site repairs"],
  // Before the audit rule's prefix, which would otherwise claim these too.
  [/^anomaly-tool-/, "tool anomalies"],
  [/^anomaly-/, "agent anomalies"],
  [/^domain-expiry-/, "domains"],
  [/^deploy-(rolled-back|rollback-failed)-/, "deploys"],
  [/^stale-canon-/, "stale canon"],
];

export function owningCheck(fingerprint: string): WatcherCheck | null {
  return OWNERS.find(([pattern]) => pattern.test(fingerprint))?.[1] ?? null;
}

// WHAT A FINDING IS FOR (job_2c92174d5bff item 5; every alert actionable, the rest to a
// digest). One class per OWNERS pattern, the same patterns in the same order:
//   job        a person must act now: it posts a job.
//   digest     a hygiene or drift finding: kept in finding memory and shown on the Portal's
//              weekly digest per site and in the Monday email; posts no job.
//   attention  shown on the Portal's attention list only; posts no job.
// test/watcher-classes.test.ts fails when OWNERS and this table disagree in either
// direction. A fingerprint no pattern names is a job, so an unclassed finding is loud.
export type FindingClass = "job" | "digest" | "attention";
const CLASSES: ReadonlyArray<readonly [RegExp, FindingClass]> = [
  [/^(health-degraded|backup-stale|backup-never)$/, "job"],
  [/^deploy-drift-/, "job"],
  [/^schema-behind-/, "job"],
  [/^schema-ahead-/, "digest"],
  [/^breaker-open-/, "attention"],
  [/^mirror-no-dump$/, "job"],
  [/^(mirror-not-running$|mirror-run-failed-|mirror-green-no-dump$)/, "job"],
  [/^ci-red-/, "job"],
  [/^site-map-drift-/, "job"],
  [/^unmapped-repo/, "job"],
  [/^site-down-/, "job"],
  [/^site-errors-/, "job"],
  [/^live-config-/, "job"],
  [/^live-/, "digest"],
  [/^site-health-/, "job"],
  [/^site-weekly-/, "digest"],
  [/^anomaly-tool-/, "attention"],
  [/^anomaly-/, "attention"],
  [/^domain-expiry-/, "job"],
  [/^deploy-(rolled-back|rollback-failed)-/, "job"],
  [/^stale-canon-/, "digest"],
];

export function findingClass(fingerprint: string): FindingClass {
  return CLASSES.find(([pattern]) => pattern.test(fingerprint))?.[1] ?? "job";
}

/** The patterns each table names, for the coverage test. */
export const OWNER_PATTERNS: readonly string[] = OWNERS.map(([p]) => p.source);
export const CLASS_PATTERNS: readonly string[] = CLASSES.map(([p]) => p.source);

// What a pass saw, kept for the operations dashboard (src/ops-snapshot.ts). Null
// where the read failed, so the snapshot says "could not read" rather than "none".
export interface Observed {
  health: HealthReport | null;
  mirror: MirrorObservation | null;
  ci: CiObservation[];
  siteMap: SiteMapDrift | null;
  probes: SiteProbe[] | null;
  // Each site's Cloudflare state, keyed by namespace. Optional so a pass assembled
  // without it (a test's Gathered) still builds a snapshot.
  cloudflare?: Record<string, SiteCloudflare>;
  // Each configured package as this pass read it; [] with none configured, absent when
  // the configuration could not be read (the snapshot then keeps the last pass's).
  packages?: PackageSnapshot[];
}

export interface Gathered {
  findings: Finding[];
  // The checks whose reads all succeeded this pass.
  ran: ReadonlySet<WatcherCheck>;
  observed: Observed;
}

/** A registered namespace the site map neither covers nor excludes, or a map entry
 *  whose namespace is not registered. The fingerprint names the drift, so a different
 *  drift is a new finding. */
export function siteMapFindings(drift: SiteMapDrift): Finding[] {
  if (drift.unmapped.length === 0 && drift.unknown.length === 0) return [];
  const names = [...drift.unmapped.map((n) => "add-" + n), ...drift.unknown.map((n) => "drop-" + n)].join("-");
  return [
    finding("capsid", "site-map-drift-" + names, "the operations site map does not match the registered namespaces", [
      ...drift.unmapped.map((n) => n + ": registered, but has no row in the Portal's site configuration (Settings: add it as a site, or as serving no site)"),
      ...drift.unknown.map((n) => n + ": in the Portal's site configuration, but not a registered namespace"),
      "The Portal shows only configured sites, so an unmapped site is one nobody is watching.",
    ]),
  ];
}

/** One finding per repo the GitHub App can see that no namespace maps, naming it and the
 *  namespace its name suggests. It proposes; mapping is admin-only and never automatic.
 *  Every finding says what the read covered, so a clear pass is never "0 unmapped"
 *  over "0 listed". */
function unmappedRepoFindings(read: RepoMapRead): Finding[] {
  const covered = `the App's ${read.installations} installation(s) list ${read.installed.length} repos; ${read.mapped.size} are mapped to a namespace; ${read.onPurpose.size} are named unmapped on purpose`;
  return unmappedRepos(read).map((r) =>
    finding("capsid", `unmapped-repo-${r.full_name.toLowerCase().replace("/", "--")}`, `${r.full_name} is visible to the GitHub App but no namespace maps it`, [
      `${r.full_name}: ${r.private ? "private" : "public"}, ${r.archived ? "archived" : "not archived"}, last push ${r.pushed_at ?? "unknown"}`,
      r.suggested
        ? `likely namespace: ${r.suggested} (from the repo name). Map it with capsid_admin_manage_namespaces action update, adding ${r.full_name} with a label.`
        : "no registered namespace matches its name. Register one with capsid_admin_manage_namespaces action register, or map it into an existing namespace with action update.",
      "If it is unmapped on purpose (archived, frozen, or going away), list it in capsid/unmapped-repos.md, one owner/name per line, and this stops.",
      covered,
      "This check only proposes. Mapping is the authorization boundary and stays with the seat or Dustin.",
    ])
  );
}

/** The App's repo list could not be read whole, so unmapped repos cannot be found. Fails
 *  closed: this is a finding, and the "repo map" check does not count as run, so an open
 *  unmapped-repo finding is not cleared on no evidence. */
function repoMapUnreadableFinding(reason: string): Finding {
  return finding("capsid", "unmapped-repos-unreadable", "the GitHub App's repository list could not be read, so unmapped repos cannot be found", [
    reason,
    "Until this reads, no repo is being checked against the namespace mapping.",
  ]);
}

const liveFinding = (f: LiveFinding): Finding => finding(f.namespace, f.fingerprint, f.headline, f.evidence);

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
      ])
    );
  }
  return out;
}

// The error-rate threshold (capsid/research/design-ops-console.md, approved): more
// than 1 percent of requests errored in the most recent complete hour, over at least
// 100 requests, so a quiet site's single error is not an alert.
export const ERROR_RATE_THRESHOLD = 0.01;
export const ERROR_RATE_MIN_REQUESTS = 100;

/** A site whose Worker errored on more than ERROR_RATE_THRESHOLD of its requests in
 *  the most recent complete hour, the last of its hourly buckets. A site with no
 *  analytics this pass is not judged. */
export function siteErrorFindings(sites: ReadonlyArray<{ namespace: string; name: string }>, cloudflare: Record<string, SiteCloudflare>): Finding[] {
  const out: Finding[] = [];
  for (const site of sites) {
    const cf = cloudflare[site.namespace];
    if (cf?.state !== "ok" || !cf.errors24 || cf.errors24.length === 0) continue;
    const hour = cf.errors24[cf.errors24.length - 1];
    if (hour.requests < ERROR_RATE_MIN_REQUESTS || hour.errors / hour.requests <= ERROR_RATE_THRESHOLD) continue;
    out.push(
      finding(site.namespace, `site-errors-${site.namespace}`, `${site.name} errored on more than ${ERROR_RATE_THRESHOLD * 100} percent of requests`, [
        `script: ${cf.script}`,
        `hour from ${hour.hour}: ${hour.errors} errors of ${hour.requests} requests (${((hour.errors / hour.requests) * 100).toFixed(1)} percent)`,
        "Cloudflare counts an invocation that threw, exceeded its resources or hit an internal error.",
      ])
    );
  }
  return out;
}

/** The snapshot's check list: every check, as clear, finding, or could not run. */
export function checkStates(gathered: Pick<Gathered, "findings" | "ran">): OpsSnapshot["checks"] {
  return WATCHER_CHECKS.map((id) => {
    const findings = gathered.findings.filter((f) => owningCheck(f.fingerprint) === id).map((f) => f.fingerprint);
    return { id, state: !gathered.ran.has(id) ? "could-not-run" : findings.length ? "finding" : "clear", findings };
  });
}

export interface PassReaders {
  findings: () => Promise<Pick<Gathered, "findings" | "ran">>;
  open: () => Promise<Map<string, string>>;
  clear: (id: string, summary?: string) => Promise<boolean>;
  post: (f: Finding) => Promise<{ ok: true; jobId: string } | { ok: false; refusal?: string }>;
  memory: FindingMemory;
}

export interface PassResult {
  posted: string[];
  cleared: string[];
  // Seen and not filed: dismissed by a person, or inside the quiet period.
  held: string[];
  // Digest or attention class, recorded in finding memory with no job.
  routed: string[];
}

const movedSummary = (klass: FindingClass): string =>
  `${CLEARED_SUMMARY}: moved to ${klass === "digest" ? "the weekly digest" : "the Portal's attention list"}, no job needed`;

// A keyed write that moved nothing lost a race with another pass (the tick and the
// Portal's Refresh). Said, not swallowed; the next pass reads the row again.
function moved(ok: boolean, fingerprint: string, what: string): void {
  if (!ok) logEvent("error", "WATCHER_FINDING_MOVED", { message: `WATCHER_FINDING_MOVED ${fingerprint}: the row changed between the read and the ${what}; left for the next pass` });
}

export async function runPass(readers: PassReaders, now: Date): Promise<PassResult> {
  const { findings: found, ran } = await readers.findings();
  const byFingerprint = new Map(found.map((f) => [f.fingerprint, f]));
  const open = await readers.open();
  const rows = await readers.memory.load(found.map((f) => f.fingerprint));

  // Absent, and the check that would find it again ran. A failed read is not
  // evidence the problem went away.
  const clearable = (fingerprint: string): boolean => {
    if (byFingerprint.has(fingerprint)) return false;
    const owner = owningCheck(fingerprint);
    return !owner || ran.has(owner);
  };

  const cleared: string[] = [];
  // Non-job findings whose old job was cleared this pass, and those whose job the clear
  // refused (claimed, blocked, parked): the second stay attached to their job.
  const movedOff = new Set<string>();
  const stillHeld = new Map<string, string>();
  for (const [fingerprint, id] of open) {
    // A still-found finding whose class is not job: its queued job is noise now, cleared
    // the way a gone finding is, with a summary saying where it went.
    const klass = byFingerprint.has(fingerprint) ? findingClass(fingerprint) : "job";
    if (klass !== "job") {
      if (await readers.clear(id, movedSummary(klass))) {
        cleared.push(fingerprint);
        movedOff.add(fingerprint);
      } else stillHeld.set(fingerprint, id);
      continue;
    }
    if (!clearable(fingerprint)) continue;
    if (await readers.clear(id)) cleared.push(fingerprint);
  }
  // The rows follow whether or not a job moved: a job a driver has claimed stays with
  // its driver, and the finding is cleared all the same. A dismissed finding that stops
  // being seen clears the same way, and its quiet period starts now.
  for (const row of rows.values()) {
    if (row.state === "cleared" || !clearable(row.fingerprint)) continue;
    moved(await readers.memory.clear(row, now), row.fingerprint, "clear");
  }

  const posted: string[] = [];
  const held: string[] = [];
  const routed: string[] = [];
  for (const f of found) {
    const row: FindingRow | null = rows.get(f.fingerprint) ?? null;
    if (findingClass(f.fingerprint) !== "job") {
      // Recorded for the Portal and the digest, never filed. Open with no job; a row
      // still pointing at a job from before the class existed is pointed at none once
      // that job is gone. A person's dismissal and the quiet period hold as they do for
      // a job-class finding (onSighting).
      routed.push(f.fingerprint);
      const heldJob = stillHeld.get(f.fingerprint) ?? null;
      const justMoved = movedOff.has(f.fingerprint) && row?.state === "open";
      const rowJob = !heldJob && !justMoved && row?.state === "open" && row.job_id ? await readers.memory.job(row.job_id) : null;
      const verdict = justMoved ? ({ do: "post" } as const) : onSighting(row, heldJob, rowJob, now);
      if (verdict.do === "bump") moved(await readers.memory.sight(row as FindingRow, f, now), f.fingerprint, "sighting");
      else if (verdict.do === "adopt") moved(row ? await readers.memory.open(row, f, verdict.jobId, now) : await readers.memory.insert(f, "open", verdict.jobId, now), f.fingerprint, "adoption of its open job");
      else if (verdict.do === "dismiss") {
        held.push(f.fingerprint);
        moved(await readers.memory.dismiss(row as FindingRow, f, now), f.fingerprint, "dismissal");
      } else if (verdict.do === "quiet") {
        held.push(f.fingerprint);
        moved(await readers.memory.sight(row as FindingRow, f, now), f.fingerprint, `sighting (${verdict.why})`);
      } else {
        const ok = !row
          ? await readers.memory.insert(f, "open", null, now)
          : row.state === "open" && row.job_id === null
            ? await readers.memory.sight(row, f, now)
            : await readers.memory.open(row, f, null, now);
        moved(ok, f.fingerprint, "record of a finding with no job");
      }
      continue;
    }
    const openJob = open.get(f.fingerprint) ?? null;
    // How the row's job ended, read only when the decision turns on it.
    const rowJob = !openJob && row?.state === "open" && row.job_id ? await readers.memory.job(row.job_id) : null;
    const verdict = onSighting(row, openJob, rowJob, now);

    if (verdict.do === "bump") {
      // Already open is the deduplication working. Counted rather than posted and
      // refused, so the log does not fill with refusals every pass while it persists.
      moved(await readers.memory.sight(row as FindingRow, f, now), f.fingerprint, "sighting");
    } else if (verdict.do === "adopt") {
      moved(
        row ? await readers.memory.open(row, f, verdict.jobId, now) : await readers.memory.insert(f, "open", verdict.jobId, now),
        f.fingerprint,
        "adoption of its open job"
      );
    } else if (verdict.do === "dismiss") {
      held.push(f.fingerprint);
      moved(await readers.memory.dismiss(row as FindingRow, f, now), f.fingerprint, "dismissal");
    } else if (verdict.do === "quiet") {
      held.push(f.fingerprint);
      moved(await readers.memory.sight(row as FindingRow, f, now), f.fingerprint, `sighting (${verdict.why})`);
    } else {
      // The bound on posts per pass. The rest are found again next pass.
      if (posted.length >= MAX_FINDINGS_PER_PASS) continue;
      const result = await readers.post(f);
      if (result.ok) {
        posted.push(f.fingerprint);
        moved(
          row ? await readers.memory.open(row, f, result.jobId, now) : await readers.memory.insert(f, "open", result.jobId, now),
          f.fingerprint,
          "record of its new job"
        );
      } else {
        logEvent("error", "WATCHER_POST_REFUSED", { message: `WATCHER_POST_REFUSED ${f.fingerprint}: ${result.refusal ?? "no reason given"}` });
        if (row) moved(await readers.memory.sight(row, f, now), f.fingerprint, "sighting");
      }
    }
  }
  return { posted, cleared, held, routed };
}

/** The step the five-minute tick calls. Gates on its own cadence first, unless `force`
 *  (the Portal's Refresh, src/ops-feed.ts), which skips that check and nothing else. */
export async function watcherTick(env: Env, now: Date, gather: () => Promise<Gathered>, opts: { force?: boolean } = {}): Promise<WatcherReport> {
  const minutes = await cadenceMinutes(env);
  const last = await env.APP_KV.get(WATCHER_LAST_KEY).catch(() => null);
  const due: DueVerdict = opts.force ? { due: true, reason: "an on-demand pass." } : passDue(last, minutes, now);
  if (!due.due) return { ran: false, note: due.reason, posted: [], cleared: [] };

  const agent = watcherAgent();
  const started = Date.now();
  const gathered = await gather();
  const { posted, cleared, held, routed } = await runPass(
    {
      findings: async () => gathered,
      open: () => openWatcherFingerprints(env),
      clear: (id, summary) => clearFinding(env, id, now, summary),
      post: async (f) => {
        const result = await postJob(env, agent, now, {
          namespace: f.namespace,
          title: f.title,
          body: f.body,
          priority: 9,
          // A finding is not a gate. The work it leads to may hit one and block then;
          // marking it here would demand a human confirmation before anyone read it.
          gate_required: false,
        });
        return result.ok && result.job ? { ok: true as const, jobId: result.job.id } : { ok: false as const, refusal: result.refusal };
      },
      memory: d1FindingMemory(env),
    },
    now
  );

  // The pass, kept for the dashboard. Before the stamp: a snapshot that fails to write
  // throws, the stamp is not written, and the next tick runs the pass again.
  const o = gathered.observed;
  await writeSnapshot(
    env,
    buildSnapshot(await readSnapshot(env), {
      now,
      pass_ms: Date.now() - started,
      cadence_min: minutes,
      checks: checkStates(gathered),
      health: o.health,
      mirror: o.mirror,
      ci: o.ci,
      site_map: o.siteMap,
      probes: o.probes,
      cloudflare: o.cloudflare,
      packages: o.packages,
    })
  );
  // The week's GitHub numbers, once per package per ISO week (ops_package_weeks). A
  // failed write loses one week's row, not the pass: it is logged, and the next pass
  // that week writes it.
  const weekly = (o.packages ?? []).map((p) => weekStatement(env.DB, p, now)).filter((st): st is D1PreparedStatement => st !== null);
  if (weekly.length > 0) {
    try {
      await env.DB.batch(weekly);
    } catch (err) {
      logEvent("error", "WATCHER_PACKAGE_WEEKS_FAILED", { message: `WATCHER_PACKAGE_WEEKS_FAILED: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // Revoked agents out of the live table, history kept (src/agents-archive.ts). A failed
  // move is logged and retried next pass; it never stops the pass.
  try {
    const moved = await archiveRevokedAgents(env.DB, WATCHER_ACTOR, now);
    if (moved.archived.length > 0 || moved.skipped.length > 0) {
      logEvent("log", "WATCHER_AGENTS_ARCHIVED", {
        message: `WATCHER_AGENTS_ARCHIVED ${moved.archived.map((a) => `${a.name} (${a.reason})`).join(", ") || "none"}; changed under the move: ${moved.skipped.join(", ") || "none"}`,
      });
    }
  } catch (err) {
    logEvent("error", "WATCHER_AGENTS_ARCHIVE_FAILED", { message: `WATCHER_AGENTS_ARCHIVE_FAILED: ${err instanceof Error ? err.message : String(err)}` });
  }

  // Written last and only on a pass that ran. A stamp written first would make a
  // throwing pass look completed and skip the next several ticks.
  await env.APP_KV.put(WATCHER_LAST_KEY, now.toISOString());
  return {
    ran: true,
    note: `${due.reason} posted ${posted.length}, cleared ${cleared.length}, held ${held.length}, routed ${routed.length} to the digest or attention list.`,
    posted,
    cleared,
  };
}

// Every read is wrapped so one failing surface does not stop the others being
// checked. A watcher that goes silent because GitHub was slow is worse than one that
// reports three of its four checks, because silence reads as health.

async function attempt<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    logEvent("error", "WATCHER_READ_FAILED", { message: `WATCHER_READ_FAILED ${what}: ${err instanceof Error ? err.message : String(err)}` });
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
    logEvent("log", "WATCHER_STALE_CANON", { message: `WATCHER_STALE_CANON ${staleCanon.note}` });
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
    logEvent("error", "WATCHER_READ_FAILED", { message: `WATCHER_READ_FAILED repo map: ${reason}` });
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
      logEvent("log", "WATCHER_LIVE", { message: `WATCHER_LIVE pages ${live.summary.pages_read}/${live.summary.pages_expected} shas ${live.summary.shas_read}/${live.summary.shas_expected} analytics ${live.summary.analytics_read}/${live.summary.analytics_expected} findings ${live.findings.length}` });
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
      if (repairs.lines.length) logEvent("log", "WATCHER_SITE_REPAIRS", { message: `WATCHER_SITE_REPAIRS ${repairs.lines.join(" | ")}` });
    }
  } else if (config) {
    // No site opted in: nothing to judge, so nothing open can be stale.
    ran.add("site repairs");
  }

  // Cloudflare's view of each site: deploys and hourly errors (src/ops-cloudflare.ts).
  // With no token nothing is fetched, each site says why, and the check is not run.
  // With no site configured there is nothing to read, and nothing is fetched.
  if (sites && sites.length > 0) {
    const cf = await attempt("cloudflare", () => readCloudflare(env, sites, fetchImpl, now));
    if (cf) {
      observed.cloudflare = cf.bySite;
      if (cf.ran) ran.add("cloudflare");
      out.push(...siteErrorFindings(sites, cf.bySite));
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
      for (const f of read.failed) logEvent("warn", "WATCHER_DOMAIN_UNREAD", { message: `${f.domain}: ${f.error}` });
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
  if (steps && steps.seen.length > 0) logEvent("log", "WATCHER_STEPS_SEEN", { message: `WATCHER_STEPS_SEEN ${steps.note}` });

  return { findings: out, ran, observed };
}
