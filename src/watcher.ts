import type { Env } from "./env";
import type { Agent } from "./agents";
import { noFlags } from "./agents-schema";
import { type HealthReport } from "./health";
import { postJob } from "./jobs";
import { OPEN_JOB_STATUSES } from "./jobs-schema";
import { markJobFailed, readJob } from "./jobs-transition";
import { CLEARED_SUMMARY, d1FindingMemory, onSighting, type FindingMemory, type FindingRow } from "./watcher-findings";
import { type SiteMapDrift } from "./ops-sites";
import { weekStatement } from "./ops-packages";
import type { PackageSnapshot, SiteCloudflare } from "./ops-types/sites";
import { archiveRevokedAgents } from "./agents-archive";
import {
  buildSnapshot,
  readSnapshot,
  writeSnapshot,
  type CiObservation,
  type MirrorObservation,
  type OpsSnapshot,
  type SiteProbe,
} from "./ops-snapshot";
import { logEvent } from "./log";
import type { Finding } from "./watcher-detect";
import { type WatcherCheck, WATCHER_CHECKS, owningCheck, type FindingClass, findingClass } from "./watcher-checks";
import { MINUTE_MS } from "./time";

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

// How many findings one pass will post. If every check fires at once, the queue gets
// ten jobs and the rest are found again next pass, which is better than a tick that
// posts fifty and times out.
export const MAX_FINDINGS_PER_PASS = 10;

// The watcher's identity inside the Worker, matching the minted `watcher` role in
// scripts/mint-agents.ts (every namespace, write, `capsid_work_jobs.post`, no flags), so the
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
  const elapsed = (now.getTime() - last) / MINUTE_MS;
  if (elapsed < minutes) return { due: false, reason: `${Math.floor(elapsed)} of ${minutes} minutes since the last pass.` };
  return { due: true, reason: `${Math.floor(elapsed)} minutes since the last pass, cadence is ${minutes}.` };
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

/** The snapshot's check list: every check, as clear, finding, or could not run. */
export function checkStates(gathered: Pick<Gathered, "findings" | "ran">): OpsSnapshot["checks"] {
  return WATCHER_CHECKS.map((id) => {
    const findings = gathered.findings.filter((f) => owningCheck(f.fingerprint) === id).map((f) => f.fingerprint);
    return { id, state: !gathered.ran.has(id) ? "could-not-run" : findings.length ? "finding" : "clear", findings };
  });
}

// One pass, with the IO injected. Order: gather, clear what is no longer found, post
// what is new. Clearing first stops a finding that flickers off and on being refused
// as a duplicate of the job about to be closed.

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

