import type { Env } from "./env";
import type { OpsMaintenanceItem } from "./ops-types/views";
import { listInstalledRepos, parseReposList, type InstalledRepo } from "./github/client";
import { logEvent } from "./log";
import { readSiteConfig, sitesFrom } from "./ops-sites";
import type { SystemModel } from "./system-model";

// The model's drift check, the daily half (design capsid/research/design-system-explorer.md,
// section 1; docs/public-data.md). system/model.json is written by hand, so it falls
// behind what Capsid knows: a repo mapped to a namespace or installed for the App that
// the model never names, a repo the model names that GitHub no longer lists, a model
// system marked public whose repo GitHub reports private, a watched site whose host is
// no model system's domain. Each is one line in the daily maintenance list. The check
// lists and never edits: the model changes by pull request.
//
// Private repos with no public product (answer 7) are never named in the public model,
// so they would be flagged every day. They are listed instead in a Capsid document,
// capsid/system/unlisted.md, which stays private, and the check skips them.

export const UNLISTED_DOC = { namespace: "capsid", path: "system/unlisted.md" } as const;
const MAX_ITEMS = 50;

export interface DriftFacts {
  /** Every repo a namespace maps, with its namespace. */
  mapped: Array<{ namespace: string; repo: string }>;
  /** Every repo the App can see, or null when the listing could not be read. */
  installed: InstalledRepo[] | null;
  /** Each watched site's host, by namespace. */
  sites: Array<{ namespace: string; host: string }>;
  /** Repos deliberately left out of the model, lower case. */
  unlisted: ReadonlySet<string>;
}

/** The repos a document lists, one `owner/name` per list item. */
export function parseUnlisted(body: string | null): Set<string> {
  const out = new Set<string>();
  for (const line of (body ?? "").split("\n")) {
    const m = /^\s*[-*]\s+`?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)`?/.exec(line);
    if (m) out.add(m[1].toLowerCase());
  }
  return out;
}

function hostCovered(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** The drift lines, both ways, and how many facts were compared. Pure. */
export function modelDrift(model: SystemModel, facts: DriftFacts): { items: OpsMaintenanceItem[]; read: number } {
  const items: OpsMaintenanceItem[] = [];
  const modelRepos = new Map<string, { system: string; public: boolean }>();
  for (const s of model.systems) for (const r of s.repos) modelRepos.set(r.toLowerCase(), { system: s.id, public: s.public });
  const known = (repo: string) => modelRepos.has(repo.toLowerCase()) || facts.unlisted.has(repo.toLowerCase());
  const add = (namespace: string, line: string) => {
    if (items.length < MAX_ITEMS) items.push({ rule: "model-drift", namespace, job: null, line });
  };

  const flagged = new Set<string>();
  for (const { namespace, repo } of facts.mapped) {
    if (known(repo) || flagged.has(repo.toLowerCase())) continue;
    flagged.add(repo.toLowerCase());
    add(namespace, `${repo} is mapped to ${namespace} but is in neither system/model.json nor ${UNLISTED_DOC.namespace}/${UNLISTED_DOC.path}: add it to one.`);
  }

  if (facts.installed === null) {
    items.push({ rule: "model-not-checked", namespace: "capsid", job: null, line: "The App's repo list could not be read, so the model was not compared with GitHub today." });
  } else {
    const live = new Map(facts.installed.map((r) => [r.full_name.toLowerCase(), r]));
    for (const r of facts.installed) {
      if (r.archived || known(r.full_name) || flagged.has(r.full_name.toLowerCase())) continue;
      flagged.add(r.full_name.toLowerCase());
      add("capsid", `${r.full_name} is installed for the App but is in neither system/model.json nor ${UNLISTED_DOC.namespace}/${UNLISTED_DOC.path}: add it to one.`);
    }
    for (const [repo, at] of modelRepos) {
      const seen = live.get(repo);
      if (!seen) add("capsid", `system/model.json names ${repo} (system ${at.system}), which the App does not list: fix the model, or install the App there.`);
      else if (at.public && seen.private) add("capsid", `system/model.json marks ${at.system} public, but GitHub reports ${repo} private, so it is published as name and domain only: set public to false, or make the repo public.`);
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
  const doc = await env.DB.prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(UNLISTED_DOC.namespace, UNLISTED_DOC.path)
    .first<{ body: string | null }>();
  const drift = modelDrift(model, { mapped, installed, sites, unlisted: parseUnlisted(doc?.body ?? null) });
  return { items: [...unreadable, ...drift.items], read: drift.read };
}
