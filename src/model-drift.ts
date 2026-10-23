import type { Env } from "./env";
import type { OpsMaintenanceItem } from "./ops-types/views";
import { listInstalledRepos, parseReposList, type InstalledRepo } from "./github/client";
import { logEvent } from "./log";
import { readSiteConfig, sitesFrom } from "./ops-sites";
import type { SystemModel } from "./system-model";

// The model's drift check, the daily half (design capsid/research/design-system-explorer.md,
// section 1; docs/public-data.md). system/model.json is written by hand, so it falls
// behind what Capsid knows: a repo mapped to a namespace or installed for the App that
// the model never names, a repo the model names that GitHub no longer lists, a watched
// site whose host is no model system's domain. Each is one line in the daily maintenance
// list. The check lists and never edits: the model changes by pull request. Every repo,
// private ones included, belongs in the model (Dustin, 2026-10-23).

const MAX_ITEMS = 50;

export interface DriftFacts {
  /** Every repo a namespace maps, with its namespace. */
  mapped: Array<{ namespace: string; repo: string }>;
  /** Every repo the App can see, or null when the listing could not be read. */
  installed: InstalledRepo[] | null;
  /** Each watched site's host, by namespace. */
  sites: Array<{ namespace: string; host: string }>;
}

function hostCovered(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** The drift lines, both ways, and how many facts were compared. Pure. */
export function modelDrift(model: SystemModel, facts: DriftFacts): { items: OpsMaintenanceItem[]; read: number } {
  const items: OpsMaintenanceItem[] = [];
  const modelRepos = new Map<string, string>();
  for (const s of model.systems) for (const r of s.repos) modelRepos.set(r.toLowerCase(), s.id);
  const known = (repo: string) => modelRepos.has(repo.toLowerCase());
  const add = (namespace: string, line: string) => {
    if (items.length < MAX_ITEMS) items.push({ rule: "model-drift", namespace, job: null, line });
  };

  const flagged = new Set<string>();
  for (const { namespace, repo } of facts.mapped) {
    if (known(repo) || flagged.has(repo.toLowerCase())) continue;
    flagged.add(repo.toLowerCase());
    add(namespace, `${repo} is mapped to ${namespace} but is not in system/model.json: add it.`);
  }

  if (facts.installed === null) {
    items.push({ rule: "model-not-checked", namespace: "capsid", job: null, line: "The App's repo list could not be read, so the model was not compared with GitHub today." });
  } else {
    const live = new Map(facts.installed.map((r) => [r.full_name.toLowerCase(), r]));
    for (const r of facts.installed) {
      if (r.archived || known(r.full_name) || flagged.has(r.full_name.toLowerCase())) continue;
      flagged.add(r.full_name.toLowerCase());
      add("capsid", `${r.full_name} is installed for the App but is not in system/model.json: add it.`);
    }
    for (const [repo, system] of modelRepos) {
      if (!live.has(repo)) add("capsid", `system/model.json names ${repo} (system ${system}), which the App does not list: fix the model, or install the App there.`);
    }
  }

  const domains = model.systems.flatMap((s) => (s.domain ? [s.domain] : []));
  for (const { namespace, host } of facts.sites) {
    if (!hostCovered(host, domains)) add(namespace, `The watched site ${host} is no model system's domain: add the domain to its system in system/model.json.`);
  }

  return { items, read: facts.mapped.length + (facts.installed?.length ?? 0) + facts.sites.length };
}

/** Reads the facts and runs the check, for the daily maintenance pass. */
export async function gatherModelDriftItems(
  env: Env,
  model: SystemModel,
  listRepos: (env: Env) => Promise<{ repos: InstalledRepo[] }> = listInstalledRepos
): Promise<{ items: OpsMaintenanceItem[]; read: number }> {
  const rows = await env.DB.prepare("SELECT namespace, repos FROM namespaces").all<{ namespace: string; repos: string }>();
  const mapped: DriftFacts["mapped"] = [];
  const unreadable: OpsMaintenanceItem[] = [];
  for (const row of rows.results ?? []) {
    const parsed = parseReposList(row.repos);
    if ("list" in parsed) for (const r of parsed.list) mapped.push({ namespace: row.namespace, repo: r.repo });
    else unreadable.push({ rule: "model-not-checked", namespace: row.namespace, job: null, line: `${row.namespace}'s repo mapping could not be read (${parsed.error}), so its repos were not compared with the model.` });
  }

  // A failed listing becomes a model-not-checked line in the list (modelDrift), and the
  // rest of the check still runs.
  let installed: InstalledRepo[] | null = null;
  try {
    installed = (await listRepos(env)).repos;
  } catch (e) {
    logEvent("error", "MODEL_DRIFT_LIST_FAILED", { message: `MODEL_DRIFT_LIST_FAILED ${e instanceof Error ? e.message : String(e)}` });
  }

  const sites = sitesFrom(await readSiteConfig(env.DB)).map((s) => ({ namespace: s.namespace, host: new URL(s.origin).hostname }));
  const drift = modelDrift(model, { mapped, installed, sites });
  return { items: [...unreadable, ...drift.items], read: drift.read };
}
