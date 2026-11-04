import type { Env } from "./env";
import { CF_API, CfReadError, cfGet, cfGetAll, cfPostRead, cloudflareCredentials, type FetchLike } from "./ops-cloudflare";
import type { OpsMaintenanceItem } from "./ops-types/views";
import type { ResourcesDoc } from "./ops-types/feed";

export type { ResourcesDoc };
import type { SystemModel } from "./system-model";

// THE SECRETS AND DATA MODEL (Dustin, 2026-11-03): each Worker's secret names, D1 databases
// and their tables, KV namespaces, R2 buckets, Durable Objects and queues, and which
// systems use each, read from Cloudflare by the nightly build (src/system-facts.ts) so a
// cleanup never needs a production check to learn who uses what. Private: it is stored in
// APP_KV, served only to the Portal behind its sign-in and to capsid_admin_read_ops action
// resources, never published (even a secret's name hints at how things are wired).
//
// NAMES, NEVER VALUES. A Worker's settings (GET .../workers/scripts/{script}/settings)
// list every binding, and a plain_text or json binding carries its value beside its name.
// bindingOf copies named fields into a fresh object per binding type, so a value, and any
// field Cloudflare adds later, is dropped unread. A secret_text binding has no value to
// return at all (developers.cloudflare.com/api/resources/workers/subresources/scripts/
// subresources/script_and_version_settings/methods/get/).
//
// Which system a Worker belongs to is the `workers` list on each system in
// system/model.json; a Worker no system names is a drift line. The model's own D1 and R2
// containers (technology "D1...", "R2") are compared with what each system's Workers bind.
//
// PREVIEWS. A Worker Preview (npx wrangler preview, a PR branch's build) inherits no
// production binding and binds its own preview stores, so a preview-only database or bucket
// shows in no Worker's settings. The newest few Previews of each Worker are read (GET
// .../workers/workers/{script}/previews, then each one's newest deployment, whose env lists
// its bindings the same way, values included) and their stores count as used, labelled
// "(preview)" (developers.cloudflare.com/api/resources/workers/subresources/workers/).
//
// Permissions on CF_OPS_TOKEN (read-only; each missing one is named, and the rest still runs):
//   Workers Scripts Read        GET /accounts/{id}/workers/scripts and .../settings, and each
//                               Worker's Previews and their deployments (held already)
//   D1 Read                     GET /accounts/{id}/d1/database, POST .../d1/database/{id}/query
//                               (a SELECT on sqlite_master only)
//   Workers KV Storage Read     GET /accounts/{id}/storage/kv/namespaces
//   Workers R2 Storage Read     GET /accounts/{id}/r2/buckets

const PERMISSION = {
  scripts: "Account / Workers Scripts / Read",
  d1: "Account / D1 / Read",
  kv: "Account / Workers KV Storage / Read",
  r2: "Account / Workers R2 Storage / Read",
} as const;

const SCRIPT_NAME = /^[A-Za-z0-9_-]{1,63}$/;
// The tables a person wrote: not SQLite's, not Cloudflare's, not an FTS5 index's shadows.
const TABLES_SQL = "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name";
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

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null);

/** One binding as Capsid keeps it: its name, its kind and the resource it points at.
 *  Never a value. Null for a binding without a name. */
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
      return { type: "durable_object", binding, class: str(b.class_name) ?? "unknown", script: str(b.script_name) };
    case "queue": {
      const queue = str(b.queue_name);
      return queue ? { type: "queue", binding, queue } : { type: "other", binding, kind: type };
    }
    case "service": {
      const service = str(b.service);
      return service ? { type: "service", binding, service } : { type: "other", binding, kind: type };
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

type User = ResourcesDoc["databases"][number]["used_by"][number];

/** The script each system's `workers` list names, to its system. */
function systemOfScript(model: SystemModel): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of model.systems) for (const w of s.workers ?? []) out.set(w, s.id);
  return out;
}

/** The document, from what was read. Pure. */
export function resourcesDoc(model: SystemModel, facts: ResourceFacts, now: Date): ResourcesDoc {
  const systemOf = systemOfScript(model);
  const problems: string[] = [];
  const d1Name = new Map(typeof facts.d1 === "string" ? [] : facts.d1.map((d) => [d.id, d.name]));
  const kvTitle = new Map(typeof facts.kv === "string" ? [] : facts.kv.map((k) => [k.id, k.title]));
  if (typeof facts.d1 === "string") problems.push(facts.d1);
  if (typeof facts.kv === "string") problems.push(facts.kv);
  if (typeof facts.r2 === "string") problems.push(facts.r2);

  const dbUsers = new Map<string, User[]>();
  const kvUsers = new Map<string, User[]>();
  const r2Users = new Map<string, User[]>();
  const add = (m: Map<string, User[]>, key: string, u: User) => m.set(key, [...(m.get(key) ?? []), u]);

  const workers: ResourcesDoc["workers"] = facts.workers.map(({ script, bindings, previews }) => {
    const system = systemOf.get(script) ?? null;
    const w: ResourcesDoc["workers"][number] = { script, system, error: null, secrets: [], vars: [], d1: [], kv: [], r2: [], durable_objects: [], queues: [], services: [], other: [], previews: [] };
    // A Preview's stores: who uses them, and the Worker's Previews row. Nothing else of a
    // Preview is kept, and a store it shares with production is not listed twice.
    if (typeof previews === "string") problems.push(`${script}'s Previews: ${previews}`);
    else {
      const seen = new Set<string>();
      for (const b of previews ?? []) {
        const u = { script, system, binding: `${b.binding} (preview)` };
        let to: string | null = null;
        if (b.type === "d1") {
          to = d1Name.get(b.id) ?? `unnamed (${b.binding})`;
          add(dbUsers, b.id, u);
        } else if (b.type === "kv") {
          to = kvTitle.get(b.id) ?? `unnamed (${b.binding})`;
          add(kvUsers, b.id, u);
        } else if (b.type === "r2") {
          to = b.bucket;
          add(r2Users, b.bucket, u);
        }
        if (to && !seen.has(`${b.binding} ${to}`)) {
          seen.add(`${b.binding} ${to}`);
          w.previews.push({ binding: b.binding, store: to });
        }
      }
    }
    if (typeof bindings === "string") {
      w.error = bindings;
      return w;
    }
    for (const b of bindings) {
      const u = { script, system, binding: b.binding };
      switch (b.type) {
        case "secret":
          w.secrets.push(b.binding);
          break;
        case "var":
          w.vars.push(b.binding);
          break;
        case "d1": {
          // Without the D1 list the database is known by its binding only.
          const database = d1Name.get(b.id) ?? `unnamed (${b.binding})`;
          w.d1.push({ binding: b.binding, database });
          add(dbUsers, b.id, u);
          break;
        }
        case "kv": {
          const namespace = kvTitle.get(b.id) ?? `unnamed (${b.binding})`;
          w.kv.push({ binding: b.binding, namespace });
          add(kvUsers, b.id, u);
          break;
        }
        case "r2":
          w.r2.push({ binding: b.binding, bucket: b.bucket });
          add(r2Users, b.bucket, u);
          break;
        case "durable_object":
          w.durable_objects.push({ binding: b.binding, class: b.class, script: b.script });
          break;
        case "queue":
          w.queues.push({ binding: b.binding, queue: b.queue });
          break;
        case "service":
          w.services.push({ binding: b.binding, service: b.service });
          break;
        default:
          w.other.push({ binding: b.binding, kind: b.kind });
      }
    }
    for (const list of [w.secrets, w.vars]) list.sort();
    return w;
  });

  const databases: ResourcesDoc["databases"] = typeof facts.d1 === "string" ? [] : facts.d1.map((d) => ({ name: d.name, tables: Array.isArray(d.tables) ? d.tables : null, tables_error: typeof d.tables === "string" ? d.tables : null, used_by: dbUsers.get(d.id) ?? [] }));
  const kv_namespaces: ResourcesDoc["kv_namespaces"] = typeof facts.kv === "string" ? [] : facts.kv.map((k) => ({ title: k.title, used_by: kvUsers.get(k.id) ?? [] }));
  const bucketNames = typeof facts.r2 === "string" ? [...r2Users.keys()] : facts.r2;
  const buckets: ResourcesDoc["buckets"] = [...new Set(bucketNames)].sort().map((name) => ({ name, used_by: r2Users.get(name) ?? [] }));
  return { version: 1, read_at: now.toISOString(), workers, databases, kv_namespaces, buckets, problems };
}

const isD1 = (technology: string) => /^D1\b/.test(technology);
const isR2 = (technology: string) => /^R2\b/.test(technology);

/** The drift lines: Workers no system names and names no Worker has, the model's D1 and R2
 *  containers against what each system's Workers bind, and stores no Worker binds. Pure. */
export function resourceDrift(model: SystemModel, doc: ResourcesDoc): { items: OpsMaintenanceItem[]; read: number } {
  const items: OpsMaintenanceItem[] = [];
  const add = (line: string, rule: OpsMaintenanceItem["rule"] = "model-drift") => items.push({ rule, namespace: "capsid", job: null, line });
  for (const p of doc.problems) add(`${p}, so part of the secrets and data model was not checked today.`, "model-not-checked");

  const leftOff = new Set((model.left_off ?? []).flatMap((l) => l.workers ?? []));
  const named = systemOfScript(model);
  const live = new Set(doc.workers.map((w) => w.script));
  for (const w of doc.workers) {
    if (w.error) add(`The settings of the Worker ${w.script} could not be read (${w.error}), so its secrets and data were not checked today.`, "model-not-checked");
    if (!w.system && !leftOff.has(w.script)) add(`The Worker ${w.script} runs in Cloudflare, but no system in system/model.json lists it in workers: add it, or delete the Worker.`);
  }
  for (const [script, system] of named) {
    if (!live.has(script)) add(`system/model.json lists the Worker ${script} for ${system}, but Cloudflare has no such Worker: fix the model.`);
  }
  for (const script of leftOff) {
    if (!live.has(script)) add(`system/model.json leaves the Worker ${script} off the map, but Cloudflare has no such Worker: drop it from left_off.`);
  }

  // The model's stores, by system, against what the system's Workers bind.
  const bound = new Map<string, { d1: Set<string>; r2: Set<string> }>();
  for (const w of doc.workers) {
    if (!w.system) continue;
    const b = bound.get(w.system) ?? { d1: new Set(), r2: new Set() };
    for (const d of w.d1) b.d1.add(d.database);
    for (const r of w.r2) b.r2.add(r.bucket);
    bound.set(w.system, b);
  }
  const d1Read = !doc.problems.some((p) => p.includes(PERMISSION.d1)) && doc.databases.length > 0;
  for (const s of model.systems) {
    if (!(s.workers ?? []).some((w) => live.has(w))) continue;
    const b = bound.get(s.id) ?? { d1: new Set(), r2: new Set() };
    const containers = model.containers.filter((c) => c.system === s.id);
    const modelD1 = new Set(containers.filter((c) => c.kind === "database" && isD1(c.technology)).map((c) => c.name));
    const modelR2 = new Set(containers.filter((c) => c.kind === "bucket" && isR2(c.technology)).map((c) => c.name));
    if (d1Read) {
      for (const db of b.d1) if (!modelD1.has(db)) add(`${s.id}'s Workers bind the D1 database ${db}, which system/model.json does not show: add a database container for it.`);
      for (const db of modelD1) if (!b.d1.has(db)) add(`system/model.json shows the D1 database ${db} in ${s.id}, but none of its Workers binds it: fix the model.`);
    }
    for (const r of b.r2) if (!modelR2.has(r)) add(`${s.id}'s Workers bind the R2 bucket ${r}, which system/model.json does not show: add a bucket container for it.`);
    for (const r of modelR2) if (!b.r2.has(r)) add(`system/model.json shows the R2 bucket ${r} in ${s.id}, but none of its Workers binds it: fix the model.`);
  }

  // A store nothing binds is a cleanup candidate, or a store something outside Workers uses.
  for (const d of doc.databases) if (d.used_by.length === 0) add(`The D1 database ${d.name} is bound by no Worker: delete it if nothing else uses it (back it up first).`);
  for (const k of doc.kv_namespaces) if (k.used_by.length === 0) add(`The KV namespace ${k.title} is bound by no Worker: delete it if nothing else uses it.`);
  for (const r of doc.buckets) if (r.used_by.length === 0) add(`The R2 bucket ${r.name} is bound by no Worker: delete it if nothing else uses it (a backup copy or a public bucket may be used outside Workers).`);

  return { items, read: doc.workers.length + doc.databases.length + doc.kv_namespaces.length + doc.buckets.length };
}

// ---- reading -------------------------------------------------------------------------

function refused(what: string, permission: string) {
  return (err: unknown): string => {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    return err instanceof CfReadError && err.status === 403 ? `${what} was refused: CF_OPS_TOKEN lacks ${permission}` : `${what} could not be read (${reason})`;
  };
}

/** The tables of one D1 database, by a read of sqlite_master: an FTS5 table's shadow
 *  tables (name_data, name_idx, name_content, name_docsize, name_config) are left out. */
export function userTables(rows: Array<{ name?: unknown; sql?: unknown }>): string[] {
  const names = rows.map((r) => (typeof r.name === "string" ? r.name : "")).filter(Boolean);
  const virtual = rows.filter((r) => typeof r.sql === "string" && /^CREATE VIRTUAL TABLE/i.test(r.sql)).map((r) => r.name as string);
  const shadow = (n: string) => virtual.some((v) => n !== v && n.startsWith(`${v}_`));
  return names.filter((n) => !shadow(n)).slice(0, MAX_TABLES);
}

/** The store bindings of a Worker's newest Previews, each from its newest deployment. A
 *  Worker with no Previews has none; a refused read is its reason. */
async function readPreviewStores(fetchImpl: FetchLike, token: string, base: string, script: string): Promise<Binding[] | string> {
  const at = `${base}/workers/workers/${encodeURIComponent(script)}/previews`;
  try {
    const list = await cfGet(fetchImpl, token, `${at}?per_page=${PREVIEWS_PER_WORKER}`, `the Previews of ${script}`);
    const out: Binding[] = [];
    for (const p of (Array.isArray(list) ? list : []).slice(0, PREVIEWS_PER_WORKER)) {
      const id = str((p as { id?: unknown })?.id);
      if (!id) continue;
      const deps = await cfGet(fetchImpl, token, `${at}/${encodeURIComponent(id)}/deployments?per_page=1`, `the deployments of a Preview of ${script}`);
      const env = (Array.isArray(deps) ? (deps[0] as { env?: unknown } | undefined) : undefined)?.env;
      if (!env || typeof env !== "object") continue;
      for (const [name, raw] of Object.entries(env as Record<string, unknown>)) {
        const b = bindingOf(raw && typeof raw === "object" ? { name, type: (raw as { type?: unknown }).type, database_id: (raw as { database_id?: unknown }).database_id, id: (raw as { id?: unknown }).id, namespace_id: (raw as { namespace_id?: unknown }).namespace_id, bucket_name: (raw as { bucket_name?: unknown }).bucket_name } : null);
        if (b && (b.type === "d1" || b.type === "kv" || b.type === "r2")) out.push(b);
      }
    }
    return out;
  } catch (err) {
    return refused(`the Previews of ${script}`, PERMISSION.scripts)(err);
  }
}

/** Everything the document needs, from Cloudflare. Throws only when the Worker list itself
 *  cannot be read; every other part fails alone, with the reason kept. */
export async function readResourceFacts(env: Pick<Env, "CF_OPS_TOKEN" | "CF_ACCOUNT_ID" | "R2_ACCOUNT_ID">, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<ResourceFacts> {
  const c = cloudflareCredentials(env);
  if (!c.ok) throw new Error(c.reason);
  const base = `${CF_API}/accounts/${encodeURIComponent(c.account)}`;

  const scripts = await cfGet(fetchImpl, c.token, `${base}/workers/scripts`, "the Workers list").catch((err: unknown) => {
    throw new Error(refused("the Workers list", PERMISSION.scripts)(err));
  });
  if (!Array.isArray(scripts)) throw new Error("the Workers list returned no result array");
  const names = scripts.map((s) => str((s as { id?: unknown })?.id)).filter((n): n is string => n !== null && SCRIPT_NAME.test(n)).sort();

  const workers: ResourceFacts["workers"] = [];
  for (const script of names) {
    const bindings = await cfGet(fetchImpl, c.token, `${base}/workers/scripts/${encodeURIComponent(script)}/settings`, `the settings of ${script}`).then(
      (r) => ((r as { bindings?: unknown })?.bindings && Array.isArray((r as { bindings: unknown[] }).bindings) ? (r as { bindings: unknown[] }).bindings.map(bindingOf).filter((b): b is Binding => b !== null) : []),
      refused(`the settings of ${script}`, PERMISSION.scripts)
    );
    workers.push({ script, bindings, previews: await readPreviewStores(fetchImpl, c.token, base, script) });
  }

  const d1 = await cfGetAll(fetchImpl, c.token, `${base}/d1/database`, "the D1 database list", 100).then(
    async (rows) => {
      const out: Array<{ id: string; name: string; tables: string[] | string }> = [];
      for (const r of rows as Array<{ uuid?: unknown; name?: unknown }>) {
        const id = str(r?.uuid);
        const name = str(r?.name);
        if (!id || !name) continue;
        const tables = await cfPostRead(fetchImpl, c.token, `${base}/d1/database/${encodeURIComponent(id)}/query`, `the tables of ${name}`, { sql: TABLES_SQL }).then(
          (res) => userTables(((res as Array<{ results?: unknown }>)?.[0]?.results as Array<{ name?: unknown; sql?: unknown }>) ?? []),
          refused(`the tables of ${name}`, PERMISSION.d1)
        );
        out.push({ id, name, tables });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    refused("the D1 database list", PERMISSION.d1)
  );

  const kv = await cfGetAll(fetchImpl, c.token, `${base}/storage/kv/namespaces`, "the KV namespace list", 100).then(
    (rows) =>
      (rows as Array<{ id?: unknown; title?: unknown }>)
        .flatMap((r) => (str(r?.id) && str(r?.title) ? [{ id: r.id as string, title: r.title as string }] : []))
        .sort((a, b) => a.title.localeCompare(b.title)),
    refused("the KV namespace list", PERMISSION.kv)
  );

  // R2's list pages by cursor, not by page number; one account holds far fewer than 1,000.
  const r2 = await cfGet(fetchImpl, c.token, `${base}/r2/buckets?per_page=1000`, "the R2 bucket list").then(
    (res) => (((res as { buckets?: unknown })?.buckets as Array<{ name?: unknown }>) ?? []).flatMap((b) => (str(b?.name) ? [b.name as string] : [])),
    refused("the R2 bucket list", PERMISSION.r2)
  );

  return { workers, d1, kv, r2 };
}
