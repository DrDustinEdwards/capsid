import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server";
import { HISTORY_ROWS } from "../src/limits";

// write, delete and restore snapshot the live row inside their batch, and the history
// listing is bounded. These run against real D1 because the node fake neither
// evaluates INSERT ... SELECT nor honours the listing's LIMIT.
//
// The race is staged by wrapping the real D1: the first batch() call rewrites the body
// and then runs the handler's batch unchanged. That is after the handler's pre-read, so
// a snapshot that bound the pre-read body would hold "lorem read body" here.

const NS = "sample";
const RACED = "lorem written in the gap";

function racingDb(db: D1Database, path: string): D1Database {
  let raced = false;
  return {
    prepare: (sql: string) => db.prepare(sql),
    exec: (sql: string) => db.exec(sql),
    dump: () => db.dump(),
    withSession: (c?: string) => db.withSession(c),
    batch: async (statements: D1PreparedStatement[]) => {
      if (!raced) {
        raced = true;
        await db.prepare("UPDATE documents SET body = ?3 WHERE namespace = ?1 AND path = ?2").bind(NS, path, RACED).run();
      }
      return db.batch(statements);
    },
  } as unknown as D1Database;
}

async function callTool(db: D1Database, name: string, args: Record<string, unknown>) {
  const server = buildServer({ ...env, DB: db } as never, "write", "test:integration");
  const client = new Client({ name: "live-snapshot", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  await client.close();
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

async function seed(path: string): Promise<number> {
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, '[]')").bind(NS).run();
  const row = await env.DB.prepare("INSERT INTO documents (namespace, path, title, body) VALUES (?1, ?2, 'Lorem', 'lorem read body') RETURNING id")
    .bind(NS, path)
    .first<{ id: number }>();
  return row!.id;
}

async function versionBodies(path: string): Promise<Array<string | null>> {
  const { results } = await env.DB.prepare("SELECT body FROM document_versions WHERE namespace = ?1 AND path = ?2 ORDER BY id")
    .bind(NS, path)
    .all<{ body: string | null }>();
  return results.map((r) => r.body);
}

describe("the snapshot holds the row the table held at commit", () => {
  it("write snapshots a body written after its pre-read", async () => {
    await seed("live-1.md");
    await callTool(racingDb(env.DB, "live-1.md"), "write", {
      namespace: NS,
      path: "live-1.md",
      title: "Lorem",
      body: "lorem new body",
      confirm: true,
    });
    expect(await versionBodies("live-1.md")).toEqual([RACED]);
  });

  it("delete snapshots a body written after its pre-read", async () => {
    await seed("live-2.md");
    await callTool(racingDb(env.DB, "live-2.md"), "delete", { namespace: NS, path: "live-2.md", confirm: true });
    expect(await versionBodies("live-2.md")).toEqual([RACED]);
  });

  it("restore snapshots a body written after its pre-read, and writes the version body", async () => {
    const id = await seed("live-3.md");
    const version = await env.DB.prepare(
      "INSERT INTO document_versions (document_id, namespace, path, title, body) VALUES (?1, ?2, ?3, 'Old', 'lorem old body') RETURNING id"
    )
      .bind(id, NS, "live-3.md")
      .first<{ id: number }>();
    await callTool(racingDb(env.DB, "live-3.md"), "restore", {
      namespace: NS,
      path: "live-3.md",
      version_id: version!.id,
      confirm: true,
    });
    expect(await versionBodies("live-3.md")).toEqual(["lorem old body", RACED]);
    const live = await env.DB.prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
      .bind(NS, "live-3.md")
      .first<{ body: string }>();
    expect(live?.body).toBe("lorem old body");
  });
});

describe("history is bounded", () => {
  it("lists at most HISTORY_ROWS versions, newest first", async () => {
    const id = await seed("live-4.md");
    await env.DB.prepare(
      `INSERT INTO document_versions (document_id, namespace, path, title, body)
       WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?4)
       SELECT ?1, ?2, ?3, 'Lorem', 'lorem ' || i FROM n`
    )
      .bind(id, NS, "live-4.md", HISTORY_ROWS + 1)
      .run();
    const out = (await callTool(env.DB, "history", { namespace: NS, path: "live-4.md" })) as { versions: Array<{ id: number }> };
    expect(out.versions).toHaveLength(HISTORY_ROWS);
    const ids = out.versions.map((v) => v.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });
});
