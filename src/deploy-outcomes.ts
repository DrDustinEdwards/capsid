import type { Env } from "./env";
import { getDefaultBranch, ghFetch, resolveRepo } from "./github/client";
import { LOOP_ROSTER } from "./improve-schema";
import { externalFence } from "./provenance";
import type { Finding } from "./watcher";

// THE MEMORY OF A ROLLBACK (docs/design/design-merge-pipeline.md section 6, PR 6). Each
// watcher pass reads, for every DEPLOY_ROSTER repo, its newest completed default-branch push
// runs, finds the job named "live gate", or "<caller job> / live gate" when the gate runs in
// a called workflow (capsid's in .github/workflows/ci.yml; carrel's, "deploy / live gate",
// in devkit's reusable worker-deploy.yml), and records what became of the deploy in
// deploy_outcomes (migrations/0039). A rollback, or one that did not take effect,
// is a watcher finding, so it reaches Needs you and the queue; the push is PR 7.
//
// GitHub serves no step summary through its API, so the outcome is read from what it does
// serve: the job's conclusion, the conclusion of its rollback step, and the job's check-run
// annotations, where the step's ::error:: lines land ("rolled back: was A ... now B", "not
// rolling back", "the rollback did not take effect"). No CI secret is added: the App
// already reads CI.

const LIVE_JOB = "live gate";
const LIVE_JOB_SUFFIX = ` / ${LIVE_JOB}`;
// The namespaces the deploy watcher reads. carrel's live gate runs in devkit's reusable
// worker-deploy.yml; carrel is merge-only for the improve loop, so not on LOOP_ROSTER.
export const DEPLOY_ROSTER = [...LOOP_ROSTER, "carrel"] as const;

/** A live gate job: "live gate", or a called workflow's "<caller job> / live gate". */
export function isLiveGateJob(name: string): boolean {
  return name === LIVE_JOB || name.endsWith(LIVE_JOB_SUFFIX);
}

const ROLLBACK_STEP = /^Roll back/i;
const RUNS_READ = 3;

export type DeployOutcome = "verified" | "rolled_back" | "rollback_failed" | "rollback_skipped" | "unverified";

interface Job {
  id: number;
  name: string;
  conclusion: string | null;
  steps?: Array<{ name: string; conclusion: string | null }>;
}

export interface OutcomeRead {
  outcome: DeployOutcome;
  rollback_from: string | null;
  rollback_to: string | null;
  detail: string;
}

/** What a live gate job's conclusion, its rollback step and its annotations say. Null for a
 *  run whose live gate did not run (a run with no deploy). */
export function outcomeFrom(job: Job | undefined, annotations: string[]): OutcomeRead | null {
  if (!job || job.conclusion === "skipped" || job.conclusion === null || job.conclusion === "cancelled") return null;
  const rollback = (job.steps ?? []).find((s) => ROLLBACK_STEP.test(s.name));
  const said = (re: RegExp) => annotations.map((a) => re.exec(a)).find((m) => m !== null) ?? null;
  if (job.conclusion === "success" && (!rollback || rollback.conclusion === "skipped" || rollback.conclusion === null)) {
    return { outcome: "verified", rollback_from: null, rollback_to: null, detail: "the live gate passed" };
  }
  if (rollback?.conclusion === "failure") {
    const m = said(/the rollback did not take effect: \/health still reports (\S+)/);
    return { outcome: "rollback_failed", rollback_from: null, rollback_to: m?.[1] ?? null, detail: "the live gate refused the deploy and the rollback did not take effect" };
  }
  if (rollback?.conclusion === "success") {
    const back = said(/rolled back: was (\S+) \(this run's commit \S+\), now ([^.\s]+)/);
    if (back) return { outcome: "rolled_back", rollback_from: back[1]!, rollback_to: back[2]!, detail: "the live gate refused the deploy and it was rolled back" };
    if (said(/not rolling back/)) return { outcome: "rollback_skipped", rollback_from: null, rollback_to: null, detail: "the live gate refused the deploy and the guard declined to roll back: master and production may disagree" };
    return { outcome: "rollback_skipped", rollback_from: null, rollback_to: null, detail: "the rollback step succeeded but said neither that it rolled back nor that it declined" };
  }
  return { outcome: "unverified", rollback_from: null, rollback_to: null, detail: `the live gate concluded ${job.conclusion} with no rollback (it could not run, or the deploy was not this run's)` };
}

interface RunRow {
  id: number;
  head_sha: string;
  created_at: string;
  html_url: string;
}

export interface DeployRow extends OutcomeRead {
  run_id: number;
  head_sha: string;
  pr: number | null;
  run_url: string | null;
  run_at: string;
}

const mk = (namespace: string, fingerprint: string, headline: string, evidence: string[]): Finding => ({
  fingerprint,
  namespace,
  title: `Watcher: ${headline} [${fingerprint}]`,
  body: [
    "The live gate refused a deploy (docs/design/design-merge-pipeline.md section 6). Read",
    "the run, then land a fix or revert the commit; master still points at it.",
    "",
    "## Evidence",
    "",
    externalFence("watcher-evidence", fingerprint, evidence.map((line) => `- ${line}`).join("\n")),
  ].join("\n"),
  evidence,
});

/** The finding a deploy row raises: a rollback, or one that did not take effect. A verified
 *  deploy, a declined rollback and an unverified gate raise none here (a red CI run is the
 *  ci check's finding). */
export function deployFindings(namespace: string, row: DeployRow): Finding[] {
  const sha = row.head_sha.slice(0, 7);
  const evidence = [`run: ${row.run_url ?? row.run_id}`, `commit: ${row.head_sha}${row.pr ? ` (#${row.pr})` : ""}`, row.detail];
  if (row.outcome === "rolled_back") {
    return [mk(namespace, `deploy-rolled-back-${namespace}`, `${namespace} deploy ${sha} was rolled back`, [...evidence, `production went from ${row.rollback_from} back to ${row.rollback_to}`])];
  }
  if (row.outcome === "rollback_failed") {
    return [mk(namespace, `deploy-rollback-failed-${namespace}`, `${namespace} deploy ${sha} was refused and its rollback did not take effect`, [...evidence, `production may still serve ${row.rollback_to ?? "the refused deploy"}`])];
  }
  return [];
}

/** Reads one repo's newest completed push runs on its default branch, records each new one
 *  whose live gate ran, and returns the newest recorded deploy (or null when none ran). */
export async function readDeployOutcomes(env: Env, namespace: string): Promise<DeployRow | null> {
  const { owner, repo, full } = await resolveRepo(env, namespace);
  const branch = await getDefaultBranch(env, owner, repo);
  const listed = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&event=push&status=completed&per_page=${RUNS_READ}`);
  if (!listed.ok) throw new Error(`the run list returned ${listed.status}`);
  const runs = (((await listed.json()) as { workflow_runs?: RunRow[] }).workflow_runs ?? []).sort((a, b) => b.id - a.id);
  if (!runs.length) return null;
  const { results } = await env.DB.prepare(
    `SELECT run_id, head_sha, pr, outcome, rollback_from, rollback_to, detail, run_url, run_at FROM deploy_outcomes
     WHERE repo = ?1 AND run_id IN (SELECT value FROM json_each(?2))`
  )
    .bind(full, JSON.stringify(runs.map((r) => r.id)))
    .all<DeployRow>();
  const known = new Map((results ?? []).map((r) => [r.run_id, r]));
  let newest: DeployRow | null = null;
  for (const run of runs) {
    let row = known.get(run.id) ?? null;
    if (!row) {
      const jobsResp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
      if (!jobsResp.ok) throw new Error(`the jobs of run ${run.id} returned ${jobsResp.status}`);
      const job = (((await jobsResp.json()) as { jobs?: Job[] }).jobs ?? []).find((j) => isLiveGateJob(j.name));
      let annotations: string[] = [];
      if (job && job.conclusion !== "success" && job.conclusion !== "skipped") {
        const notes = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/check-runs/${job.id}/annotations?per_page=100`);
        if (!notes.ok) throw new Error(`the annotations of job ${job.id} returned ${notes.status}`);
        annotations = ((await notes.json()) as Array<{ message?: string }>).map((a) => a.message ?? "");
      }
      const read = outcomeFrom(job, annotations);
      if (!read) continue;
      // The pull request the commit came from, when GitHub knows one.
      const pulls = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/commits/${run.head_sha}/pulls`);
      const pr = pulls.ok ? ((((await pulls.json()) as Array<{ number?: number }>)[0]?.number as number | undefined) ?? null) : null;
      row = { ...read, run_id: run.id, head_sha: run.head_sha, pr, run_url: run.html_url ?? null, run_at: run.created_at };
      await env.DB.prepare(
        `INSERT OR IGNORE INTO deploy_outcomes (repo, namespace, run_id, head_sha, pr, outcome, rollback_from, rollback_to, detail, run_url, run_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
      )
        .bind(full, namespace, row.run_id, row.head_sha, row.pr, row.outcome, row.rollback_from, row.rollback_to, row.detail, row.run_url, row.run_at)
        .run();
    }
    newest ??= row;
  }
  return newest;
}
