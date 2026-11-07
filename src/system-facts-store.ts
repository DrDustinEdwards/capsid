import type { Env } from "./env";
import type { ResourcesDoc } from "./ops-types/feed";
import type { OpsMaintenanceItem } from "./ops-types/views";
import { DAY_MS } from "./time";

// What the nightly system facts build (src/system-facts.ts) stored, read without calling
// GitHub or Cloudflare: the Portal, the MCP tools and the maintenance pass import this, never
// the build itself, so no request can start a Cloudflare read.

export const RESOURCES_KEY = "private:resources:v1";
export const FACTS_LAST_KEY = "system-facts:last";
export const FACTS_DRIFT_KEY = "system-facts:drift";
export const FACTS_BEHIND_KEY = "system-facts:behind-since";
// The drift list says the build is missing once its last run is older than this.
const STALE_MS = 2 * DAY_MS;

export interface StoredDrift {
  built_at: string;
  items: OpsMaintenanceItem[];
  read: number;
}

export async function readFactsJson<T>(env: Pick<Env, "APP_KV">, key: string): Promise<T | null> {
  const raw = await env.APP_KV.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** The last build's drift lines for the maintenance pass, and a line of its own when the
 *  build has not run for two days. */
export async function readFactsDrift(
  env: Pick<Env, "APP_KV">,
  now: Date,
): Promise<{ items: OpsMaintenanceItem[]; read: number }> {
  const stored = await readFactsJson<StoredDrift>(env, FACTS_DRIFT_KEY);
  if (!stored || !Array.isArray(stored.items))
    return {
      items: [
        {
          rule: "model-not-checked",
          namespace: "capsid",
          job: null,
          line: "The nightly versions and secrets build has not run yet, so neither model was checked.",
        },
      ],
      read: 0,
    };
  const items = [...stored.items];
  if (now.getTime() - Date.parse(stored.built_at) > STALE_MS)
    items.unshift({
      rule: "model-not-checked",
      namespace: "capsid",
      job: null,
      line: `The nightly versions and secrets build last ran ${stored.built_at.slice(0, 10)}: its lines below are that night's (the run ledger's system-facts task says why).`,
    });
  return { items, read: stored.read };
}

/** The stored secrets and data model, or null before the first build. */
export async function readResources(env: Pick<Env, "APP_KV">): Promise<ResourcesDoc | null> {
  const doc = await readFactsJson<ResourcesDoc>(env, RESOURCES_KEY);
  if (!doc) return null;
  // The stored doc is one night old at most and can predate a field the type has since gained
  // (#762 added `previews`, and the Workers tab crashed on the earlier night's doc until the next
  // build). Fill what the type promises, so a reader never meets a missing list.
  return {
    ...doc,
    workers: (doc.workers ?? []).map((w) => ({ ...w, previews: w.previews ?? [] })),
  };
}
