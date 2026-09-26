import type { Env } from "./env";
import type { Agent } from "./agents";
import { noFlags } from "./agents-schema";
import { BACKUP_STALE_HOURS, healthReport, type HealthReport } from "./health";
import { ciStatus, defaultBranchSha, listRepoTree, readRepoFile } from "./github";
import { improveStatus, type StatusReport } from "./improve-run";
import { LOOP_PAUSE_PREFIX, ROSTER } from "./improve-schema";
import { SCORER_MARKER, SCORER_REPORT, SCORER_WORKFLOW, digest, normalizePins, sharedBlock } from "./scorer-identity";
import { postJob } from "./jobs";
import { OPEN_JOB_STATUSES } from "./jobs-schema";

// The watcher looks at the surface every half hour and, when something is wrong,
// posts a job. It holds no blast-radius flag, cannot claim a job and cannot fix
// anything. A watcher that could act on what it found would be an unattended agent
// deciding at 03:00 what to do about a red default branch, so it writes the finding
// down with the evidence and a named caller picks it up.
//
// Deduplication is the queue's own rule: `post` refuses a duplicate while a job with
// the same (namespace, title) is open, and the title carries the fingerprint, so a
// finding posts once and is refused every pass after that until it clears. A
// separate fingerprint table would be a second answer that could disagree.

export const WATCHER_NAME = "watcher";
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

// Warn before the cap stops the loop, not after.
export const BUDGET_WARN_FRACTION = 0.8;

// How many findings one pass will post. If every check fires at once, the queue gets
// ten jobs and the rest are found again next pass, which is better than a tick that
// posts fifty and times out.
export const MAX_FINDINGS_PER_PASS = 10;

// The watcher's identity inside the Worker, matching the minted `watcher` role in
// scripts/mint-agents.mjs (every namespace, write, `jobs.post`, no flags), so the
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
      tools: ["jobs", "jobs.post"],
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
    // An unreadable store means the default, as improve_mode does.
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
    ...evidence.map((line) => `- ${line}`),
    "",
    "## What this job is",
    "",
    "A finding, not an instruction. Confirm it is still true before acting: the watcher",
    "reads a surface every half hour and a finding can clear itself between the post and",
    "the claim. If it has cleared, fail this job saying so.",
  ].join("\n"),
});

/** What /health says that should not be true. `masterSha` and `latestMigration` come
 *  from the repo, so this answers "is the deployed Worker the one master describes"
 *  rather than only "is it up". */
export function healthFindings(
  health: HealthReport,
  masterSha: string | null,
  latestMigration: string | null,
  namespace: string
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
  if (masterSha && health.sha && health.sha !== "unknown" && health.sha !== masterSha) {
    out.push(
      finding(namespace, `deploy-drift-${masterSha.slice(0, 7)}`, "the deployed sha is not master head", [
        `deployed: ${health.sha}`,
        `master: ${masterSha}`,
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
  if (health.backup.last_ok === null) {
    out.push(
      finding(namespace, "backup-never", "no backup has ever reported success", [
        "/health reports backup.last_ok as null.",
        "The nightly dump can fail every night with no signal but this key.",
      ])
    );
  }
  if (latestMigration && health.schema_version && health.schema_version !== latestMigration) {
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

/** What improve_status says that should not be true. Per namespace, because the job
 *  each finding becomes belongs to the namespace it is about. */
export function statusFindings(status: StatusReport): Finding[] {
  const out: Finding[] = [];
  const budget = status.budget;
  for (const key of ["model_usd_month", "actions_minutes_month"] as const) {
    const cap = budget.caps?.[key];
    const spent = key === "model_usd_month" ? budget.spend?.cost_usd : budget.spend?.ci_minutes;
    if (typeof cap !== "number" || cap <= 0 || typeof spent !== "number") continue;
    const fraction = spent / cap;
    if (fraction < BUDGET_WARN_FRACTION) continue;
    out.push(
      finding("capsid", `budget-${key}-${budget.month}`, `${key} is over ${Math.round(BUDGET_WARN_FRACTION * 100)} percent of its cap`, [
        `spent: ${spent} of ${cap} (${Math.round(fraction * 100)} percent)`,
        `month: ${budget.month}`,
        "Said before the cap stops the loop rather than after.",
      ])
    );
  }

  for (const ns of status.namespaces ?? []) {
    // Only a pause the loop set on itself is reported (LOOP_PAUSE_PREFIX, or a bare
    // "budget", the older spelling that may still be in KV). A human pause is not a
    // problem.
    if (ns.paused && (ns.paused.startsWith(LOOP_PAUSE_PREFIX) || ns.paused === "budget")) {
      out.push(
        finding(ns.namespace, `paused-${ns.namespace}`, `${ns.namespace} is paused by the loop itself`, [
          `reason: ${ns.paused}`,
          "A pause key has no TTL, so this stays until a human clears it.",
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
}

/** A default branch that has been red for longer than a flake. Reads the most recent
 *  COMPLETED run, because a run still in flight is not yet an answer. */
export function ciFindings(namespace: string, runs: CiRun[], now: Date): Finding[] {
  const latest = runs.find((r) => r.status === "completed");
  if (!latest) return [];
  if (latest.conclusion === "success" || latest.conclusion === "skipped" || latest.conclusion === "neutral") return [];
  const since = Date.parse(latest.created_at);
  if (Number.isNaN(since)) return [];
  const hours = (now.getTime() - since) / 3_600_000;
  if (hours < CI_RED_HOURS) return [];
  return [
    finding(namespace, `ci-red-${latest.head_sha.slice(0, 7)}`, `${namespace} CI is red on its default branch`, [
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
export async function clearFinding(env: Env, id: string, now: Date): Promise<boolean> {
  const won = await env.DB.prepare(
    `UPDATE jobs SET status = 'failed', result_summary = ?2, lease_expires = NULL, updated_at = ?3
     WHERE id = ?1 AND status = 'queued' AND posted_by = ?4 RETURNING id`
  )
    .bind(id, "cleared", now.toISOString(), WATCHER_ACTOR)
    .first<{ id: string }>();
  return won !== null;
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
  "improve_status",
  "mirror dumps",
  "mirror runs",
  "scorer identity",
  "scorer surface",
  "ci",
] as const;
export type WatcherCheck = (typeof WATCHER_CHECKS)[number];

const OWNERS: ReadonlyArray<readonly [RegExp, WatcherCheck]> = [
  [/^(health-degraded|backup-stale|backup-never)$/, "health"],
  [/^deploy-drift-/, "master head"],
  [/^schema-behind-/, "migrations"],
  [/^(budget-|paused-)/, "improve_status"],
  [/^mirror-no-dump$/, "mirror dumps"],
  [/^(mirror-not-running$|mirror-run-failed-|mirror-green-no-dump$)/, "mirror runs"],
  [/^scorer-unread-/, "scorer identity"],
  [/^(scorer-diverged-|scorer-identity-unknown$)/, "scorer surface"],
  [/^ci-red-/, "ci"],
];

export function owningCheck(fingerprint: string): WatcherCheck | null {
  return OWNERS.find(([pattern]) => pattern.test(fingerprint))?.[1] ?? null;
}

export interface Gathered {
  findings: Finding[];
  // The checks whose reads all succeeded this pass.
  ran: ReadonlySet<WatcherCheck>;
}

export interface PassReaders {
  findings: () => Promise<Gathered>;
  open: () => Promise<Map<string, string>>;
  clear: (id: string) => Promise<boolean>;
  post: (f: Finding) => Promise<{ ok: boolean; refusal?: string }>;
}

export async function runPass(readers: PassReaders): Promise<{ posted: string[]; cleared: string[] }> {
  const { findings: found, ran } = await readers.findings();
  const byFingerprint = new Map(found.map((f) => [f.fingerprint, f]));
  const open = await readers.open();

  const cleared: string[] = [];
  for (const [fingerprint, id] of open) {
    if (byFingerprint.has(fingerprint)) continue;
    const owner = owningCheck(fingerprint);
    if (owner && !ran.has(owner)) continue;
    if (await readers.clear(id)) cleared.push(fingerprint);
  }

  const posted: string[] = [];
  for (const f of found.slice(0, MAX_FINDINGS_PER_PASS)) {
    // Already open is the deduplication working. Skipped rather than posted and
    // refused, so the log does not fill with refusals every pass while it persists.
    if (open.has(f.fingerprint)) continue;
    const result = await readers.post(f);
    if (result.ok) posted.push(f.fingerprint);
    else console.error(`WATCHER_POST_REFUSED ${f.fingerprint}: ${result.refusal ?? "no reason given"}`);
  }
  return { posted, cleared };
}

/** The step the five-minute tick calls. Gates on its own cadence first. */
export async function watcherTick(env: Env, now: Date, gather: () => Promise<Gathered>): Promise<WatcherReport> {
  const minutes = await cadenceMinutes(env);
  const last = await env.APP_KV.get(WATCHER_LAST_KEY).catch(() => null);
  const due = passDue(last, minutes, now);
  if (!due.due) return { ran: false, note: due.reason, posted: [], cleared: [] };

  const agent = watcherAgent();
  const { posted, cleared } = await runPass({
    findings: gather,
    open: () => openWatcherFingerprints(env),
    clear: (id) => clearFinding(env, id, now),
    post: async (f) =>
      postJob(env, agent, now, {
        namespace: f.namespace,
        title: f.title,
        body: f.body,
        priority: 9,
        // A finding is not a gate. The work it leads to may hit one and block then;
        // marking it here would demand a human confirmation before anyone read it.
        gate_required: false,
      }),
  });

  // Written last and only on a pass that ran. A stamp written first would make a
  // throwing pass look completed and skip the next several ticks.
  await env.APP_KV.put(WATCHER_LAST_KEY, now.toISOString());
  return {
    ran: true,
    note: `${due.reason} posted ${posted.length}, cleared ${cleared.length}.`,
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
    console.error(`WATCHER_READ_FAILED ${what}: ${err instanceof Error ? err.message : String(err)}`);
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

/** The scorer surface is meant to be identical in all roster repos; this checks it
 *  from the only component that can read all of them. A repo that cannot be read is
 *  named in a finding rather than dropped, and the count read is stated, so "they all
 *  match" cannot come from fewer repos than it claims. It reports; a human runs the
 *  copier to fix it. */
async function scorerIdentityFindings(env: Env): Promise<Finding[]> {
  const read: Array<{ namespace: string; block: string; report: string }> = [];
  const unreadable: string[] = [];
  const malformed: string[] = [];

  for (const namespace of ROSTER) {
    const files = await attempt(`scorer surface ${namespace}`, async () => {
      const wf = await readRepoFile(env, namespace, SCORER_WORKFLOW);
      const rp = await readRepoFile(env, namespace, SCORER_REPORT);
      return { workflow: wf.content, report: rp.content };
    });
    if (!files || files.workflow.length === 0 || files.report.length === 0) {
      unreadable.push(namespace);
      continue;
    }
    const block = sharedBlock(files.workflow);
    if (block === null) {
      // The marker is missing or doubled, so there is no block to compare. Reported
      // rather than skipped: a file that lost its marker is a shape the copier cannot
      // maintain.
      malformed.push(namespace);
      continue;
    }
    read.push({
      namespace,
      block: (await digest(normalizePins(block))).slice(0, 16),
      report: (await digest(files.report)).slice(0, 16),
    });
  }

  return identityFindings(read, unreadable, malformed);
}

export interface ScorerSurface {
  namespace: string;
  block: string;
  report: string;
}

/** The judgement, with no IO in it, so every branch is reachable from a test. */
export function identityFindings(read: ScorerSurface[], unreadable: string[], malformed: string[]): Finding[] {
  const out: Finding[] = [];
  const seen = `${read.length} of ${ROSTER.length} repos read`;

  if (unreadable.length > 0 || malformed.length > 0) {
    out.push(
      finding("capsid", `scorer-unread-${unreadable.concat(malformed).sort().join("-")}`, "the scorer surface could not be read everywhere", [
        ...unreadable.map((n) => `${n}: could not be read, so it is not in the comparison below`),
        ...malformed.map((n) => `${n}: the ${SCORER_MARKER} marker is missing or doubled, so it has no shared block`),
        seen,
        "A repo that cannot be read is not a repo that agrees. Until this clears, any identity result below covers fewer than five.",
      ])
    );
  }

  // Fewer than two read is not agreement: one repo always matches itself and zero
  // repos match too.
  if (read.length < 2) {
    if (read.length > 0) {
      out.push(
        finding("capsid", "scorer-identity-unknown", "the scorer surface cannot be compared", [
          seen,
          "At least two repos must be readable before identity means anything.",
        ])
      );
    }
    return out;
  }

  const blocks = new Map<string, string[]>();
  const reports = new Map<string, string[]>();
  for (const r of read) {
    blocks.set(r.block, [...(blocks.get(r.block) ?? []), r.namespace]);
    reports.set(r.report, [...(reports.get(r.report) ?? []), r.namespace]);
  }

  const describe = (groups: Map<string, string[]>) =>
    [...groups.entries()].map(([hash, names]) => `${hash}: ${names.sort().join(", ")}`).sort();

  if (blocks.size > 1 || reports.size > 1) {
    out.push(
      finding(
        "capsid",
        `scorer-diverged-${[...blocks.keys()].sort().join("-").slice(0, 24)}-${[...reports.keys()].sort().join("-").slice(0, 24)}`,
        `the scorer surface differs across the roster (${blocks.size} score block(s), ${reports.size} report script(s))`,
        [
          seen,
          `score block, ${blocks.size} distinct:`,
          ...describe(blocks).map((line) => `  ${line}`),
          `report script, ${reports.size} distinct:`,
          ...describe(reports).map((line) => `  ${line}`),
          "Pinned action SHAs are compared strictly; the trailing version comment is not, so this is not Renovate.",
          "Fix by running scripts/sync-scorer.mjs from capsid and landing the result per repo.",
        ]
      )
    );
  }

  return out;
}

export async function gatherFindings(env: Env, now: Date): Promise<Gathered> {
  const out: Finding[] = [];
  const ran = new Set<WatcherCheck>();

  // No casts on a repo reader's result, so a renamed field fails `npm run check`.
  // attempt() swallows a throw, so a cast would hide a check that never runs.
  // test/watcher-gather.test.ts drives both reads end to end.
  const health = await attempt("health", () => healthReport(env));
  if (health) {
    ran.add("health");
    const head = await attempt("master head", () => defaultBranchSha(env, "capsid"));
    if (head !== null) ran.add("master head");
    // Wrapped in an object so a tree with no migrations (null) is told apart from a
    // read that failed (also null from attempt).
    const migrations = await attempt("migrations", async () => {
      const tree = await listRepoTree(env, "capsid", "migrations");
      return { newest: newestMigration(tree.entries.map((e) => basename(e.path))) };
    });
    if (migrations !== null) ran.add("migrations");
    out.push(...healthFindings(health, head ?? null, migrations?.newest ?? null, "capsid"));
  }

  const status = await attempt("improve_status", () => improveStatus(env));
  if (status) {
    ran.add("improve_status");
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
    out.push(...mirrorFindings("capsid", newestDump(dumps), runs ?? [], now));
  }

  const scorer = await attempt("scorer identity", () => scorerIdentityFindings(env));
  if (scorer) {
    ran.add("scorer identity");
    // A comparison over fewer than all the repos says nothing about the ones it could
    // not read, so identity findings clear only on a full read.
    if (!scorer.some((f) => owningCheck(f.fingerprint) === "scorer identity")) ran.add("scorer surface");
    out.push(...scorer);
  }

  // The open-job map is keyed by fingerprint alone, and a ci-red fingerprint does
  // not name its namespace, so the ci check counts as run only when every roster
  // repo was read.
  let ciRead = 0;
  for (const namespace of ROSTER) {
    const runs: CiRun[] | null = await attempt(`ci ${namespace}`, async () => (await ciStatus(env, namespace, undefined, { limit: 5 })).runs);
    if (runs) {
      ciRead++;
      out.push(...ciFindings(namespace, runs, now));
    }
  }
  if (ciRead === ROSTER.length) ran.add("ci");

  return { findings: out, ran };
}
