import type { Env } from "./env";
import { getDefaultBranch, ghFetch, resolveRepo } from "./github/client";
import { APP_ROSTER } from "./roster";
import { externalFence } from "./provenance";
import type { Finding } from "./watcher-detect";

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
// The repos the deploy watcher reads: each by its namespace, and by its repo label where the
// repo is not the namespace's primary. `key` names the fingerprint, so two repos of one
// namespace never share a finding. carrel's live gate runs in devkit's reusable
// worker-deploy.yml; carrel is not on APP_ROSTER (src/roster.ts). Julie, txasm, bsw and the
// static sites (Capsomer, Prelum's specimen, Carrel's public page, the capsid explorer) deploy
// through worker-deploy too. Prelum has no namespace of its own: it is the dustinedwards
// namespace's "prelum" repo. A run with two live gates (carrel's app and public site) records
// the one that did not pass, else the first. Enarratio's gallery deploys through worker-deploy
// too (checklist F4, 2026-11-01).
export interface DeployRepo {
  key: string;
  namespace: string;
  selector?: string;
}
export const DEPLOY_ROSTER: readonly DeployRepo[] = [
  ...[...APP_ROSTER, "carrel", "julieedwards", "txasm", "bsw", "capsomer", "enarratio"].map((namespace) => ({ key: namespace, namespace })),
  { key: "prelum", namespace: "dustinedwards", selector: "prelum" },
];

/** A live gate job: "live gate", or a called workflow's "<caller job> / live gate". */
export function isLiveGateJob(name: string): boolean {
  return name === LIVE_JOB || name.endsWith(LIVE_JOB_SUFFIX);
}

const ROLLBACK_STEP = /^Roll back/i;
const RUNS_READ = 3;

type DeployOutcome = "verified" | "rolled_back" | "rollback_failed" | "rollback_skipped" | "unverified";

interface Job {
  id: number;
  name: string;
  conclusion: string | null;
  completed_at?: string | null;
  steps?: Array<{ name: string; conclusion: string | null; completed_at?: string | null }>;
}

/** Seconds production served the refused deploy: from the end of the gate's own deploy job
 *  (the ship) to the end of the rollback step that put the last version back (DORA's time to
 *  restore). Null when either time is missing. The deploy job is the gate's sibling: "deploy"
 *  beside capsid's "live gate", "<caller job> / deploy" beside a called worker-deploy's
 *  "<caller job> / live gate", so a run with two deploys (carrel's) pairs each with its own. */
function restoreSeconds(jobs: readonly Job[], gate: Job): number | null {
  const deployName = `${gate.name.slice(0, gate.name.length - LIVE_JOB.length)}deploy`;
  const ship = jobs.find((j) => j.name === deployName)?.completed_at;
  const back = (gate.steps ?? []).find((s) => ROLLBACK_STEP.test(s.name))?.completed_at;
  if (!ship || !back) return null;
  const seconds = Math.round((Date.parse(back) - Date.parse(ship)) / 1000);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
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
  restore_seconds: number | null;
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
export function deployFindings(namespace: string, row: DeployRow, key: string = namespace): Finding[] {
  const sha = row.head_sha.slice(0, 7);
  const evidence = [`run: ${row.run_url ?? row.run_id}`, `commit: ${row.head_sha}${row.pr ? ` (#${row.pr})` : ""}`, row.detail];
  if (row.outcome === "rolled_back") {
    return [mk(namespace, `deploy-rolled-back-${key}`, `${key} deploy ${sha} was rolled back`, [...evidence, `production went from ${row.rollback_from} back to ${row.rollback_to}`])];
  }
  if (row.outcome === "rollback_failed") {
    return [mk(namespace, `deploy-rollback-failed-${key}`, `${key} deploy ${sha} was refused and its rollback did not take effect`, [...evidence, `production may still serve ${row.rollback_to ?? "the refused deploy"}`])];
  }
  return [];
}

/** Reads one repo's newest completed push runs on its default branch, records each new one
 *  whose live gate ran, and returns the newest recorded deploy (or null when none ran). */
export async function readDeployOutcomes(env: Env, namespace: string, selector?: string): Promise<DeployRow | null> {
  const { owner, repo, full } = await resolveRepo(env, namespace, selector);
  const branch = await getDefaultBranch(env, owner, repo);
  const listed = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&event=push&status=completed&per_page=${RUNS_READ}`);
  if (!listed.ok) throw new Error(`the run list returned ${listed.status}`);
  const runs = (((await listed.json()) as { workflow_runs?: RunRow[] }).workflow_runs ?? []).sort((a, b) => b.id - a.id);
  if (!runs.length) return null;
  const { results } = await env.DB.prepare(
    `SELECT run_id, head_sha, pr, outcome, rollback_from, rollback_to, detail, run_url, run_at, restore_seconds FROM deploy_outcomes
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
      const jobs = ((await jobsResp.json()) as { jobs?: Job[] }).jobs ?? [];
      const gates = jobs.filter((j) => isLiveGateJob(j.name));
      const job = gates.find((j) => j.conclusion !== "success" && j.conclusion !== "skipped") ?? gates[0];
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
      const restore = read.outcome === "rolled_back" && job ? restoreSeconds(jobs, job) : null;
      row = { ...read, run_id: run.id, restore_seconds: restore, head_sha: run.head_sha, pr, run_url: run.html_url ?? null, run_at: run.created_at };
      await env.DB.prepare(
        `INSERT OR IGNORE INTO deploy_outcomes (repo, namespace, run_id, head_sha, pr, outcome, rollback_from, rollback_to, detail, run_url, run_at, restore_seconds)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
      )
        .bind(full, namespace, row.run_id, row.head_sha, row.pr, row.outcome, row.rollback_from, row.rollback_to, row.detail, row.run_url, row.run_at, row.restore_seconds)
        .run();
    }
    newest ??= row;
  }
  return newest;
}
