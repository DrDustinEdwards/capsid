import type { Env } from "./env";
import type { OpsMaintenanceItem } from "./ops-types/views";
import { ROSTER } from "./roster";
import { gatherBranchItems, githubBranchReaders, type BranchReaders } from "./maintenance-branches";
import { gatherPrItems, githubPrReaders, type PrReaders } from "./maintenance-prs";
import { gatherModelDriftItems } from "./model-drift";
import { readFactsDrift } from "./system-facts-store";
import { bundledModel } from "./public-data";
import { gatherRuleDocItems } from "./rule-docs";

const MAINTENANCE_KEY = "maintenance:list";
export const MAINTENANCE_LAST_KEY = "maintenance:last";
// Set for an hour after a pass throws, so a failing pass is not retried on every tick.
export const MAINTENANCE_RETRY_KEY = "maintenance:retry";

// Once per UTC day after this hour, so the list is fresh for the morning (06:00 in Chicago).
const DAILY_AFTER_UTC_HOUR = 11;

/** The model drift check, injected so a test can run the pass without GitHub. */
export type DriftReader = (env: Env) => Promise<{ items: MaintenanceItem[]; read: number }>;

export type MaintenanceItem = OpsMaintenanceItem;

interface MaintenanceList {
  generated: string;
  items: MaintenanceItem[];
  prs_read: Record<string, number>;
  branches_read: Record<string, number>;
  model_read: number;
  rule_docs_read: number;
}

type MaintenanceReport =
  | { ran: false; note: string }
  | { ran: true; note: string; list: MaintenanceList };

async function gatherMaintenance(
  env: Env,
  now: Date,
  prReaders: PrReaders = githubPrReaders(env),
  branchReaders: BranchReaders = githubBranchReaders(env),
  // The model's own drift, then the versions and secrets models' from the nightly build.
  driftReader: DriftReader = async (e) => {
    const [model, facts] = [
      await gatherModelDriftItems(e, bundledModel()),
      await readFactsDrift(e, now),
    ];
    return { items: [...model.items, ...facts.items], read: model.read + facts.read };
  },
): Promise<MaintenanceList> {
  const items: MaintenanceItem[] = [];

  const prs = await gatherPrItems(ROSTER, prReaders, now);
  items.push(...prs.items);

  const branches = await gatherBranchItems(env, ROSTER, branchReaders, now);
  items.push(...branches.items);

  const drift = await driftReader(env);
  items.push(...drift.items);

  const ruleDocs = await gatherRuleDocItems(env.DB);
  items.push(...ruleDocs.items);

  return {
    generated: now.toISOString(),
    items,
    prs_read: prs.read,
    branches_read: branches.read,
    model_read: drift.read,
    rule_docs_read: ruleDocs.read,
  };
}

/**
 * The daily pass. Not due returns a note and records nothing; due gathers the list, keeps it in KV
 * for capsid_read_status action status, and stamps the day. A pass that threw runs again an hour
 * later.
 */
export async function maintenanceTick(
  env: Env,
  now: Date,
  prReaders?: PrReaders,
  branchReaders?: BranchReaders,
  driftReader?: DriftReader,
): Promise<MaintenanceReport> {
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < DAILY_AFTER_UTC_HOUR)
    return { ran: false, note: `before ${DAILY_AFTER_UTC_HOUR}:00 UTC` };
  const last = await env.APP_KV.get(MAINTENANCE_LAST_KEY).catch(() => null);
  if (last && last.slice(0, 10) === today) return { ran: false, note: `already ran ${last}` };
  if (await env.APP_KV.get(MAINTENANCE_RETRY_KEY))
    return { ran: false, note: "the last pass threw; it runs again within the hour" };
  const list = await gatherMaintenance(env, now, prReaders, branchReaders, driftReader).catch(
    async (err: unknown) => {
      await env.APP_KV.put(MAINTENANCE_RETRY_KEY, "1", { expirationTtl: 3600 });
      throw err;
    },
  );
  await env.APP_KV.put(MAINTENANCE_KEY, JSON.stringify(list));
  await env.APP_KV.put(MAINTENANCE_LAST_KEY, now.toISOString());
  const prsRead = Object.values(list.prs_read).reduce((a, b) => a + b, 0);
  const reposRead = Object.keys(list.prs_read).length;
  const branchesRead = Object.values(list.branches_read).reduce((a, b) => a + b, 0);
  const branchRepos = Object.keys(list.branches_read).length;
  const pruned = list.items.filter((i) => i.rule === "branch-pruned").length;
  return {
    ran: true,
    note: `${list.items.length} item(s) listed; ${prsRead} open pull request(s) read in ${reposRead} of ${ROSTER.length} repo(s); ${branchesRead} branch(es) read in ${branchRepos} of ${ROSTER.length} repo(s), ${pruned} pruned; ${list.model_read} fact(s) compared with the system model; ${list.rule_docs_read} rule document(s) checked`,
    list,
  };
}

/** The stored list, or null when none was ever written or it cannot be read. */
export async function readMaintenance(env: Env): Promise<MaintenanceList | null> {
  const raw = await env.APP_KV.get(MAINTENANCE_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MaintenanceList;
    return Array.isArray(parsed.items) && typeof parsed.generated === "string" ? parsed : null;
  } catch {
    return null;
  }
}
