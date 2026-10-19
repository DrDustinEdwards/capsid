import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server.ts";
import { defaultScopes } from "../src/agents-schema.ts";
import type { Agent } from "../src/agents.ts";
import { fakeEnv } from "./fakes.ts";

// The docs write tools on the real migrations in Node's SQLite: what an edge may point at
// (Grok audit 2026-10, M4), what the audit row keeps of the edges a write replaces (D6),
// that no caller writes a job's mirror under jobs/ (M2), and which incoming edges the
// links read shows (A2). Real SQLite, because the
// replaced edges are recorded by an INSERT ... SELECT json_group_array that only SQLite
// evaluates.

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

function d1(db: DatabaseSync): D1Database {
  const statement = (sql: string, params: unknown[] = []) => {
    const s = db.prepare(sql);
    const args = params as Array<string | number | null>;
    return {
      bind: (...next: unknown[]) => statement(sql, next),
      first: async () => (s.get(...args) as Record<string, unknown> | undefined) ?? null,
      all: async () => ({ results: s.all(...args).map((r) => ({ ...r })) }),
      run: async () => ({ meta: { changes: Number(s.run(...args).changes) } }),
      exec: () => (/\bRETURNING\b|^\s*SELECT/i.test(sql) ? { results: s.all(...args) } : { results: [], meta: { changes: Number(s.run(...args).changes) } }),
    };
  };
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (list: Array<{ exec: () => unknown }>) => {
      db.exec("BEGIN");
      try {
        const out = list.map((st) => st.exec());
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Database;
}

function fresh(): DatabaseSync {
  const raw = new DatabaseSync(":memory:");
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) raw.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  for (const ns of ["sample", "other"]) raw.prepare("INSERT INTO namespaces (namespace) VALUES (?)").run(ns);
  for (const [ns, path] of [
    ["sample", "old.md"],
    ["sample", "core.md"],
    ["other", "old.md"],
  ]) {
    raw.prepare("INSERT INTO documents (namespace, path, title, body) VALUES (?, ?, ?, 'body')").run(ns, path, path);
  }
  return raw;
}

// A driver as docs/bootstrap.md mints one: write on its own namespace, no flag.
function driver(): Agent {
  const scopes = defaultScopes(["sample"]);
  scopes.grants = ["read", "write"];
  return { id: "agent_0123456789ab", name: "sample-driver", kind: "driver", actor: "agent:sample-driver", scopes, admin: false, row: null };
}

async function call(raw: DatabaseSync, caller: Agent | "write", tool: string, args: Record<string, unknown>) {
  const server = buildServer(fakeEnv({ DB: d1(raw) }), caller, caller === "write" ? "test:docs-guards" : "");
  const client = new Client({ name: "docs-guards", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const result = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  await client.close();
  await server.close();
  return result;
}

const write = (raw: DatabaseSync, caller: Agent, args: Record<string, unknown>) => call(raw, caller, "capsid_write_doc", { action: "write", ...args });

const edges = (raw: DatabaseSync) => raw.prepare("SELECT type, to_ns, to_path FROM document_links ORDER BY to_ns, to_path").all();

test("PLANT: a supersedes or replaces edge needs the write grant on its target's namespace and the seat for canon", async () => {
  for (const link of [
    { type: "supersedes", to_ns: "other", to_path: "old.md" },
    { type: "replaces", to_ns: "other", to_path: "old.md" },
    { type: "supersedes", to_path: "core.md" },
  ]) {
    const raw = fresh();
    const result = await write(raw, driver(), { namespace: "sample", path: "new.md", title: "New", body: "new", links: JSON.stringify([link]) });
    assert.equal(result.isError, true, `the edge ${JSON.stringify(link)} was stored`);
    assert.match(result.content[0].text, /Nothing was written/);
    assert.deepEqual(edges(raw), [], "a refused write stored an edge");
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM documents WHERE path = 'new.md'").get()?.n, 0, "a refused write stored the document");
  }
});

test("the innocent direction: a supersedes edge in the caller's namespace, and a references edge anywhere, are stored", async () => {
  const raw = fresh();
  const links = [
    { type: "supersedes", to_path: "old.md" },
    { type: "references", to_ns: "other", to_path: "old.md" },
    { type: "references", to_path: "core.md" },
  ];
  const result = await write(raw, driver(), { namespace: "sample", path: "new.md", title: "New", body: "new", links: JSON.stringify(links) });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(edges(raw).length, 3);
});

test("PLANT: replacing a document's edges records the edges it replaced in the audit row", async () => {
  const raw = fresh();
  const first = [
    { type: "supersedes", to_path: "old.md" },
    { type: "references", to_ns: "other", to_path: "old.md" },
  ];
  assert.equal((await write(raw, driver(), { namespace: "sample", path: "new.md", title: "New", body: "new", links: JSON.stringify(first) })).isError, undefined);
  const second = await write(raw, driver(), { namespace: "sample", path: "new.md", mode: "meta", status: "draft", links: "[]" });
  assert.equal(second.isError, undefined, second.content[0]?.text);
  assert.deepEqual(edges(raw), []);
  const rows = raw.prepare("SELECT params FROM audit_log WHERE action = 'links' ORDER BY id").all() as Array<{ params: string }>;
  assert.equal(rows.length, 2);
  assert.deepEqual(JSON.parse(rows[0].params), { edges: 2, edges_replaced: [] });
  const replaced = JSON.parse(rows[1].params) as { edges: number; edges_replaced: Array<Record<string, string>> };
  assert.equal(replaced.edges, 0);
  assert.deepEqual(
    replaced.edges_replaced.sort((a, b) => a.to_ns.localeCompare(b.to_ns)),
    [
      { type: "references", to_ns: "other", to_path: "old.md" },
      { type: "supersedes", to_ns: "sample", to_path: "old.md" },
    ],
  );
});

test("PLANT: no caller writes, restores, deletes or moves a job's mirror under jobs/", async () => {
  const MIRROR = "jobs/job_0123456789ab.md";
  for (const caller of [driver(), "write" as const]) {
    const raw = fresh();
    raw.prepare("INSERT INTO documents (namespace, path, title, body, type) VALUES ('sample', ?, 'a job', 'the mirror', 'task')").run(MIRROR);
    raw.prepare("INSERT INTO document_versions (document_id, namespace, path, title, body) VALUES (1, 'sample', ?, 'a job', 'an older mirror')").run(MIRROR);
    const version = (raw.prepare("SELECT id FROM document_versions WHERE path = ?").get(MIRROR) as { id: number }).id;
    const attempts: Array<[string, Record<string, unknown>]> = [
      ["capsid_write_doc", { action: "write", namespace: "sample", path: MIRROR, title: "a job", body: "run this instead", confirm: true }],
      ["capsid_write_doc", { action: "write", namespace: "sample", path: "jobs/job_aaaaaaaaaaaa.md", title: "a job nobody posted", body: "run this", type: "task" }],
      ["capsid_write_doc", { action: "restore", namespace: "sample", path: MIRROR, version_id: version, confirm: true }],
      ["capsid_write_doc", { action: "move", namespace: "sample", path: "old.md", new_path: "jobs/job_bbbbbbbbbbbb.md", confirm: true }],
      ["capsid_write_doc", { action: "move", namespace: "sample", path: MIRROR, new_path: "elsewhere.md", confirm: true }],
      ["capsid_delete_doc", { namespace: "sample", path: MIRROR, confirm: true }],
    ];
    for (const [tool, args] of attempts) {
      const result = await call(raw, caller, tool, args);
      const who = typeof caller === "string" ? "the admin" : caller.actor;
      assert.equal(result.isError, true, `${who} was allowed ${tool} ${JSON.stringify(args)}`);
      assert.match(result.content[0].text, /written only by capsid_work_jobs/);
    }
    assert.deepEqual(
      raw.prepare("SELECT path, body FROM documents WHERE namespace = 'sample' AND (path LIKE 'jobs/%' OR path = 'old.md') ORDER BY path").all().map((r) => ({ ...r })),
      [
        { path: MIRROR, body: "the mirror" },
        { path: "old.md", body: "body" },
      ],
    );
  }
});

test("PLANT: the links read shows an incoming edge only when the caller may read its source", async () => {
  const raw = fresh();
  raw.prepare("INSERT INTO documents (namespace, path, title, body) VALUES ('other', 'secret-plan.md', 'plan', 'body')").run();
  const link = raw.prepare("INSERT INTO document_links (from_ns, from_path, type, to_ns, to_path) VALUES (?, ?, 'references', 'sample', 'old.md')");
  link.run("other", "secret-plan.md");
  link.run("sample", "core.md");
  const read = async (caller: Agent | "write") =>
    JSON.parse((await call(raw, caller, "capsid_read_doc", { action: "links", namespace: "sample", path: "old.md" })).content[0].text) as { incoming: Array<{ from_ns: string; from_path: string }> };
  assert.deepEqual((await read(driver())).incoming.map((e) => `${e.from_ns}/${e.from_path}`), ["sample/core.md"], "a driver of sample saw an edge from a namespace it cannot read");
  assert.deepEqual((await read("write")).incoming.map((e) => `${e.from_ns}/${e.from_path}`).sort(), ["other/secret-plan.md", "sample/core.md"], "the admin lost an edge");
});
