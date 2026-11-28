import type { Env } from "./env";
import type { FetchLike } from "./http";
import {
  CF_API,
  CfReadError,
  cfGet,
  cfGetAll,
  cfPostRead,
  cloudflareCredentials,
} from "./ops-cloudflare";
import { errorMessage } from "@dustinedwards/site-runtime/log";

// What the nightly build reads from Cloudflare for the secrets and data model (folded in src/system-resources.ts).

export const PERMISSION = {
  scripts: "Account / Workers Scripts / Read",
  d1: "Account / D1 / Read",
  kv: "Account / Workers KV Storage / Read",
  r2: "Account / Workers R2 Storage / Read",
} as const;

const SCRIPT_NAME = /^[A-Za-z0-9_-]{1,63}$/;
// The tables a person wrote: not SQLite's, not Cloudflare's, not an FTS5 index's shadows.
const TABLES_SQL =
  "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name";
const MAX_TABLES = 200;
// The newest Previews read per Worker: each is one branch, and branches rarely bind differently.
const PREVIEWS_PER_WORKER = 3;

export type Binding =
  | { type: "secret"; binding: string }
  | { type: "var"; binding: string }
  | { type: "d1"; binding: string; id: string }
  | { type: "kv"; binding: string; id: string }
  | { type: "r2"; binding: string; bucket: string }
  | { type: "durable_object"; binding: string; class: string; script: string | null }
  | { type: "queue"; binding: string; queue: string }
  | { type: "service"; binding: string; service: string }
  | { type: "other"; binding: string; kind: string };

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null;

// One binding as Capsid keeps it: its name, its kind and the resource it points at. Never a value.
// Null for a binding without a name.
export function bindingOf(raw: unknown): Binding | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const binding = str(b.name);
  const type = str(b.type);
  if (!binding || !type) return null;
  switch (type) {
    case "secret_text":
    case "secret_key":
      return { type: "secret", binding };
    case "plain_text":
    case "json":
      return { type: "var", binding };
    case "d1": {
      const id = str(b.database_id) ?? str(b.id);
      return id ? { type: "d1", binding, id } : { type: "other", binding, kind: type };
    }
    case "kv_namespace": {
      const id = str(b.namespace_id);
      return id ? { type: "kv", binding, id } : { type: "other", binding, kind: type };
    }
    case "r2_bucket": {
      const bucket = str(b.bucket_name);
      return bucket ? { type: "r2", binding, bucket } : { type: "other", binding, kind: type };
    }
    case "durable_object_namespace":
      return {
        type: "durable_object",
        binding,
        class: str(b.class_name) ?? "unknown",
        script: str(b.script_name),
      };
    case "queue": {
      const queue = str(b.queue_name);
      return queue ? { type: "queue", binding, queue } : { type: "other", binding, kind: type };
    }
    case "service": {
      const service = str(b.service);
      return service
        ? { type: "service", binding, service }
        : { type: "other", binding, kind: type };
    }
    default:
      return { type: "other", binding, kind: type };
  }
}

/** What was read from Cloudflare. A part that could not be read is its error text. */
export interface ResourceFacts {
  workers: Array<{ script: string; bindings: Binding[] | string; previews?: Binding[] | string }>;
  d1: Array<{ id: string; name: string; tables: string[] | string }> | string;
  kv: Array<{ id: string; title: string }> | string;
  r2: string[] | string;
}

function refused(what: string, permission: string) {
  return (err: unknown): string => {
    const reason = errorMessage(err).slice(0, 300);
    return err instanceof CfReadError && err.status === 403
      ? `${what} was refused: CF_OPS_TOKEN lacks ${permission}`
      : `${what} could not be read (${reason})`;
  };
}

// The tables of one D1 database, by a read of sqlite_master: an FTS5 table's shadow tables
// (name_data, name_idx, name_content, name_docsize, name_config) are left out.
export function userTables(rows: Array<{ name?: unknown; sql?: unknown }>): string[] {
  const names = rows.map((r) => (typeof r.name === "string" ? r.name : "")).filter(Boolean);
  const virtual = rows
    .filter((r) => typeof r.sql === "string" && /^CREATE VIRTUAL TABLE/i.test(r.sql))
    .map((r) => r.name as string);
  const shadow = (n: string) => virtual.some((v) => n !== v && n.startsWith(`${v}_`));
  return names.filter((n) => !shadow(n)).slice(0, MAX_TABLES);
}

// The store bindings of a Worker's newest Previews, each from its newest deployment. A Worker with
// no Previews has none; a refused read is its reason.
async function readPreviewStores(
  fetchImpl: FetchLike,
  token: string,
  base: string,
  script: string,
): Promise<Binding[] | string> {
  const at = `${base}/workers/workers/${encodeURIComponent(script)}/previews`;
  try {
    const list = await cfGet(
      fetchImpl,
      token,
      `${at}?per_page=${PREVIEWS_PER_WORKER}`,
      `the Previews of ${script}`,
    );
    const out: Binding[] = [];
    for (const p of (Array.isArray(list) ? list : []).slice(0, PREVIEWS_PER_WORKER)) {
      const id = str((p as { id?: unknown })?.id);
      if (!id) continue;
      const deps = await cfGet(
        fetchImpl,
        token,
        `${at}/${encodeURIComponent(id)}/deployments?per_page=1`,
        `the deployments of a Preview of ${script}`,
      );
      const env = (Array.isArray(deps) ? (deps[0] as { env?: unknown } | undefined) : undefined)
        ?.env;
      if (!env || typeof env !== "object") continue;
      for (const [name, raw] of Object.entries(env as Record<string, unknown>)) {
        const b = bindingOf(
          raw && typeof raw === "object"
            ? {
                name,
                type: (raw as { type?: unknown }).type,
                database_id: (raw as { database_id?: unknown }).database_id,
                id: (raw as { id?: unknown }).id,
                namespace_id: (raw as { namespace_id?: unknown }).namespace_id,
                bucket_name: (raw as { bucket_name?: unknown }).bucket_name,
              }
            : null,
        );
        if (b && (b.type === "d1" || b.type === "kv" || b.type === "r2")) out.push(b);
      }
    }
    return out;
  } catch (err) {
    return refused(`the Previews of ${script}`, PERMISSION.scripts)(err);
  }
}

// Everything the document needs, from Cloudflare. Throws only when the Worker list itself cannot be
// read; every other part fails alone, with the reason kept.
export async function readResourceFacts(
  env: Pick<Env, "CF_OPS_TOKEN" | "CF_ACCOUNT_ID" | "R2_ACCOUNT_ID">,
  fetchImpl: FetchLike = (u, i) => fetch(u, i),
): Promise<ResourceFacts> {
  const c = cloudflareCredentials(env);
  if (!c.ok) throw new Error(c.reason);
  const base = `${CF_API}/accounts/${encodeURIComponent(c.account)}`;

  const scripts = await cfGet(
    fetchImpl,
    c.token,
    `${base}/workers/scripts`,
    "the Workers list",
  ).catch((err: unknown) => {
    throw new Error(refused("the Workers list", PERMISSION.scripts)(err));
  });
  if (!Array.isArray(scripts)) throw new Error("the Workers list returned no result array");
  const names = scripts
    .map((s) => str((s as { id?: unknown })?.id))
    .filter((n): n is string => n !== null && SCRIPT_NAME.test(n))
    .sort();

  const workers: ResourceFacts["workers"] = [];
  for (const script of names) {
    const bindings = await cfGet(
      fetchImpl,
      c.token,
      `${base}/workers/scripts/${encodeURIComponent(script)}/settings`,
      `the settings of ${script}`,
    ).then(
      (r) =>
        (r as { bindings?: unknown })?.bindings &&
        Array.isArray((r as { bindings: unknown[] }).bindings)
          ? (r as { bindings: unknown[] }).bindings
              .map(bindingOf)
              .filter((b): b is Binding => b !== null)
          : [],
      refused(`the settings of ${script}`, PERMISSION.scripts),
    );
    workers.push({
      script,
      bindings,
      previews: await readPreviewStores(fetchImpl, c.token, base, script),
    });
  }

  const d1 = await cfGetAll(
    fetchImpl,
    c.token,
    `${base}/d1/database`,
    "the D1 database list",
    100,
  ).then(
    async (rows) => {
      const out: Array<{ id: string; name: string; tables: string[] | string }> = [];
      for (const r of rows as Array<{ uuid?: unknown; name?: unknown }>) {
        const id = str(r?.uuid);
        const name = str(r?.name);
        if (!id || !name) continue;
        const tables = await cfPostRead(
          fetchImpl,
          c.token,
          `${base}/d1/database/${encodeURIComponent(id)}/query`,
          `the tables of ${name}`,
          { sql: TABLES_SQL },
        ).then(
          (res) =>
            userTables(
              ((res as Array<{ results?: unknown }>)?.[0]?.results as Array<{
                name?: unknown;
                sql?: unknown;
              }>) ?? [],
            ),
          refused(`the tables of ${name}`, PERMISSION.d1),
        );
        out.push({ id, name, tables });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    refused("the D1 database list", PERMISSION.d1),
  );

  const kv = await cfGetAll(
    fetchImpl,
    c.token,
    `${base}/storage/kv/namespaces`,
    "the KV namespace list",
    100,
  ).then(
    (rows) =>
      (rows as Array<{ id?: unknown; title?: unknown }>)
        .flatMap((r) =>
          str(r?.id) && str(r?.title) ? [{ id: r.id as string, title: r.title as string }] : [],
        )
        .sort((a, b) => a.title.localeCompare(b.title)),
    refused("the KV namespace list", PERMISSION.kv),
  );

  // R2's list pages by cursor, not by page number; one account holds far fewer than 1,000.
  const r2 = await cfGet(
    fetchImpl,
    c.token,
    `${base}/r2/buckets?per_page=1000`,
    "the R2 bucket list",
  ).then(
    (res) =>
      (((res as { buckets?: unknown })?.buckets as Array<{ name?: unknown }>) ?? []).flatMap((b) =>
        str(b?.name) ? [b.name as string] : [],
      ),
    refused("the R2 bucket list", PERMISSION.r2),
  );

  return { workers, d1, kv, r2 };
}
