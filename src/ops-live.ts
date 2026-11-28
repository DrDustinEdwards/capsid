import { gatherInbox } from "./inbox";
import type { Env } from "./env";
import { agentSummaries, type AgentSummary } from "./status";
import { APP_ROSTER } from "./roster";
import { commandFromSummary, isQuestionSummary, resumeMarkerIn } from "./jobs-holder-block";
import { checkJobText, type SignatureCheck } from "./job-signing";
import { OPEN_JOB_STATUSES } from "./jobs-schema";
import { readSiteConfig } from "./ops-sites";
import { readPackageConfig } from "./ops-package-config";
import type { OpsAgent, OpsJob, OpsJobStatus, OpsLive, OpsPr } from "./ops-types/feed";
import { overnightState } from "./overnight";
import { openQuietFindings } from "./watcher-digest";
import { WATCHER_ACTOR } from "./watcher";
import { DAY_MS } from "./time";
import { toSqlTime } from "@dustinedwards/site-runtime/time";

// The feed's live reads, each shaped for OpsLive (src/ops-feed.ts gathers them).

const WEEK_MS = 7 * DAY_MS;

// An instant as ISO. Columns written by datetime('now') read "YYYY-MM-DD HH:MM:SS", which is UTC
// but which a browser's Date.parse reads as local time, so the feed hands every timestamp over in
// one unambiguous form. Anything else passes through.
export function isoTime(value: string): string;
export function isoTime(value: string | null): string | null;
export function isoTime(value: string | null): string | null {
  if (value === null) return null;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
}

export interface JobFeedRow {
  id: string;
  namespace: string;
  title: string;
  status: string;
  priority: number;
  posted_by: string;
  claimed_by: string | null;
  created_at: string;
  updated_at: string;
  blocked_count: number;
  resumed_count: number;
  gate_required: number;
  result_ref: string | null;
  result_summary: string | null;
  summary_sig?: string | null;
  // The started label (migrations/0042). Absent in a row read before it.
  started_by?: string | null;
  started_at?: string | null;
  // From the finding's watcher_findings row when this job is its current one
  // (src/watcher-findings.ts). Null, or absent, otherwise.
  finding_seen_count?: number | null;
  finding_last_seen?: string | null;
}

// The watcher's title carries its fingerprint in brackets at the end. The same
// pattern openWatcherFingerprints (src/watcher.ts) reads it with; test/ops-feed.test.ts
// runs both over one set of titles so the two cannot disagree.
const FINGERPRINT = /\[([^\]]+)\]\s*$/;

// A job as the feed shows it. A blocked job's summary is split into what it waits on and the exact
// command (commandFromSummary), so the app can show the command to copy.
export function opsJobFrom(
  row: JobFeedRow,
  commandSignature: SignatureCheck | null = null,
): OpsJob {
  const blocked = row.status === "blocked";
  const summary = row.result_summary;
  const marker = summary === null ? -1 : (resumeMarkerIn(summary)?.at ?? -1);
  const waitsOn =
    !blocked || summary === null
      ? null
      : (marker === -1 ? summary : summary.slice(0, marker)).trim() || null;
  const print = row.posted_by === WATCHER_ACTOR ? FINGERPRINT.exec(row.title) : null;
  return {
    id: row.id,
    namespace: row.namespace,
    title: row.title,
    status: row.status as OpsJobStatus,
    priority: row.priority,
    posted_by: row.posted_by,
    claimed_by: row.claimed_by,
    created_at: isoTime(row.created_at),
    updated_at: isoTime(row.updated_at),
    blocked_count: row.blocked_count,
    resumed_count: row.resumed_count,
    gate_required: row.gate_required === 1,
    waits_on: waitsOn,
    // A command whose signature does not match is withheld, so it cannot be copied.
    command: blocked && commandSignature !== "mismatch" ? commandFromSummary(summary) : null,
    command_signature: blocked ? commandSignature : null,
    question: blocked && commandSignature !== "mismatch" && isQuestionSummary(summary),
    ...(row.status === "parked" && summary !== null ? { parked_reason: summary } : {}),
    ...(row.started_by && row.started_at
      ? { started_by: row.started_by, started_at: isoTime(row.started_at) }
      : {}),
    result_ref: row.result_ref,
    finding: print
      ? {
          fingerprint: print[1],
          seen_count: row.finding_seen_count ?? null,
          last_seen: isoTime(row.finding_last_seen ?? null),
        }
      : null,
  };
}

// One credential as the feed shows it: the inventory capsid_read_status action status serves, with
// its record. Grants are left out; the contract carries flags only.
export function opsAgentFrom(agent: AgentSummary): OpsAgent {
  const r = agent.record;
  return {
    name: agent.name,
    kind: agent.kind,
    namespaces: agent.namespaces,
    flags: agent.flags,
    last_seen: isoTime(agent.last_seen),
    revoked_at: isoTime(agent.revoked_at),
    pending: agent.pending,
    archived_at: isoTime(agent.archived_at),
    jobs_done: r.jobs_done,
    jobs_failed: r.jobs_failed,
    jobs_blocked: r.jobs_blocked,
    prs_opened: r.prs_opened,
    prs_merged: r.prs_merged,
    pr_merge_rate: r.pr_merge_rate,
    ci_green_rate: r.ci_green_rate,
    median_duration_minutes: r.median_duration_minutes,
  };
}

// The store's size against D1's cap.
export const D1_CAP_BYTES = 10 * 1024 ** 3;

/** The size a D1 result reports, or null when its meta has no number for it. */
export function sizeFrom(meta: unknown): number | null {
  const size = (meta as { size_after?: unknown } | null | undefined)?.size_after;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
}

async function liveJobs(
  db: D1Database,
  now: Date,
  secret: string | undefined,
): Promise<{ jobs: OpsJob[]; sizeBytes: number | null }> {
  const open = OPEN_JOB_STATUSES.map((_, i) => `?${i + 2}`).join(", ");
  // datetime() on both sides: updated_at is written both as ISO and as D1's default text form,
  // which do not compare as text. The watcher's finding row joins on the job it is currently filed
  // as (one row per fingerprint, so the join cannot multiply a job).
  const { results, meta } = await db
    .prepare(
      `SELECT j.id, j.namespace, j.title, j.status, j.priority, j.posted_by, j.claimed_by, j.created_at, j.updated_at,
              j.blocked_count, j.resumed_count, j.gate_required, j.result_ref, j.result_summary, j.summary_sig,
              j.started_by, j.started_at,
              wf.seen_count AS finding_seen_count, wf.last_seen_at AS finding_last_seen
       FROM jobs j LEFT JOIN watcher_findings wf ON wf.job_id = j.id
       WHERE j.status IN (${open}) OR j.status = 'parked' OR datetime(j.updated_at) >= datetime(?1)
       ORDER BY j.updated_at DESC`,
    )
    .bind(new Date(now.getTime() - DAY_MS).toISOString(), ...OPEN_JOB_STATUSES)
    .all<JobFeedRow>();
  const rows = results ?? [];
  const checks = await Promise.all(
    rows.map((r) =>
      r.status === "blocked" && r.result_summary !== null
        ? checkJobText(
            secret,
            "summary",
            r.id,
            { summary: r.result_summary },
            r.summary_sig ?? null,
          )
        : Promise.resolve(null),
    ),
  );
  return { jobs: rows.map((r, i) => opsJobFrom(r, checks[i])), sizeBytes: sizeFrom(meta) };
}

async function livePrs(db: D1Database, now: Date): Promise<OpsPr[]> {
  const { results } = await db
    .prepare(
      `SELECT job_id, pr_url, merged, merge_verified_at, recorded_at FROM job_outcome_prs
       WHERE recorded_at >= ?1 ORDER BY recorded_at DESC`,
    )
    .bind(toSqlTime(now.getTime() - WEEK_MS))
    .all<{
      job_id: string;
      pr_url: string;
      merged: number | null;
      merge_verified_at: string | null;
      recorded_at: string;
    }>();
  return (results ?? []).map((r) => ({
    job_id: r.job_id,
    pr_url: r.pr_url,
    // Three states, kept: null is never checked, not closed (migrations/0015).
    merged: r.merged === null ? null : r.merged === 1,
    merge_verified_at: isoTime(r.merge_verified_at),
    recorded_at: isoTime(r.recorded_at),
  }));
}

export async function opsLive(env: Env, now: Date): Promise<OpsLive> {
  const [jobRead, agents, prs, sites, packages, overnight, inbox, findings] = await Promise.all([
    liveJobs(env.DB, now, env.IMPROVE_SCORE_SECRET),
    agentSummaries(env.DB),
    livePrs(env.DB, now),
    readSiteConfig(env.DB),
    readPackageConfig(env.DB),
    overnightState(env),
    gatherInbox(env, now, null),
    openQuietFindings(env.DB),
  ]);
  return {
    generated: now.toISOString(),
    jobs: jobRead.jobs,
    agents: agents.map(opsAgentFrom),
    prs,
    overnight,
    namespaces: APP_ROSTER.map((name) => ({ name })),
    sites,
    packages,
    store: { size_bytes: jobRead.sizeBytes, cap_bytes: D1_CAP_BYTES },
    inbox,
    findings,
  };
}
