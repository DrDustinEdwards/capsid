// What a credential has actually done, from the outcome rows.
//
// COUNTS AND RATES, NEVER A SCORE. A composite number needs a weighting, which is an
// opinion, and a single number invites a gate nobody wrote down. Every field is a
// named count or a rate with a stated denominator.
//
// A rate with no denominator is null, not zero: an agent that opened no pull
// requests has no merge rate, and 0% would rank it below one that merged one in ten.

import { agentActor } from "./agents-schema";

// What this module needs to know about a credential, and no more. Not
// `AgentSummary` from improve-run.ts: that module builds the summaries and then asks
// for the records, so importing its type here would make the two import each other.
export interface RecordSubject {
  name: string;
  kind: string;
  namespaces: "*" | string[];
}

export interface AgentRecord {
  // The actor string matched: `agent:<name>`, as jobs.claimed_by and
  // job_outcomes.agent carry it.
  actor: string;
  jobs_done: number;
  jobs_failed: number;
  // From the jobs table: a blocked job has not ended, so it has no outcome row.
  jobs_blocked: number;
  // How many times this agent's jobs hit a gate, and how many times one was sent back
  // in. Totals across finished jobs, not a count of jobs.
  gates_hit: number;
  resumed: number;
  prs_opened: number;
  prs_merged: number;
  // prs_merged / prs_opened, 0 to 1, rounded to three places. null when this agent
  // has opened none.
  pr_merge_rate: number | null;
  // Share of CI conclusions the Worker checked and found green. The denominator is
  // ci_checked, not jobs_done: a job with no pull request has no CI, and counting it
  // as a miss would punish a documentation job for not having a build.
  ci_checked: number;
  ci_green_rate: number | null;
  // Whole minutes, median (one job left open over a weekend skews a mean).
  median_duration_minutes: number | null;
  // Improve-loop attempts, for drivers only; null for other kinds, which only read
  // the namespace's runs.
  attempts_kept: number | null;
  attempts_reverted: number | null;
}

// The rows the record is computed from. Grouped reads, one per shape, so the query
// count does not grow with the number of credentials.
export interface RecordRows {
  // One row per finished job, from job_outcomes.
  outcomes: Array<{
    agent: string;
    prs_opened: number | null;
    prs_merged: number | null;
    ci_green: number | null;
    blocked_count: number;
    resumed_count: number;
    duration_minutes: number | null;
    verified: string;
  }>;
  // One row per (claimed_by, status) from jobs.
  jobs: Array<{ actor: string; status: string; n: number }>;
  // One row per namespace from improve_runs.
  runs: Array<{ namespace: string; kept: number; reverts: number }>;
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // An even count averages the two middles and rounds to whole minutes.
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// Only a verified field counts toward a rate. Counts are stored whether or not the
// Worker could check them, because an unverified count is still better than nothing
// on the row. A rate is a claim about a credential that a reader acts on, and one
// built from numbers the credential reported about itself is that credential grading
// its own work. So the rates read only fields the `verified` object says were checked.
function verifiedFields(json: string): Record<string, boolean> {
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, boolean>) : {};
  } catch {
    // Corrupt means nothing verified: a rate is withheld, not invented.
    return {};
  }
}

export function recordFor(actor: string, rows: RecordRows, namespaces: "*" | string[] | null): AgentRecord {
  const mine = rows.outcomes.filter((o) => o.agent === actor);
  const jobsByStatus = (status: string) =>
    rows.jobs.filter((r) => r.actor === actor && r.status === status).reduce((total, r) => total + r.n, 0);

  // Every outcome row carries the counts; only the verified ones feed the rates.
  const prVerified = mine.filter((o) => verifiedFields(o.verified).prs_opened === true);
  const prsOpened = prVerified.reduce((total, o) => total + (o.prs_opened ?? 0), 0);
  // The merge rate reads only rows where both counts were verified, or a row verified
  // on one side only would skew it.
  const mergeVerified = prVerified.filter((o) => verifiedFields(o.verified).prs_merged === true);
  const prsMerged = mergeVerified.reduce((total, o) => total + (o.prs_merged ?? 0), 0);
  const prsOpenedForRate = mergeVerified.reduce((total, o) => total + (o.prs_opened ?? 0), 0);

  const ciChecked = mine.filter((o) => verifiedFields(o.verified).ci_green === true && o.ci_green !== null);
  const durations = mine.map((o) => o.duration_minutes).filter((d): d is number => typeof d === "number");

  const runs = namespaces === null ? [] : rows.runs.filter((r) => namespaces === "*" || namespaces.includes(r.namespace));

  return {
    actor,
    // From job statuses, not outcome rows: both done and failed write an outcome.
    jobs_done: jobsByStatus("done"),
    jobs_failed: jobsByStatus("failed"),
    jobs_blocked: jobsByStatus("blocked"),
    gates_hit: mine.reduce((total, o) => total + o.blocked_count, 0),
    resumed: mine.reduce((total, o) => total + o.resumed_count, 0),
    prs_opened: prsOpened,
    prs_merged: prsMerged,
    pr_merge_rate: rate(prsMerged, prsOpenedForRate),
    ci_checked: ciChecked.length,
    ci_green_rate: rate(ciChecked.filter((o) => o.ci_green === 1).length, ciChecked.length),
    median_duration_minutes: median(durations),
    attempts_kept: namespaces === null ? null : runs.reduce((total, r) => total + r.kept, 0),
    attempts_reverted: namespaces === null ? null : runs.reduce((total, r) => total + r.reverts, 0),
  };
}

// One record per credential. Passing null for namespaces leaves the improve-loop
// columns null, for every kind but driver.
export function recordsFrom(agents: RecordSubject[], rows: RecordRows): Record<string, AgentRecord> {
  const out: Record<string, AgentRecord> = Object.create(null);
  for (const agent of agents) {
    out[agent.name] = recordFor(agentActor(agent.name), rows, agent.kind === "driver" ? agent.namespaces : null);
  }
  return out;
}

export async function loadRecordRows(db: D1Database): Promise<RecordRows> {
  // Read whole rather than aggregated in SQL: which fields were verified lives in a
  // JSON column no GROUP BY can read, and the aggregation stays a pure function.
  //
  // A superseded job's outcome row is left out: nothing was attempted on it, so it
  // would record a failure that did not happen.
  const outcomes = await db
    .prepare(
      `SELECT agent, prs_opened, prs_merged, ci_green, blocked_count, resumed_count, duration_minutes, verified
       FROM job_outcomes o
       WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = o.job_id AND j.status = 'superseded')`
    )
    .all<RecordRows["outcomes"][number]>();
  const jobs = await db
    .prepare(
      `SELECT claimed_by AS actor, status, COUNT(*) AS n FROM jobs
       WHERE claimed_by IS NOT NULL GROUP BY claimed_by, status`
    )
    .all<{ actor: string; status: string; n: number }>();
  const runs = await db
    .prepare(
      `SELECT namespace, COALESCE(SUM(kept),0) AS kept, COALESCE(SUM(reverts),0) AS reverts
       FROM improve_runs GROUP BY namespace`
    )
    .all<{ namespace: string; kept: number; reverts: number }>();
  return { outcomes: outcomes.results ?? [], jobs: jobs.results ?? [], runs: runs.results ?? [] };
}

export async function loadAgentRecords(db: D1Database, agents: RecordSubject[]): Promise<Record<string, AgentRecord>> {
  return recordsFrom(agents, await loadRecordRows(db));
}
