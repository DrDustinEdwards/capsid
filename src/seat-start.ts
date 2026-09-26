import type { Env } from "./env";
import type { Agent } from "./agents";
import { outsideJobNamespace, type JobRow } from "./jobs-schema";
import { jobAudit } from "./jobs-mirror";
import { callerIsSeat, readJob, refuse, type JobResult } from "./jobs-transition";
import { verifySignedBody } from "./improve-task";
import { ghFetch, resolveRepo } from "./github/client";
import { auditStatement } from "./store-guards";

// The seat starts a Claude Code session on GitHub's runners to work one queued job
// (capsid/research/design-seat-start.md, approved 2026-09-26). The start sends a
// repository_dispatch to the namespace's public repo through the GitHub App; that
// repo's seat-session.yml runs the Claude Code Action on Dustin's subscription, and
// the session claims the job with a runner key scoped to that one namespace.

// The off switch. Only "on" enables; an unset key, any other value and an unreadable
// KV all mean off, so the feature ships off and fails off.
export const SEAT_START_KEY = "seat_start:enabled";
// The cap on seat-started sessions in flight. 1 unless the key reads "2".
export const SEAT_START_CAP_KEY = "seat_start:max_sessions";

// The namespaces a session may be started for, held in code so widening it is a
// reviewed change. Each one's primary repo must also be PUBLIC at the moment of the
// start: a repo that goes private is off for this feature.
const SEAT_START_NAMESPACES: readonly string[] = ["capsid", "dustinedwards"];

// What the repo's workflow listens for, and nothing else.
export const SEAT_START_EVENT = "capsid-seat-start";

// A start whose job has not been claimed by then no longer holds a place under the cap.
export const PENDING_START_MINUTES = 20;

export interface SeatStartState {
  enabled: boolean;
  max_sessions: 1 | 2;
}

export async function seatStartState(env: Env): Promise<SeatStartState> {
  let enabled = false;
  let max: 1 | 2 = 1;
  try {
    enabled = (await env.APP_KV.get(SEAT_START_KEY)) === "on";
    max = (await env.APP_KV.get(SEAT_START_CAP_KEY)) === "2" ? 2 : 1;
  } catch (err) {
    console.error(`SEAT_START_UNREADABLE: ${err instanceof Error ? err.message : String(err)}; treating the switch as off`);
    return { enabled: false, max_sessions: 1 };
  }
  return { enabled, max_sessions: max };
}

/** Set the switch or the cap, audited, and read back. Admin only, through improve_run. */
export async function setSeatStart(
  env: Env,
  actor: string,
  opts: { value?: string; max_sessions?: number }
): Promise<{ action: "seat_start" } & SeatStartState> {
  const value = opts.value?.trim().toLowerCase();
  if (value !== undefined && value !== "on" && value !== "off") {
    throw new Error(`seat_start value must be "on" or "off"; got '${opts.value}'. Nothing was changed.`);
  }
  if (opts.max_sessions !== undefined && opts.max_sessions !== 1 && opts.max_sessions !== 2) {
    throw new Error(`seat_start max_sessions must be 1 or 2; got ${opts.max_sessions}. Nothing was changed.`);
  }
  if (value === undefined && opts.max_sessions === undefined) {
    throw new Error('seat_start needs value ("on" or "off") or max_sessions (1 or 2). Nothing was changed.');
  }
  if (value !== undefined) await env.APP_KV.put(SEAT_START_KEY, value);
  if (opts.max_sessions !== undefined) await env.APP_KV.put(SEAT_START_CAP_KEY, String(opts.max_sessions));
  await env.DB.batch([
    auditStatement(env.DB, actor, "seat-start-set", null, null, {
      ...(value !== undefined ? { enabled: value === "on" } : {}),
      ...(opts.max_sessions !== undefined ? { max_sessions: opts.max_sessions } : {}),
    }),
  ]);
  return { action: "seat_start", ...(await seatStartState(env)) };
}

export interface InFlight {
  job_id: string;
  namespace: string;
  how: "claimed" | "pending";
}

// A runner is a minted agent of kind "session" (capsid-runner, dustinedwards-runner).
// Runners hold no flags, and their pull requests are never auto-merged, because
// auto-merge's author_is_driver check refuses any kind but driver.
export async function isRunnerActor(db: D1Database, actor: string): Promise<boolean> {
  if (!actor.startsWith("agent:")) return false;
  const row = await db.prepare("SELECT kind FROM agents WHERE name = ?1").bind(actor.slice("agent:".length)).first<{ kind: string }>();
  return row?.kind === "session";
}

/** Seat-started sessions in flight: a job a runner holds, or a recent start not yet claimed. */
export async function sessionsInFlight(env: Env, now: Date): Promise<InFlight[]> {
  const claimed = await env.DB.prepare(
    `SELECT j.id, j.namespace FROM jobs j JOIN agents a ON j.claimed_by = 'agent:' || a.name
     WHERE j.status = 'claimed' AND a.kind = 'session'`
  ).all<{ id: string; namespace: string }>();
  const out: InFlight[] = (claimed.results ?? []).map((r) => ({ job_id: r.id, namespace: r.namespace, how: "claimed" }));
  const since = new Date(now.getTime() - PENDING_START_MINUTES * 60_000).toISOString();
  const starts = await env.DB.prepare(
    `SELECT a.params FROM audit_log a
     WHERE a.action = 'job-seat-started' AND a.at >= datetime(?1)`
  )
    .bind(since)
    .all<{ params: string }>();
  for (const row of starts.results ?? []) {
    const { job_id: jobId } = JSON.parse(row.params) as { job_id?: string };
    if (!jobId || out.some((f) => f.job_id === jobId)) continue;
    const job = await readJob(env.DB, jobId);
    if (job?.status === "queued") out.push({ job_id: jobId, namespace: job.namespace, how: "pending" });
  }
  return out;
}

/** jobs action "start": dispatch a session for one queued job, after every check. */
export async function startSeatSession(env: Env, agent: Agent, now: Date, id: string): Promise<JobResult> {
  if (!callerIsSeat(agent)) {
    return refuse("start", `${agent.actor} cannot start a session. Starting work on Dustin's subscription is the seat's act, and this caller holds neither the admin identity nor can_merge.`);
  }
  const state = await seatStartState(env);
  if (!state.enabled) {
    return refuse("start", `seat-started sessions are switched off (APP_KV ${SEAT_START_KEY} is not "on"). The admin turns them on with improve_run action "seat_start" or from the console.`);
  }
  const job: JobRow | null = await readJob(env.DB, id);
  if (!job) return refuse("start", `no job ${id}.`);
  const outside = outsideJobNamespace(agent, job.namespace);
  if (outside) return refuse("start", `${agent.actor} cannot start ${id}: ${outside}`);
  if (!SEAT_START_NAMESPACES.includes(job.namespace)) {
    return refuse("start", `${job.namespace} is not one of the namespaces a session may be started for (${SEAT_START_NAMESPACES.join(", ")}).`);
  }
  if (job.status !== "queued") {
    return refuse("start", `${id} is ${job.status}, not queued. A session is started for a queued job, which it then claims.`);
  }
  const verdict = await verifySignedBody(env.IMPROVE_SCORE_SECRET, job.body, "job body");
  if (!verdict.ok) return refuse("start", `${id} does not verify, so no session is started for it: ${verdict.reason}`);

  // Public repos only, read from GitHub at every start: a repo that goes private is off.
  const repo = await resolveRepo(env, job.namespace);
  const meta = await ghFetch(env, repo.owner, repo.repo, `/repos/${repo.owner}/${repo.repo}`);
  if (!meta.ok) return refuse("start", `${repo.full}'s visibility could not be read (GitHub answered ${meta.status}), so no session is started.`);
  const visibility = (await meta.json()) as { private?: boolean };
  if (visibility.private !== false) {
    return refuse("start", `${repo.full} is not public. Seat-started sessions run only on public repos, because their Actions logs are public and the runs are billed to the subscription.`);
  }

  const inFlight = await sessionsInFlight(env, now);
  const sameRepo = inFlight.find((f) => f.namespace === job.namespace);
  if (sameRepo) {
    return refuse("start", `a session for ${job.namespace} is already in flight (${sameRepo.job_id}, ${sameRepo.how}). At most one session runs per repo.`);
  }
  if (inFlight.length >= state.max_sessions) {
    return refuse("start", `${inFlight.length} seat-started session(s) in flight (${inFlight.map((f) => f.job_id).join(", ")}), and the cap is ${state.max_sessions}.`);
  }

  const sent = await ghFetch(env, repo.owner, repo.repo, `/repos/${repo.owner}/${repo.repo}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ event_type: SEAT_START_EVENT, client_payload: { job_id: job.id } }),
  });
  if (sent.status !== 204) {
    return refuse("start", `GitHub refused the dispatch to ${repo.full} (${sent.status}), so no session was started.`);
  }
  await env.DB.batch([
    jobAudit(env.DB, agent.actor, "job-seat-started", job, { repo: repo.full, cap: state.max_sessions, in_flight_before: inFlight.length }),
  ]);
  return {
    ok: true,
    action: "start",
    job,
    note: `a session was dispatched to ${repo.full} for ${job.id}. The runner claims it within a few minutes; a start not claimed within ${PENDING_START_MINUTES} minutes stops counting against the cap. Anything in this job's body appears in public Actions logs.`,
  };
}
