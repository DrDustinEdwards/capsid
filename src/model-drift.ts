import type { Env } from "./env";
import type { OpsMaintenanceItem } from "./ops-types/views";
import { listInstalledRepos, parseMappedRepos, type InstalledRepo } from "./github/client";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { readSiteConfig, sitesFrom } from "./ops-sites";
import type { SystemModel } from "./system-model";

// The model's daily drift check. It lists and never edits: the model changes by pull request.

const MAX_ITEMS = 50;

export interface DriftFacts {
  mapped: Array<{ namespace: string; repo: string }>;
  installed: InstalledRepo[] | null;
  sites: Array<{ namespace: string; host: string }>;
}

function hostCovered(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** The drift lines, both ways, and how many facts were compared. Pure. */
export function modelDrift(
  model: SystemModel,
  facts: DriftFacts,
): { items: OpsMaintenanceItem[]; read: number } {
  const items: OpsMaintenanceItem[] = [];
  const modelRepos = new Map<string, string>();
  for (const s of model.systems) for (const r of s.repos) modelRepos.set(r.toLowerCase(), s.id);
  const leftOff = new Set((model.left_off ?? []).map((l) => l.repo.toLowerCase()));
  const known = (repo: string) =>
    modelRepos.has(repo.toLowerCase()) || leftOff.has(repo.toLowerCase());
  const add = (namespace: string, line: string) => {
    if (items.length < MAX_ITEMS) items.push({ rule: "model-drift", namespace, line });
  };

  const flagged = new Set<string>();
  for (const { namespace, repo } of facts.mapped) {
    if (known(repo) || flagged.has(repo.toLowerCase())) continue;
    flagged.add(repo.toLowerCase());
    add(namespace, `${repo} is mapped to ${namespace} but is not in system/model.json: add it.`);
  }

  if (facts.installed === null) {
    items.push({
      rule: "model-not-checked",
      namespace: "capsid",
      line: "The App's repo list could not be read, so the model was not compared with GitHub today.",
    });
  } else {
    const live = new Map(facts.installed.map((r) => [r.full_name.toLowerCase(), r]));
    for (const r of facts.installed) {
      if (r.archived || known(r.full_name) || flagged.has(r.full_name.toLowerCase())) continue;
      flagged.add(r.full_name.toLowerCase());
      add(
        "capsid",
        `${r.full_name} is installed for the App but is not in system/model.json: add it.`,
      );
    }
    for (const [repo, system] of modelRepos) {
      if (!live.has(repo))
        add(
          "capsid",
          `system/model.json names ${repo} (system ${system}), which the App does not list: fix the model, or install the App there.`,
        );
    }
    for (const repo of leftOff) {
      if (!live.has(repo))
        add(
          "capsid",
          `system/model.json leaves ${repo} off the map, but the App no longer lists it: drop it from left_off.`,
        );
    }
  }

  const domains = model.systems.flatMap((s) => (s.domain ? [s.domain] : []));
  for (const { namespace, host } of facts.sites) {
    if (!hostCovered(host, domains))
      add(
        namespace,
        `The watched site ${host} is no model system's domain: add the domain to its system in system/model.json.`,
      );
  }

  return { items, read: facts.mapped.length + (facts.installed?.length ?? 0) + facts.sites.length };
}

export async function gatherModelDriftItems(
  env: Env,
  model: SystemModel,
  listRepos: (env: Env) => Promise<{ repos: InstalledRepo[] }> = listInstalledRepos,
): Promise<{ items: OpsMaintenanceItem[]; read: number }> {
  const rows = await env.DB.prepare("SELECT namespace, repos FROM namespaces").all<{
    namespace: string;
    repos: string;
  }>();
  const mapped: DriftFacts["mapped"] = [];
  const unreadable: OpsMaintenanceItem[] = [];
  for (const row of rows.results ?? []) {
    const parsed = parseMappedRepos(row.repos);
    if ("list" in parsed)
      for (const r of parsed.list) mapped.push({ namespace: row.namespace, repo: r.repo });
    else
      unreadable.push({
        rule: "model-not-checked",
        namespace: row.namespace,
        line: `${row.namespace}'s repo mapping could not be read (${parsed.error}), so its repos were not compared with the model.`,
      });
  }

  let installed: InstalledRepo[] | null = null;
  try {
    installed = (await listRepos(env)).repos;
  } catch (e) {
    logEvent(
      "MODEL_DRIFT_LIST_FAILED",
      { message: `MODEL_DRIFT_LIST_FAILED ${errorMessage(e)}` },
      { level: "error" },
    );
  }

  const sites = sitesFrom(await readSiteConfig(env.DB)).map((s) => ({
    namespace: s.namespace,
    host: new URL(s.origin).hostname,
  }));
  const drift = modelDrift(model, { mapped, installed, sites });
  return { items: [...unreadable, ...drift.items], read: drift.read };
}
