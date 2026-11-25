import type { Env } from "./env";
import type { Agent } from "./agents";
import { JOB_DOC_PREFIX, outsideJobNamespace, type JobRow } from "./jobs-schema";
import { openTitleHolder } from "./jobs-edit";
import { jobAudit, mirrorStatements } from "./jobs-mirror";
import {
  callerIsSeat,
  guardedTransition,
  readJob,
  refuse,
  type JobResult,
} from "./jobs-transition";

import { errorMessage } from "@dustinedwards/site-runtime/log";
import { DAY_MS } from "./time";
// Park: a job that is wanted but not now. A parked job is never claimed or planned (both read only
// queued rows) but is still listed and searchable: it keeps its row and mirror.

const REASON_MAX = 300;
const UNTIL_MAX_MS = 366 * DAY_MS;
const DUE_PER_TICK = 25;
const PARK_DUE_ACTOR = "system:park-due";

function oneLine(reason: string | undefined): string | null {
  const text = (reason ?? "").trim();
  if (!text || text.length > REASON_MAX || /[\r\n]/.test(text)) return null;
  return text;
}

/**
 * A due date as a normalized ISO time, or a refusal. A bare date (YYYY-MM-DD) is the start of that
 * UTC day; a time needs its zone (Z or an offset), so it is never read in whatever zone the Worker
 * happens to run in. It must be after `now` and within a year.
 */
function parseUntil(until: string, now: Date): { at: string } | { refusal: string } {
  const text = until.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(
    text,
  );
  const ms = dateOnly ? Date.parse(`${text}T00:00:00Z`) : zoned ? Date.parse(text) : Number.NaN;
  if (!Number.isFinite(ms) || (dateOnly && new Date(ms).toISOString().slice(0, 10) !== text)) {
    return {
      refusal: `until must be a date (2026-12-01, the start of that UTC day) or a time with its zone (2026-12-01T15:00:00Z); '${text.slice(0, 40)}' is neither.`,
    };
  }
  if (ms <= now.getTime())
    return { refusal: `until ${new Date(ms).toISOString()} has already passed.` };
  if (ms - now.getTime() > UNTIL_MAX_MS)
    return {
      refusal: `until ${new Date(ms).toISOString()} is more than a year away; park without a date and unpark it when it is wanted.`,
    };
  return { at: new Date(ms).toISOString() };
}

export async function parkJob(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  reason: string | undefined,
  until?: string,
): Promise<JobResult> {
  if (!callerIsSeat(agent)) {
    return refuse(
      "park",
      `${agent.actor} cannot park a job. Parking is the seat's act, and this caller holds neither the admin identity nor can_merge.`,
    );
  }
  const why = oneLine(reason);
  if (!why) {
    return refuse(
      "park",
      `park needs a reason in one line, at most ${REASON_MAX} characters, saying when the job comes back ("comes back when ...").`,
    );
  }
  let due: string | null = null;
  if (until !== undefined) {
    const parsed = parseUntil(until, now);
    if ("refusal" in parsed) return refuse("park", parsed.refusal);
    due = parsed.at;
  }
  const current = await readJob(env.DB, id);
  if (!current) return refuse("park", `no job ${id}.`);
  const outside = outsideJobNamespace(agent, current.namespace);
  if (outside)
    return refuse("park", `${agent.actor} cannot park ${id} ('${current.title}'): ${outside}`);
  if (current.status !== "queued") {
    return refuse(
      "park",
      `${id} is ${current.status}${current.claimed_by && current.status === "claimed" ? ` (held by ${current.claimed_by})` : ""}. Park changes a queued job; a claimed or blocked one has somebody on it, so resume or supersede that instead.`,
    );
  }

  const parked: JobRow = {
    ...current,
    status: "parked",
    result_summary: why,
    parked_until: due,
    updated_at: now.toISOString(),
  };
  const won = await guardedTransition(env, current, [
    env.DB.prepare(
      `UPDATE jobs SET status = 'parked', result_summary = ?2, parked_until = ?3, updated_at = ?4 WHERE id = ?1 AND status = 'queued' RETURNING id`,
    ).bind(id, why, due, parked.updated_at),
    ...(await mirrorStatements(env, parked, "job-parked", agent.actor)),
    jobAudit(env.DB, agent.actor, "job-parked", parked, {
      reason: why,
      priority: current.priority,
      ...(due ? { until: due } : {}),
    }),
  ]);
  if (!won) {
    const moved = await readJob(env.DB, id);
    return refuse(
      "park",
      `${id} changed between reading it and parking it: it is now ${moved?.status ?? "gone"}. Nothing was written.`,
    );
  }
  return { ok: true, action: "park", job: parked };
}

export async function unparkJob(env: Env, agent: Agent, now: Date, id: string): Promise<JobResult> {
  if (!callerIsSeat(agent)) {
    return refuse(
      "unpark",
      `${agent.actor} cannot unpark a job. Unparking is the seat's act, and this caller holds neither the admin identity nor can_merge.`,
    );
  }
  const current = await readJob(env.DB, id);
  if (!current) return refuse("unpark", `no job ${id}.`);
  const outside = outsideJobNamespace(agent, current.namespace);
  if (outside)
    return refuse("unpark", `${agent.actor} cannot unpark ${id} ('${current.title}'): ${outside}`);
  if (current.status !== "parked")
    return refuse("unpark", `${id} is ${current.status}, not parked.`);

  return returnToQueue(env, agent.actor, now, current);
}

/**
 * The parked job back in the queue, for the seat's unpark and for the tick's due date: the same
 * title check, the same guarded write and the same audit action, with the actor that did it.
 */
async function returnToQueue(
  env: Env,
  actor: string,
  now: Date,
  current: JobRow,
): Promise<JobResult> {
  const id = current.id;
  const holder = await openTitleHolder(env.DB, current.namespace, current.title, id);
  if (holder) {
    return refuse(
      "unpark",
      `${current.namespace} already has another open job titled '${current.title}': ${holder.id} is ${holder.status}. One open job per (namespace, title), so ${id} stays parked and nothing was written.`,
    );
  }

  const queued: JobRow = {
    ...current,
    status: "queued",
    result_summary: null,
    parked_until: null,
    updated_at: now.toISOString(),
  };
  let won: boolean;
  try {
    won = await guardedTransition(env, current, [
      env.DB.prepare(
        `UPDATE jobs SET status = 'queued', result_summary = NULL, parked_until = NULL, updated_at = ?2 WHERE id = ?1 AND status = 'parked' RETURNING id`,
      ).bind(id, queued.updated_at),
      ...(await mirrorStatements(env, queued, "job-unparked", actor)),
      jobAudit(env.DB, actor, "job-unparked", queued, {
        was: current.result_summary,
        ...(current.parked_until ? { until: current.parked_until } : {}),
      }),
    ]);
  } catch (err) {
    const message = errorMessage(err);
    if (/UNIQUE/i.test(message)) {
      const taken = await openTitleHolder(env.DB, current.namespace, current.title, id).catch(
        () => null,
      );
      return refuse(
        "unpark",
        `${current.namespace} took the title '${current.title}'${taken ? ` (${taken.id} is ${taken.status})` : ""} while this was being read. ${id} stays parked and nothing was written.`,
      );
    }
    throw err;
  }
  if (!won) {
    const moved = await readJob(env.DB, id);
    return refuse(
      "unpark",
      `${id} changed between reading it and unparking it: it is now ${moved?.status ?? "gone"}. Nothing was written.`,
    );
  }
  return { ok: true, action: "unpark", job: queued };
}

export interface ParkDueReport {
  returned: string[];
  kept: Array<{ id: string; why: string }>;
  note: string;
}

/**
 * A refusal keeps the job parked, writes a `job-park-due-kept` audit row naming the due date, and
 * is reported, so the run ledger says why once; a job with that row for its current due date is
 * not tried again, so a taken title is one refusal, not one every five minutes.
 */
export async function returnDueParked(env: Env, now: Date): Promise<ParkDueReport> {
  const { results } = await env.DB.prepare(
    `SELECT j.* FROM jobs j
      WHERE j.status = 'parked' AND j.parked_until IS NOT NULL AND j.parked_until <= ?1
        AND NOT EXISTS (SELECT 1 FROM audit_log a
                         WHERE a.namespace = j.namespace AND a.path = ?3 || j.id || '.md'
                           AND a.action = 'job-park-due-kept'
                           AND json_extract(a.params, '$.until') = j.parked_until)
      ORDER BY j.parked_until LIMIT ?2`,
  )
    .bind(now.toISOString(), DUE_PER_TICK, JOB_DOC_PREFIX)
    .all<JobRow>();
  const returned: string[] = [];
  const kept: ParkDueReport["kept"] = [];
  for (const job of results ?? []) {
    const out = await returnToQueue(env, PARK_DUE_ACTOR, now, job);
    if (out.ok) {
      returned.push(job.id);
      continue;
    }
    const why = out.refusal ?? "refused";
    kept.push({ id: job.id, why });
    await jobAudit(env.DB, PARK_DUE_ACTOR, "job-park-due-kept", job, {
      until: job.parked_until,
      why,
    }).run();
  }
  const parts = [
    ...(returned.length ? [`returned ${returned.join(", ")} to the queue`] : []),
    ...kept.map((k) => `kept ${k.id} parked: ${k.why}`),
  ];
  return { returned, kept, note: parts.join("; ") };
}
