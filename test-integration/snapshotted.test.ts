import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server";

// write AND restore REPORT `snapshotted` FROM THE SNAPSHOT'S OWN RESULT (audit
// 2026-09-25, item E1-20, finding F3-8), against real SQLite. The node test in
// test/snapshotted.test.ts drives the same race through the fake; this one shows that
// D1 answers RETURNING on the INSERT ... SELECT inside a batch, which the fake cannot.

const NS = "sample";

// Deletes the document just before the handler's first batch, the gap no guard covers
// on a confirm: true write with no if_match.
function deletingDb(db: D1Database, path: string): D1Database {
  let raced = false;
  return {
    prepare: (sql: string) => db.prepare(sql),
    exec: (sql: string) => db.exec(sql),
    dump: () => db.dump(),
    withSession: (c?: string) => db.withSession(c),
    batch: async (statements: D1PreparedStatement[]) => {
      if (!raced) {
        raced = true;
        await db.prepare("DELETE FROM documents WHERE namespace = ?1 AND path = ?2").bind(NS, path).run();
      }
      return db.batch(statements);
    },
  } as unknown as D1Database;
}

async function callTool(db: D1Database, name: string, args: Record<string, unknown>) {
  const server = buildServer({ ...env, DB: db } as never, "write", "test:integration");
  const client = new Client({ name: "snapshotted", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  await client.close();
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return JSON.parse(result.content[0].text) as { snapshotted: boolean };
}

async function seed(path: string) {
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, '[]')").bind(NS).run();
  await env.DB.prepare("INSERT INTO documents (namespace, path, title, body) VALUES (?1, ?2, 'Lorem', 'lorem ipsum')")
    .bind(NS, path)
    .run();
}

const write = (path: string) => ({ namespace: NS, path, title: "Lorem", body: "new lorem", confirm: true });

describe("snapshotted is read from the batch", () => {
  it("write reports true when the snapshot was taken", async () => {
    await seed("snap-1.md");
    expect((await callTool(env.DB, "write", write("snap-1.md"))).snapshotted).toBe(true);
  });

  it("write reports false when the row was deleted before its batch", async () => {
    await seed("snap-2.md");
    expect((await callTool(deletingDb(env.DB, "snap-2.md"), "write", write("snap-2.md"))).snapshotted).toBe(false);
  });

  it("restore reports false when the row was deleted before its batch", async () => {
    await seed("snap-3.md");
    await callTool(env.DB, "write", write("snap-3.md"));
    const version = await env.DB.prepare("SELECT id FROM document_versions WHERE namespace = ?1 AND path = ?2")
      .bind(NS, "snap-3.md")
      .first<{ id: number }>();
    expect(version).not.toBeNull();
    const out = await callTool(deletingDb(env.DB, "snap-3.md"), "restore", {
      namespace: NS,
      path: "snap-3.md",
      version_id: version!.id,
      confirm: true,
    });
    expect(out.snapshotted).toBe(false);
  });
});
