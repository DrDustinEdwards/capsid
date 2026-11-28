import type { Env } from "./env";
import type { OpsMaintenanceItem } from "./ops-types/views";
import { ROSTER } from "./roster";
import { gatherBranchItems, githubBranchReaders, type BranchReaders } from "./maintenance-branches";
import { gatherPrItems, githubPrReaders, type PrReaders } from "./maintenance-prs";
import { gatherDeployItems, githubDeployReaders, type DeployReaders } from "./maintenance-deploys";
import { gatherModelDriftItems } from "./model-drift";
import { readFactsDrift } from "./system-facts-store";
import { bundledModel } from "./public-data";
import { gatherRuleDocItems } from "./rule-docs";

const MAINTENANCE_KEY = "maintenance:list";
export const MAINTENANCE_LAST_KEY = "maintenance:last";

// The pass runs once per UTC day, after this hour, so the list is fresh when the seat starts a
// session in the morning (06:00 in Chicago is 11:00 or 12:00 UTC).
const DAILY_AFTER_UTC_HOUR = 11;

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
}

type MaintenanceReport =
  | { ran: false; note: string }
  | { ran: true; note: string; list: MaintenanceList };

async function gatherMaintenance(
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
): Promise<MaintenanceList> {
  const items: MaintenanceItem[] = [];

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

  return {
    generated: now.toISOString(),
    items,
    prs_read: prs.read,
    branches_read: branches.read,
    deploys_read: deploys.read,
    model_read: drift.read,
    rule_docs_read: ruleDocs.read,
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
  );
  await env.APP_KV.put(MAINTENANCE_KEY, JSON.stringify(list));
  await env.APP_KV.put(MAINTENANCE_LAST_KEY, now.toISOString());
  const prsRead = Object.values(list.prs_read).reduce((a, b) => a + b, 0);
  const reposRead = Object.keys(list.prs_read).length;
  const branchesRead = Object.values(list.branches_read).reduce((a, b) => a + b, 0);
  const branchRepos = Object.keys(list.branches_read).length;
  const pruned = list.items.filter((i) => i.rule === "branch-pruned").length;
  const deploySites = Object.keys(list.deploys_read).length;
  return {
    ran: true,
    note: `${list.items.length} item(s) listed; ${prsRead} open pull request(s) read in ${reposRead} of ${ROSTER.length} repo(s); ${branchesRead} branch(es) read in ${branchRepos} of ${ROSTER.length} repo(s), ${pruned} pruned; ${deploySites} site deploy(s) compared; ${list.model_read} fact(s) compared with the system model; ${list.rule_docs_read} rule document(s) checked`,
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
      // The disk and release-tag rules were removed; a list stored before then may still carry their items.
      items: parsed.items.filter((i) => !i.rule.startsWith("disk-") && !i.rule.startsWith("release-")),
      prs_read: counts(parsed.prs_read),
      branches_read: counts(parsed.branches_read),
      deploys_read: counts(parsed.deploys_read),
      model_read: typeof parsed.model_read === "number" ? parsed.model_read : 0,
      rule_docs_read: typeof parsed.rule_docs_read === "number" ? parsed.rule_docs_read : 0,
    };
  } catch {
    return null;
  }
}
