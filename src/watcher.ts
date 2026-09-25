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

// ---- the watcher ----------------------------------------------------------------
//
// GROUP 3 OF THE ROLES ARC. A step that looks at the surface every half hour and,
// when something is wrong, POSTS A JOB. That is the whole of it.
//
// WHAT IT CANNOT DO IS THE POINT. It holds no blast-radius flag, it cannot claim a
// job, and it cannot fix anything. A watcher that could act on what it found would be
// an unattended agent deciding at 03:00 what to do about a red default branch, and
// the arc this belongs to exists to put a person at that boundary. So it writes the
// finding down, with the evidence, and something with a name picks it up.
//
// THE DEDUPLICATION IS THE QUEUE'S OWN RULE, not a second mechanism. `post` already
// refuses a duplicate while one job of the same (namespace, title) is open, so a
// finding whose title carries its fingerprint posts once and is refused every half
// hour after that until it clears. Building a separate fingerprint table would be a
// second answer to a question the queue already answers, and the two would disagree.

export const WATCHER_NAME = "watcher";
export const WATCHER_ACTOR = `agent:${WATCHER_NAME}`;

export const WATCHER_CADENCE_KEY = "watcher:cadence-minutes";
export const WATCHER_LAST_KEY = "watcher:last";

// HALF AN HOUR BY DEFAULT, KV-configurable. The tick runs every five minutes, so this
// gates itself the way the skill cycle does: all but one invocation in six returns
// after a single KV read.
export const DEFAULT_CADENCE_MINUTES = 30;

// The floor. Zero or a negative number would run every check on every tick, which is
// the one setting that turns a bounded cost into an unbounded one, so an unusable
// value falls back rather than being obeyed.
export const MIN_CADENCE_MINUTES = 5;

// A blocked job nobody has looked at in a day. Long enough that an ordinary gate
// cleared the same afternoon never trips it.
export const BLOCKED_STALE_HOURS = 24;

// A default branch that has been red this long is not a flake somebody is already
// fixing.
export const CI_RED_HOURS = 2;

// THE OFF-ACCOUNT MIRROR'S WINDOW, AND IT IS NOT BACKUP_STALE_HOURS.
//
// BACKUP_STALE_HOURS is the LOCAL dump at 26 hours, measured from a key this Worker
// writes itself. This is a different thing measured from the other side: the newest
// dump present in the backups repo (MIRROR_REPO_LABEL, below), which this Worker only
// observes.
// The mirror's schedule lives in that repo and can change without this one hearing,
// so one constant standing for both would go wrong silently the day it does.
//
// 36 hours is the daily cadence plus real slack. The newest dump is stamped at the
// backup cron's 09:00 UTC, and the mirror picks it up hours later, so at 08:59 UTC
// the freshest possible dump is already about 24 hours old before the mirror has
// even run. A tighter window would fire every morning.
export const MIRROR_STALE_HOURS = 36;

// The mapping label and the path, spelled once. The repo itself is NEVER named in this
// module: it is resolved from the capsid namespace's mapping, which is the authorization
// boundary and is admin-only to edit. A hardcoded owner/name would be a second copy
// of that mapping sitting outside the boundary.
export const MIRROR_REPO_LABEL = "backups";
export const MIRROR_DUMP_PREFIX = "backups/json";

// Spend over this fraction of a monthly cap is worth saying out loud before the cap
// stops the loop rather than after.
export const BUDGET_WARN_FRACTION = 0.8;

// How many findings one pass will post. A bound rather than a guess: if every check
// fires at once, the queue gets ten jobs and the rest are found again in half an
// hour, which is better than a tick that posts fifty and times out.
export const MAX_FINDINGS_PER_PASS = 10;

// THE WATCHER'S IDENTITY INSIDE THE WORKER, shaped exactly like the minted `watcher`
// role in scripts/mint-agents.mjs: every namespace, the write grant, `jobs.post` and
// nothing else, no flags. Spelled here because the tick has no bearer token to
// present, and spelled to MATCH rather than to be convenient, so the credential a
// person can mint and the identity the Worker uses are the same authority.
// test/watcher.test.ts derives one from the other and fails if they drift.
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
    // An unreadable store means the default, on the rule improve_mode already
    // follows: fall back to the safe value rather than to whatever was last in
    // memory.
    return DEFAULT_CADENCE_MINUTES;
  }
}

export type DueVerdict = { due: true; reason: string } | { due: false; reason: string };

export function passDue(lastIso: string | null, minutes: number, now: Date): DueVerdict {
  if (!lastIso) return { due: true, reason: "the watcher has not run yet." };
  const last = Date.parse(lastIso);
  // A corrupt stamp RUNS the pass rather than blocking it: one extra pass costs a
  // handful of reads, and never running again costs a watcher that silently stopped.
  if (Number.isNaN(last)) return { due: true, reason: `last-run stamp '${lastIso}' does not parse; running rather than blocking.` };
  const elapsed = (now.getTime() - last) / 60000;
  if (elapsed < minutes) return { due: false, reason: `${Math.floor(elapsed)} of ${minutes} minutes since the last pass.` };
  return { due: true, reason: `${Math.floor(elapsed)} minutes since the last pass, cadence is ${minutes}.` };
}

// ---- findings --------------------------------------------------------------------

export interface Finding {
  // STABLE WHILE THE FINDING PERSISTS AND DIFFERENT WHEN IT IS A DIFFERENT PROBLEM.
  // It goes in the title, so the queue's one-open-job-per-title rule is what stops a
  // finding being posted twice.
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
  // A SHA COMPARISON IS ONLY MEANINGFUL WHEN BOTH SIDES ARE KNOWN. A null master sha
  // means the repo read failed, and reporting that as drift would be a finding about
  // the watcher rather than about the deploy.
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
export function statusFindings(status: StatusReport, now: Date): Finding[] {
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
    // A PAUSE IS NOT A PROBLEM. A human pausing a namespace is the system working, so
    // only a pause the loop set on itself is reported. Those carry LOOP_PAUSE_PREFIX.
    // A bare "budget" is the value written before the prefix existed and may still be
    // in KV.
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

// The headline of a block summary. A blocked job's summary carries the whole resume
// command and can run to a page; a finding wants the first line of it.
function firstLine(text: string | null): string {
  const head = (text ?? "").split("\n")[0].trim();
  return head || "(nothing recorded)";
}

export interface BlockedRow {
  id: string;
  namespace: string;
  title: string;
  result_summary: string | null;
  updated_at: string;
}

/** A blocked job nobody has looked at in a day.
 *
 *  Read from the table rather than from improve_status, because the status report's
 *  blocked_jobs projection carries no timestamp: it answers "what is blocked and on
 *  what command", which is the console's question, not "for how long". Widening that
 *  shape to answer both would put a field on the console that only this reads. */
export function staleBlockedFindings(rows: BlockedRow[], now: Date): Finding[] {
  const out: Finding[] = [];
  for (const row of rows) {
    const since = Date.parse(row.updated_at);
    if (Number.isNaN(since)) continue;
    const hours = (now.getTime() - since) / 3_600_000;
    if (hours < BLOCKED_STALE_HOURS) continue;
    out.push(
      finding(row.namespace, `blocked-${row.id}`, `${row.id} has been blocked for over ${BLOCKED_STALE_HOURS} hours`, [
        `title: ${row.title}`,
        `blocked since: ${row.updated_at} (${hours.toFixed(1)} hours)`,
        `waiting on: ${firstLine(row.result_summary)}`,
      ])
    );
  }
  return out;
}

export async function readStaleBlocked(env: Env, now: Date): Promise<BlockedRow[]> {
  const cutoff = new Date(now.getTime() - BLOCKED_STALE_HOURS * 3_600_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, namespace, title, result_summary, updated_at FROM jobs
     WHERE status = 'blocked' AND updated_at < ?1 ORDER BY updated_at ASC LIMIT 20`
  )
    .bind(cutoff)
    .all<BlockedRow>();
  return results ?? [];
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

// ---- the off-account mirror ---------------------------------------------------------
//
// MEASURE THE DUMP, NOT THE ATTEMPT. Two earlier versions of this check keyed on a
// verified POST /backup/credential, and that signal is measured false: on run
// 34696901751 the mirror's credential step concluded SUCCESS and the run then failed
// two steps later, so no dump landed. The mirror was dead for four days, 2026-09-09
// to 2026-09-12, and the Worker saw a healthy credential request on every one of
// them. A credential request proves the mirror STARTED. Only a dump proves a backup
// EXISTS.
//
// THE TIMESTAMP COMES FROM THE DIRECTORY NAME, not from the commit date and not from
// the commit message. The mirror writes backups/json/<dump timestamp>/, so the
// directory names ARE the thing being asked about: which dumps exist. A commit date
// would answer "when did the mirror last push", which is the same only while the
// mirror is healthy, and a commit message would couple this check to how the other
// repo words its commits.

// `2026-09-12T09-00-11-132Z` as the backup writes it. Anchored and total: a directory
// that is not a dump stamp yields null rather than an accidental date, so a stray
// entry cannot look like a fresh backup.
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

/** The mirror's own workflow runs, newest first, ignoring anything else in that repo.
 *  Matched on the workflow NAME rather than the file path, because that is what the
 *  runs API returns. */
function latestMirrorRun(runs: MirrorRun[]): MirrorRun | null {
  return runs.find((r) => r.status === "completed" && (r.name ?? "").toLowerCase().includes("mirror")) ?? null;
}

/**
 * THE DUMP AGE DECIDES WHETHER, THE RUN CONCLUSION EXPLAINS WHY.
 *
 * Three states, three findings, because they need three different actions, and
 * collapsing them is how the third one gets missed. A green run with no new dump is
 * the subtlest and the one a conclusion-first check cannot see at all.
 */
export function mirrorFindings(
  namespace: string,
  newest: Date | null,
  runs: MirrorRun[],
  now: Date
): Finding[] {
  // No dump at all is its own fact. "Never mirrored" and "stopped mirroring" call for
  // different things: the first is a setup that never worked, the second is a
  // regression in one that did.
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

  // (c) Green and no dump. The hardest one to see and the reason the dump is the
  // primary signal: every conclusion-first check reports this mirror as healthy.
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

  // (a) Ran and failed. The 2026-09-09 case.
  return [
    finding(namespace, `mirror-run-failed-${conclusion}`, "the off-account mirror's workflow is failing", [
      age,
      `last run: ${latest.created_at ?? "unknown"} concluded ${conclusion}`,
      latest.url ? `run: ${latest.url}` : "no run url reported",
      "The mirror commits the dump in its last step, so a red run anywhere earlier means no backup landed.",
    ]),
  ];
}

// ---- posting and clearing ---------------------------------------------------------

export interface WatcherReport {
  ran: boolean;
  note: string;
  posted: string[];
  cleared: string[];
}

/** The fingerprints of every watcher job still open, over EVERY open status rather
 *  than queued alone. This map does two jobs, and only one of them wanted the narrow
 *  read: it decides what the pass skips posting, and it is the list the pass offers to
 *  `clearFinding`. Queued-only made the skip miss a claimed or blocked copy, which is
 *  the second half of the 2026-09-18 duplicate: the index did not count blocked as
 *  open and neither did this.
 *
 *  A job a driver claimed, or one blocked for a human, is still left alone: closing it
 *  underneath its owner would be the queue losing work. That guarantee lives in
 *  `clearFinding`'s keyed UPDATE, which moves a row only out of `queued`, so widening
 *  the read here cannot close anything it could not close before. */
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

/** A finding that is no longer being found. The job is marked failed with "cleared",
 *  which is the honest word: nobody did the work, the thing stopped being true.
 *
 *  KEYED ON queued, so a job a driver claimed between the read and the write is not
 *  closed underneath it, and RETURNING so the count is of rows this actually moved
 *  rather than of D1's trigger-inflated meta.changes. */
export async function clearFinding(env: Env, id: string, now: Date): Promise<boolean> {
  const won = await env.DB.prepare(
    `UPDATE jobs SET status = 'failed', result_summary = ?2, lease_expires = NULL, updated_at = ?3
     WHERE id = ?1 AND status = 'queued' AND posted_by = ?4 RETURNING id`
  )
    .bind(id, "cleared", now.toISOString(), WATCHER_ACTOR)
    .first<{ id: string }>();
  return won !== null;
}

// ---- one pass --------------------------------------------------------------------
//
// THE IO IS INJECTED, so every rule above can be driven without a Worker, a database
// or GitHub. What is left here is the ORDER: gather, clear what is no longer found,
// post what is new. Clearing first matters: a finding that flickers off and on would
// otherwise be refused as a duplicate of the job about to be closed.

// WHICH CHECK PRODUCES EACH FINGERPRINT. A pass clears an open job only when the
// check that would have found it again actually ran. A read that failed is not
// evidence that the problem went away, and clearing on it would record "cleared"
// for a finding that was only unreadable. A fingerprint no check owns can never be
// found again, so it is cleared as before.
export const WATCHER_CHECKS = [
  "health",
  "master head",
  "migrations",
  "improve_status",
  "blocked jobs",
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
  [/^blocked-/, "blocked jobs"],
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
    // ALREADY OPEN IS NOT A FAILURE, it is the deduplication working. The post is
    // skipped rather than attempted-and-refused so the log does not fill with
    // refusals every half hour for as long as a finding persists.
    if (open.has(f.fingerprint)) continue;
    const result = await readers.post(f);
    if (result.ok) posted.push(f.fingerprint);
    else console.error(`WATCHER_POST_REFUSED ${f.fingerprint}: ${result.refusal ?? "no reason given"}`);
  }
  return { posted, cleared };
}

/** The step the five-minute tick calls. Gates on its own cadence first, so all but
 *  one invocation in six returns after a single KV read. */
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
        // A FINDING IS NOT A GATE. The work it leads to may hit one, and that job
        // blocks then; saying so here would mark every finding as needing a human
        // confirmation before anybody has read it.
        gate_required: false,
      }),
  });

  // THE STAMP IS WRITTEN LAST AND ONLY ON A PASS THAT RAN. A stamp written first
  // would make a throwing pass look like a completed one and skip the next six ticks.
  await env.APP_KV.put(WATCHER_LAST_KEY, now.toISOString());
  return {
    ran: true,
    note: `${due.reason} posted ${posted.length}, cleared ${cleared.length}.`,
    posted,
    cleared,
  };
}

// ---- gathering, against the real surfaces -----------------------------------------
//
// Every read here is wrapped: one failing surface must not stop the others being
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

/** The newest migration filename on master, which is what the live schema_version is
 *  compared against. Sorted by name, because the files are zero-padded and ordered by
 *  that padding everywhere else in this repo. */
export function newestMigration(names: string[]): string | null {
  const sql = names.filter((n) => n.endsWith(".sql")).sort();
  return sql.length ? sql[sql.length - 1] : null;
}

/** THE SCORER SURFACE IS MEANT TO BE IDENTICAL IN ALL FIVE ROSTER REPOS, and until
 *  2026-09-16 nothing measured whether it was. The copier had thrown on every run
 *  since 2026-09-12, three commits changed the shared surface and reached nobody,
 *  and four separate places asserted byte-identity while no check could see across
 *  repos. This is that check, in the only component with read access to all five.
 *
 *  A READ THAT RETURNS NOTHING IS A FINDING, never four hashes that happen to
 *  agree. The count of repos actually read is in the finding, so "they all match"
 *  can never be reached by matching one repo against itself, and a repo that could
 *  not be read is named rather than dropped from the comparison.
 *
 *  It reports; it does not prevent. The copier is what fixes the divergence and a
 *  human runs it. */
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
      // rather than skipped: a file that has lost its marker has stopped being the
      // shape the copier can maintain at all.
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

/** The judgement, with no IO in it, so every branch is reachable from a test:
 *  what was read, what could not be, and what that means. */
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

  // FEWER THAN TWO READ IS NOT AGREEMENT. One repo always matches itself and zero
  // repos always match too; neither says anything about identity.
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

  // NO CASTS ON A REPO READER'S RESULT. Until 2026-09-17 both reads below went
  // through one: the head read called repoHistory with no ref, which throws, and the
  // migrations read took `name` from entries that carry `path`. attempt() swallowed
  // the first and the cast hid the second, so neither check ever ran
  // (AUDIT-2026-09-16.md 8.1, 8.21). With the inferred types, a renamed field fails
  // `npm run check`; test/watcher-gather.test.ts drives both reads end to end.
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
    out.push(...statusFindings(status, now));
  }

  const blocked = await attempt("blocked jobs", () => readStaleBlocked(env, now));
  if (blocked) {
    ran.add("blocked jobs");
    out.push(...staleBlockedFindings(blocked, now));
  }

  // THE OFF-ACCOUNT MIRROR. Resolved through the namespace mapping like every other
  // repo call: capsid, selector "backups". Nothing is hardcoded here and no agent
  // scope changes, because this runs inside the tick rather than through the
  // registrar.
  //
  // BOTH READS ARE SEPARATELY FAIL-SAFE, and the dump read is the one that gates.
  // `attempt` returns null when GitHub cannot be reached, and a null dump listing
  // skips the check entirely rather than reporting an empty mirror: "cannot see the
  // mirror" and "the mirror is dead" are different facts, and posting the second
  // during an outage would file a job every half hour about GitHub being down. A
  // failed RUN read is softer and degrades to an empty list, which still lets the
  // stale-dump finding fire and say only that nothing has run.
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
    // A comparison over fewer than all five repos says nothing about the ones it
    // could not read, so the identity findings are only cleared on a full read.
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
