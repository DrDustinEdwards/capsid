import { agentActor } from "./agents-schema";
import type { AgentSummary } from "./improve-run";

// The reputation panel: what each credential has done, as counts, not scores. A
// score needs a weighting, which is an opinion about how much to trust a credential;
// every number here is a row count with a name on it, and the reader decides.
//
// This is the one place the console queries something of its own, because no tool
// computes it: improve_status serves the inventory and says nothing about what any
// agent did. The aggregation is a pure function over rows, tested against fixtures
// rather than a fake that would agree with whatever it was handed.

export interface ReputationRows {
  // One row per (claimed_by, status) from the jobs table.
  jobs: Array<{ actor: string; status: string; n: number }>;
  prsOpened: Array<{ actor: string; n: number }>;
  prsMerged: Array<{ actor: string; n: number }>;
  // One row per namespace from improve_runs.
  runs: Array<{ namespace: string; kept: number; reverts: number }>;
}

export interface AgentReputation extends AgentSummary {
  jobs_completed: number;
  jobs_failed: number;
  jobs_blocked: number;
  prs_opened: number;
  prs_merged: number;
  // null except for a driver: attempts belong to the namespace's improve runs, not
  // to every credential that can read there.
  attempts_kept: number | null;
  attempts_reverted: number | null;
}

function sumBy(rows: Array<{ actor: string; n: number }>, actor: string): number {
  return rows.filter((r) => r.actor === actor).reduce((total, r) => total + r.n, 0);
}

export function reputationFrom(agents: AgentSummary[], rows: ReputationRows): AgentReputation[] {
  return agents.map((agent) => {
    // The actor string (`agent:<name>`), which jobs.claimed_by and audit_log.actor
    // carry; a bare name could match a different kind of caller.
    const actor = agentActor(agent.name);
    const jobsByStatus = (status: string) =>
      rows.jobs.filter((r) => r.actor === actor && r.status === status).reduce((total, r) => total + r.n, 0);
    const isDriver = agent.kind === "driver";
    const runs = isDriver
      ? rows.runs.filter((r) => agent.namespaces === "*" || agent.namespaces.includes(r.namespace))
      : [];
    return {
      ...agent,
      jobs_completed: jobsByStatus("done"),
      jobs_failed: jobsByStatus("failed"),
      jobs_blocked: jobsByStatus("blocked"),
      prs_opened: sumBy(rows.prsOpened, actor),
      prs_merged: sumBy(rows.prsMerged, actor),
      attempts_kept: isDriver ? runs.reduce((t, r) => t + r.kept, 0) : null,
      attempts_reverted: isDriver ? runs.reduce((t, r) => t + r.reverts, 0) : null,
    };
  });
}

export async function loadReputation(db: D1Database, agents: AgentSummary[]): Promise<AgentReputation[]> {
  // Grouped reads, so the query count does not grow with the number of agents.
  const jobs = await db
    .prepare(
      `SELECT claimed_by AS actor, status, COUNT(*) AS n FROM jobs
       WHERE claimed_by IS NOT NULL GROUP BY claimed_by, status`
    )
    .all<{ actor: string; status: string; n: number }>();
  const prsOpened = await db
    .prepare("SELECT actor, COUNT(*) AS n FROM audit_log WHERE action = 'open_pr' GROUP BY actor")
    .all<{ actor: string; n: number }>();
  // A merge is a manage_pr row whose stored result says it merged; a close carries no
  // such key. Matched as a substring of params, which this Worker writes.
  const prsMerged = await db
    .prepare(
      `SELECT actor, COUNT(*) AS n FROM audit_log
       WHERE action = 'manage_pr' AND params LIKE '%"merged":true%' GROUP BY actor`
    )
    .all<{ actor: string; n: number }>();
  const runs = await db
    .prepare(
      `SELECT namespace, COALESCE(SUM(kept),0) AS kept, COALESCE(SUM(reverts),0) AS reverts
       FROM improve_runs GROUP BY namespace`
    )
    .all<{ namespace: string; kept: number; reverts: number }>();
  return reputationFrom(agents, {
    jobs: jobs.results ?? [],
    prsOpened: prsOpened.results ?? [],
    prsMerged: prsMerged.results ?? [],
    runs: runs.results ?? [],
  });
}
