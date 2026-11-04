import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSystemModel } from "../src/system-model.ts";
import { bindingOf, resourceDrift, resourcesDoc, userTables, type Binding } from "../src/system-resources.ts";
import { readResources } from "../src/system-facts-store.ts";
import { toPublicVersions, versionDrift } from "../src/system-versions.ts";
import type { SharedCodeView } from "../src/ops-types/feed.ts";

// The versions and secrets models (src/system-facts.ts). Sample data only: example-org
// repos, sample systems and Workers.

const parsed = parseSystemModel({
  version: 1,
  systems: [
    { id: "sample", name: "Sample", short: "Sample", family: "site", ring: "used", repos: ["example-org/sample"], workers: ["sample-web"] },
    { id: "sample-b", name: "Sample B", short: "B", family: "site", ring: "used", repos: ["example-org/sample-b"], workers: ["sample-b-web", "sample-b-gone"] },
  ],
  containers: [
    { id: "sample-db", system: "sample", name: "sample", kind: "database", technology: "D1" },
    { id: "sample-files", system: "sample", name: "sample-files", kind: "bucket", technology: "R2" },
  ],
  relationships: [],
  left_off: [{ repo: "example-org/old", why: "sample", workers: ["old-web"] }],
});
if (!parsed.ok) throw new Error(parsed.problems.join("; "));
const MODEL = parsed.model;
const NOW = new Date("2026-11-03T06:30:00.000Z");

test("PLANT: a variable's value never reaches the document, only its name", () => {
  const raw = [
    { type: "plain_text", name: "SAMPLE_VAR", text: "CANARY-PLAIN" },
    { type: "json", name: "SAMPLE_JSON", json: { canary: "CANARY-JSON" } },
    { type: "secret_text", name: "SAMPLE_SECRET" },
    { type: "d1", name: "DB", id: "d1-id", database_id: "d1-id" },
    { type: "r2_bucket", name: "FILES", bucket_name: "sample-files" },
    { type: "kv_namespace", name: "APP_KV", namespace_id: "kv-id" },
    { type: "durable_object_namespace", name: "ROOM", class_name: "Room", namespace_id: "do-id" },
    { type: "ai", name: "AI", project: "CANARY-OTHER" },
  ];
  const bindings = raw.map(bindingOf).filter((b): b is Binding => b !== null);
  const doc = resourcesDoc(MODEL, { workers: [{ script: "sample-web", bindings }], d1: [{ id: "d1-id", name: "sample", tables: ["posts"] }], kv: [{ id: "kv-id", title: "sample-kv" }], r2: ["sample-files"] }, NOW);
  const text = JSON.stringify(doc);
  assert.ok(!text.includes("CANARY"), `a value reached the document: ${text}`);
  const w = doc.workers[0];
  assert.deepEqual([w.system, w.secrets, w.vars, w.d1, w.kv, w.r2], ["sample", ["SAMPLE_SECRET"], ["SAMPLE_JSON", "SAMPLE_VAR"], [{ binding: "DB", database: "sample" }], [{ binding: "APP_KV", namespace: "sample-kv" }], [{ binding: "FILES", bucket: "sample-files" }]]);
  assert.deepEqual(doc.databases[0].used_by, [{ script: "sample-web", system: "sample", binding: "DB" }], "who uses a database");
});

test("an FTS5 table's shadow tables are not the database's tables", () => {
  const rows = [{ name: "posts" }, { name: "posts_fts", sql: "CREATE VIRTUAL TABLE posts_fts USING fts5(body)" }, { name: "posts_fts_data" }, { name: "posts_fts_idx" }, { name: "posts_drafts" }];
  assert.deepEqual(userTables(rows), ["posts", "posts_fts", "posts_drafts"]);
});

test("PLANT: the drift lines name an unlisted Worker, a listed one that is gone, a store the model lacks or shows wrongly, and an unbound store, never a Preview's store", () => {
  const doc = resourcesDoc(
    MODEL,
    {
      workers: [
        { script: "sample-web", bindings: [{ type: "d1", binding: "DB", id: "d1-other" }, { type: "r2", binding: "FILES", bucket: "sample-uploads" }], previews: [{ type: "r2", binding: "FILES", bucket: "sample-preview-files" }] },
        { script: "sample-b-web", bindings: [] },
        { script: "stray", bindings: [] },
        { script: "old-web", bindings: [] },
      ],
      d1: [{ id: "d1-other", name: "sample-other", tables: [] }, { id: "d1-unused", name: "sample-preview", tables: [] }],
      kv: [],
      r2: ["sample-uploads", "sample-files", "sample-preview-files"],
    },
    NOW
  );
  const lines = resourceDrift(MODEL, doc).items.map((i) => i.line);
  const has = (part: string) => assert.ok(lines.some((l) => l.includes(part)), `no line names ${part}: ${lines.join(" | ")}`);
  has("The Worker stray runs in Cloudflare");
  has("lists the Worker sample-b-gone for sample-b");
  has("bind the D1 database sample-other");
  has("shows the D1 database sample in sample");
  has("bind the R2 bucket sample-uploads");
  has("The D1 database sample-preview is bound by no Worker");
  has("The R2 bucket sample-files is bound by no Worker");
  assert.ok(!lines.some((l) => l.includes("old-web")), "a Worker left off the map is not drift");
  // A bucket only a Preview binds is in use, and is not a store the model must draw.
  assert.ok(!lines.some((l) => l.includes("sample-preview-files")), "a Preview's bucket is not drift");
});

function view(users: SharedCodeView["packages"][number]["users"]): SharedCodeView {
  const pkg = { name: "Kit", repo: "example-org/kit", registry: "git" as const, latest: "v0.5.0", tags_error: null, version: null, untagged: false, private: false, npm_latest: null, npm_note: null, manifest_error: null, users, behind: 0, local_copies: [], local_left: 0 };
  return { generated: NOW.toISOString(), configured: true, error: null, apps_read: 2, apps_failed: [], packages: [pkg] };
}
const user = (system: string, where: string, pinned: string, behind: number) => ({ namespace: system, name: system, system, repo: `example-org/${system}`, where, pinned, behind, via_old_name: false });

test("PLANT: a repo on two versions is drift at once, a pin behind only after three days, and a private system's paths stay private", () => {
  const v = view([user("sample", "package.json", "v0.5.0", 0), user("sample", "apps/old/package.json", "v0.3.0", 2), user("sample-b", "package.json", "v0.4.0", 1)]);
  const first = versionDrift(v, {}, NOW);
  assert.equal(first.items.filter((i) => i.line.includes("installs 2 versions of Kit")).length, 1);
  assert.equal(first.items.filter((i) => i.line.includes("behind")).length, 0, "a new pin behind has its grace");
  const later = versionDrift(v, first.since, new Date(NOW.getTime() + 3 * 86_400_000));
  assert.ok(later.items.some((i) => i.line.includes("example-org/sample-b pins Kit v0.4.0 in package.json, 1 release behind v0.5.0 for 3 days")));
  const doc = toPublicVersions(v, MODEL, new Map([["example-org/sample", false], ["example-org/sample-b", true]]), "2026-11-03");
  assert.deepEqual(doc.systems.map((s) => [s.system, s.pins.map((p) => p.where ?? null)]), [["sample", ["package.json", "apps/old/package.json"]], ["sample-b", [null]]]);
});

test("a stored resources doc from before `previews` still reads with an empty list (the Workers tab crashed on it)", async () => {
  const old = { version: 1, read_at: "2026-11-03T06:00:00.000Z", workers: [{ script: "sample-web", system: "sample", error: null, secrets: [], vars: [], d1: [], kv: [], r2: [], durable_objects: [], queues: [], services: [], other: [] }], databases: [], kv_namespaces: [], buckets: [], problems: [] };
  const env = { APP_KV: { get: async () => JSON.stringify(old) } } as unknown as Parameters<typeof readResources>[0];
  const doc = await readResources(env);
  assert.deepEqual(doc?.workers[0]?.previews, []);
});
