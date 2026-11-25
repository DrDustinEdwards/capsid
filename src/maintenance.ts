import type { Env } from "./env";
import type { OpsMaintenanceItem } from "./ops-types/views";
import { ROSTER } from "./roster";
import { gatherBranchItems, githubBranchReaders, type BranchReaders } from "./maintenance-branches";
import { gatherPrItems, githubPrReaders, type PrReaders } from "./maintenance-prs";
import { gatherDeployItems, githubDeployReaders, type DeployReaders } from "./maintenance-deploys";
import {
  gatherReleaseItems,
  githubReleaseReaders,
  type ReleaseReaders,
} from "./maintenance-releases";
import { gatherModelDriftItems } from "./model-drift";
import { readFactsDrift } from "./system-facts-store";
import { bundledModel } from "./public-data";
import { gatherRuleDocItems } from "./rule-docs";
import { DAY_MS } from "./time";
import { MERGE_RESUME_ACTOR } from "./jobs-seat-auto";

// The tags ride this daily pass, not the five-minute tick: tagging within a day is soon enough for
// the bump pull requests they start, and the pass already has the switch, the cap, the audit
// pattern and the list where a version it would not tag belongs.

const MAINTENANCE_KEY = "maintenance:list";
export const MAINTENANCE_LAST_KEY = "maintenance:last";

// The pass runs once per UTC day, after this hour, so the list is fresh when the seat starts a
// session in the morning (06:00 in Chicago is 11:00 or 12:00 UTC).
const DAILY_AFTER_UTC_HOUR = 11;
const MAX_ITEMS_PER_RULE = 50;
const FOLLOWUP_PROMISE = /follow(?:[- ]?ups?)?\b[^.]{0,60}\bseparate jobs?/i;
const LATER_DATE = /\bLATER\b[^0-9]{0,40}(\d{4}-\d{2}-\d{2})/i;

// The item is the Portal's contract too (GET /portal/api/maintenance), so it lives with the other
// Portal types in src/ops-types/.
/** The model drift check, injected so a test can run the pass without GitHub. */
export type DriftReader = (env: Env) => Promise<{ items: MaintenanceItem[]; read: number }>;

export type MaintenanceItem = OpsMaintenanceItem;

interface MaintenanceList {
  generated: string;
  items: MaintenanceItem[];
  prs_read: Record<string, number>;
  branches_read: Record<string, number>;
  deploys_read: Record<string, number>;
  model_read: number;
  /** Rule documents checked for their cap and for stale tool names (src/rule-docs.ts). */
  rule_docs_read: number;
  releases_read: number;
}

type MaintenanceReport =
  | { ran: false; note: string }
  | { ran: true; note: string; list: MaintenanceList };

export function laterPassed(
  jobs: Array<{ id: string; namespace: string; title: string }>,
  today: string,
): MaintenanceItem[] {
  const out: MaintenanceItem[] = [];
  for (const j of jobs) {
    const date = LATER_DATE.exec(j.title)?.[1];
    if (date && date < today) {
      out.push({
        rule: "later-passed",
        namespace: j.namespace,
        job: j.id,
        line: `${j.id} is queued as LATER ${date}, a date that has passed: re-title it or work it.`,
      });
    }
  }
  return out;
}

/**
 * Whether `body` names the pull request `url` as a whole, not as the prefix of a longer number
 * (".../pull/1" must not match ".../pull/12").
 */
export function namesPullRequest(body: string, url: string): boolean {
  let from = body.indexOf(url);
  while (from !== -1) {
    const next = body.charAt(from + url.length);
    if (!/[0-9]/.test(next)) return true;
    from = body.indexOf(url, from + 1);
  }
  return false;
}

export function promisesFollowUps(summary: string | null): boolean {
  return summary !== null && FOLLOWUP_PROMISE.test(summary);
}

export async function gatherMaintenance(
  env: Env,
  now: Date,
  prReaders: PrReaders = githubPrReaders(env),
  branchReaders: BranchReaders = githubBranchReaders(env),
  deployReaders: DeployReaders = githubDeployReaders(env),
  // The model's own drift, then the versions and secrets models' from the nightly build.
  driftReader: DriftReader = async (e) => {
    const [model, facts] = [
      await gatherModelDriftItems(e, bundledModel()),
      await readFactsDrift(e, now),
    ];
    return { items: [...model.items, ...facts.items], read: model.read + facts.read };
  },
  releaseReaders: ReleaseReaders = githubReleaseReaders(env),
): Promise<MaintenanceList> {
  const today = now.toISOString().slice(0, 10);
  const items: MaintenanceItem[] = [];

  const queuedLater = await env.DB.prepare(
    "SELECT id, namespace, title FROM jobs WHERE status = 'queued' AND title LIKE '%LATER%' LIMIT ?1",
  )
    .bind(MAX_ITEMS_PER_RULE)
    .all<{ id: string; namespace: string; title: string }>();
  items.push(...laterPassed(queuedLater.results ?? [], today));

  // A queued job whose body names a pull request that merged under ANOTHER job: the work it asks for
  // has probably shipped. The instr() is a prefilter; namesPullRequest is the check, because a short
  // number is the prefix of a longer one.
  const shipped = await env.DB.prepare(
    `SELECT j.id, j.namespace, j.body, p.pr_url, p.job_id AS shipped_by
       FROM jobs j JOIN job_outcome_prs p ON p.merged = 1 AND p.job_id != j.id AND instr(j.body, p.pr_url) > 0
      WHERE j.status = 'queued' LIMIT ?1`,
  )
    .bind(MAX_ITEMS_PER_RULE * 4)
    .all<{ id: string; namespace: string; body: string; pr_url: string; shipped_by: string }>();
  const seen = new Set<string>();
  for (const row of shipped.results ?? []) {
    if (seen.has(row.id) || !namesPullRequest(row.body, row.pr_url)) continue;
    seen.add(row.id);
    items.push({
      rule: "shipped-elsewhere",
      namespace: row.namespace,
      job: row.id,
      line: `${row.id} is queued but names ${row.pr_url}, which merged under ${row.shipped_by}: supersede it if that was the work.`,
    });
  }

  // A finished or blocked job that said follow-ups would be posted as separate jobs, with no job
  // created in its namespace since it last moved. A heuristic that lists, never acts.
  const promised = await env.DB.prepare(
    "SELECT id, namespace, result_summary, updated_at FROM jobs WHERE status IN ('done', 'blocked') AND result_summary LIKE '%separate job%' LIMIT ?1",
  )
    .bind(MAX_ITEMS_PER_RULE)
    .all<{ id: string; namespace: string; result_summary: string | null; updated_at: string }>();
  for (const row of promised.results ?? []) {
    if (!promisesFollowUps(row.result_summary)) continue;
    const later = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE namespace = ?1 AND created_at > ?2",
    )
      .bind(row.namespace, row.updated_at)
      .first<{ n: number }>();
    if ((later?.n ?? 0) === 0) {
      items.push({
        rule: "followups-missing",
        namespace: row.namespace,
        job: row.id,
        line: `${row.id} promised follow-up jobs, and none was posted in ${row.namespace} since: post them or say they are not coming.`,
      });
    }
  }

  // What the merge-resume step did in the last day, so the seat sees it was done for them.
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const resumed = await env.DB.prepare(
    `SELECT t.job_id AS job_id, t.namespace AS namespace FROM job_touches t JOIN jobs j ON j.id = t.job_id
      WHERE t.actor = ?1 AND t.kind = 'resume' AND t.at >= ?2 LIMIT ?3`,
  )
    .bind(MERGE_RESUME_ACTOR, since, MAX_ITEMS_PER_RULE)
    .all<{ job_id: string; namespace: string }>();
  for (const row of resumed.results ?? []) {
    items.push({
      rule: "auto-resumed",
      namespace: row.namespace,
      job: row.job_id,
      line: `${row.job_id} was resumed because its pull requests merged: its holder confirms the deploy and completes it.`,
    });
  }

  const prs = await gatherPrItems(ROSTER, prReaders, now);
  items.push(...prs.items);

  const branches = await gatherBranchItems(env, ROSTER, branchReaders, now);
  items.push(...branches.items);

  const deploys = await gatherDeployItems(deployReaders, now);
  items.push(...deploys.items);

  // system/model.json against what Capsid and GitHub know (src/model-drift.ts).
  const drift = await driftReader(env);
  items.push(...drift.items);

  // A rule document over its cap or naming a tool the Worker does not serve.
  const ruleDocs = await gatherRuleDocItems(env.DB);
  items.push(...ruleDocs.items);

  const releases = await gatherReleaseItems(env, releaseReaders);
  items.push(...releases.items);

  return {
    generated: now.toISOString(),
    items,
    prs_read: prs.read,
    branches_read: branches.read,
    deploys_read: deploys.read,
    model_read: drift.read,
    rule_docs_read: ruleDocs.read,
    releases_read: releases.read,
  };
}

/**
 * The daily pass. Not due returns a note and records nothing; due gathers the list, keeps it in KV
 * for capsid_read_status action status, and stamps the day. The stamp is written after the list,
 * so a pass that threw runs again on the next tick.
 */
export async function maintenanceTick(
  env: Env,
  now: Date,
  prReaders?: PrReaders,
  branchReaders?: BranchReaders,
  deployReaders?: DeployReaders,
  driftReader?: DriftReader,
  releaseReaders?: ReleaseReaders,
): Promise<MaintenanceReport> {
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < DAILY_AFTER_UTC_HOUR)
    return { ran: false, note: `before ${DAILY_AFTER_UTC_HOUR}:00 UTC` };
  const last = await env.APP_KV.get(MAINTENANCE_LAST_KEY).catch(() => null);
  if (last && last.slice(0, 10) === today) return { ran: false, note: `already ran ${last}` };
  const list = await gatherMaintenance(
    env,
    now,
    prReaders,
    branchReaders,
    deployReaders,
    driftReader,
    releaseReaders,
  );
  await env.APP_KV.put(MAINTENANCE_KEY, JSON.stringify(list));
  await env.APP_KV.put(MAINTENANCE_LAST_KEY, now.toISOString());
  const prsRead = Object.values(list.prs_read).reduce((a, b) => a + b, 0);
  const reposRead = Object.keys(list.prs_read).length;
  const branchesRead = Object.values(list.branches_read).reduce((a, b) => a + b, 0);
  const branchRepos = Object.keys(list.branches_read).length;
  const pruned = list.items.filter((i) => i.rule === "branch-pruned").length;
  const deploySites = Object.keys(list.deploys_read).length;
  const tagged = list.items.filter((i) => i.rule === "release-tagged").length;
  return {
    ran: true,
    note: `${list.items.length} item(s) listed; ${prsRead} open pull request(s) read in ${reposRead} of ${ROSTER.length} repo(s); ${branchesRead} branch(es) read in ${branchRepos} of ${ROSTER.length} repo(s), ${pruned} pruned; ${deploySites} site deploy(s) compared; ${list.model_read} fact(s) compared with the system model; ${list.rule_docs_read} rule document(s) checked; ${list.releases_read} shared package version(s) compared with their tags, ${tagged} tagged`,
    list,
  };
}

/** The stored list, or null when none was ever written or it cannot be read. */
export async function readMaintenance(env: Env): Promise<MaintenanceList | null> {
  const raw = await env.APP_KV.get(MAINTENANCE_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MaintenanceList;
    if (!Array.isArray(parsed.items) || typeof parsed.generated !== "string") return null;
    // A list written before a rule existed read nothing for it.
    const counts = (v: unknown): Record<string, number> =>
      v && typeof v === "object" ? (v as Record<string, number>) : {};
    return {
      ...parsed,
      // The disk rule was removed; a list stored before then may still carry its items.
      items: parsed.items.filter((i) => !i.rule.startsWith("disk-")),
      prs_read: counts(parsed.prs_read),
      branches_read: counts(parsed.branches_read),
      deploys_read: counts(parsed.deploys_read),
      model_read: typeof parsed.model_read === "number" ? parsed.model_read : 0,
      rule_docs_read: typeof parsed.rule_docs_read === "number" ? parsed.rule_docs_read : 0,
      releases_read: typeof parsed.releases_read === "number" ? parsed.releases_read : 0,
    };
  } catch {
    return null;
  }
}
