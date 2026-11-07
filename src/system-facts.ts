import type { Env } from "./env";
import { listInstalledRepos, type InstalledRepo } from "./github/client";
import type { OpsMaintenanceItem } from "./ops-types/views";
import type { SharedCodeView } from "./ops-types/feed";
import { bundledModel, PUBLIC_VERSIONS_KEY } from "./public-data";
import { readSharedCode } from "./shared-code";
import type { SystemModel } from "./system-model";
import {
  FACTS_BEHIND_KEY,
  FACTS_DRIFT_KEY,
  FACTS_LAST_KEY,
  RESOURCES_KEY,
  readJson,
  type StoredDrift,
} from "./system-facts-store";
import {
  readResourceFacts,
  resourceDrift,
  resourcesDoc,
  type ResourceFacts,
} from "./system-resources";
import {
  PublicVersionsSchema,
  toPublicVersions,
  versionDrift,
  type BehindSince,
} from "./system-versions";

// THE NIGHTLY SYSTEM FACTS BUILD (Dustin, 2026-11-03). Once a UTC day after 06:00 (the
// small hours in Chicago, so the 11:00 maintenance pass lists its drift) the tick reads:
//   the versions model: every model repo's pins of the network's packages, from their
//     lockfiles (src/shared-code.ts), published per system at /public/versions/v1.json
//     (src/system-versions.ts);
//   the secrets and data model: every Worker's bindings, D1 tables, KV namespaces and R2
//     buckets from Cloudflare (src/system-resources.ts), kept private in APP_KV.
// Each half stands alone: one that fails keeps its last good document and says so in the
// drift list, and the other is still built. The drift lines are stored for the maintenance
// pass (src/maintenance.ts), which lists them with the model's own drift.

const AFTER_UTC_HOUR = 6;

export interface FactsReaders {
  sharedCode: (env: Env, now: Date) => Promise<SharedCodeView>;
  listRepos: (env: Env) => Promise<{ repos: InstalledRepo[] }>;
  resources: (env: Env) => Promise<ResourceFacts>;
}

const LIVE: FactsReaders = {
  sharedCode: (env, now) => readSharedCode(env, now, true),
  listRepos: listInstalledRepos,
  resources: (env) => readResourceFacts(env),
};

const why = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

export async function systemFactsTick(
  env: Env,
  now: Date,
  readers: FactsReaders = LIVE,
  model: SystemModel = bundledModel(),
): Promise<{ ran: false; note: string } | { ran: true; note: string; failed: boolean }> {
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < AFTER_UTC_HOUR)
    return { ran: false, note: `before ${AFTER_UTC_HOUR}:00 UTC` };
  const last = await env.APP_KV.get(FACTS_LAST_KEY);
  if (last && last.slice(0, 10) === today) return { ran: false, note: `already built ${last}` };

  const items: OpsMaintenanceItem[] = [];
  const notes: string[] = [];
  let read = 0;
  let failed = false;

  try {
    const view = await readers.sharedCode(env, now);
    const { repos } = await readers.listRepos(env);
    const privacy = new Map(repos.map((r) => [r.full_name.toLowerCase(), r.private] as const));
    // Checked against the strict schema before it is published, as the explorer checks the model.
    const doc = PublicVersionsSchema.parse(toPublicVersions(view, model, privacy, today));
    const prior = await readJson<BehindSince>(env, FACTS_BEHIND_KEY);
    const drift = versionDrift(view, prior ?? {}, now);
    await env.APP_KV.put(PUBLIC_VERSIONS_KEY, JSON.stringify(doc));
    await env.APP_KV.put(FACTS_BEHIND_KEY, JSON.stringify(drift.since));
    items.push(...drift.items);
    read += view.apps_read;
    const pins = doc.systems.reduce((n, s) => n + s.pins.length, 0);
    notes.push(
      `versions: ${pins} pin(s) of ${doc.packages.length} package(s) in ${doc.systems.length} system(s), ${view.apps_failed.length} repo(s) unread`,
    );
  } catch (err) {
    failed = true;
    items.push({
      rule: "model-not-checked",
      namespace: "capsid",
      job: null,
      line: `The versions model could not be built tonight (${why(err)}): the last good one is still served.`,
    });
    notes.push(`versions failed: ${why(err)}`);
  }

  try {
    const doc = resourcesDoc(model, await readers.resources(env), now);
    await env.APP_KV.put(RESOURCES_KEY, JSON.stringify(doc));
    const drift = resourceDrift(model, doc);
    items.push(...drift.items);
    read += drift.read;
    notes.push(
      `resources: ${doc.workers.length} Worker(s), ${doc.databases.length} D1, ${doc.kv_namespaces.length} KV, ${doc.buckets.length} R2${doc.problems.length ? `; ${doc.problems.length} part(s) unread` : ""}`,
    );
    if (doc.problems.length) failed = true;
  } catch (err) {
    failed = true;
    items.push({
      rule: "model-not-checked",
      namespace: "capsid",
      job: null,
      line: `The secrets and data model could not be built tonight (${why(err)}): the last good one is still served.`,
    });
    notes.push(`resources failed: ${why(err)}`);
  }

  const stored: StoredDrift = { built_at: now.toISOString(), items, read };
  await env.APP_KV.put(FACTS_DRIFT_KEY, JSON.stringify(stored));
  await env.APP_KV.put(FACTS_LAST_KEY, now.toISOString());
  return { ran: true, note: `${notes.join("; ")}; ${items.length} drift line(s)`, failed };
}
