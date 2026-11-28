import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server";

// A delete records the edges it removes, including one added just before its batch (the audit row is the only place they survive).
// The INSERT ... SELECT json_group_array is not evaluated by the node fake; the race is staged by wrapping D1 so the first batch() inserts an edge.

const EDGE = {
  from_ns: "sample",
  from_path: "other.md",
  type: "references",
  to_ns: "sample",
  to_path: "gone.md",
};

function racingDb(db: D1Database): D1Database {
  let raced = false;
  return {
    prepare: (sql: string) => db.prepare(sql),
    exec: (sql: string) => db.exec(sql),
    dump: () => db.dump(),
    withSession: (c?: string) => db.withSession(c),
    batch: async (statements: D1PreparedStatement[]) => {
      if (!raced) {
        raced = true;
        await db
          .prepare(
            "INSERT INTO document_links (from_ns, from_path, type, to_ns, to_path) VALUES (?1, ?2, ?3, ?4, ?5)",
          )
          .bind(EDGE.from_ns, EDGE.from_path, EDGE.type, EDGE.to_ns, EDGE.to_path)
          .run();
      }
      return db.batch(statements);
    },
  } as unknown as D1Database;
}

describe("delete records its edges inside the batch", () => {
  it("records an edge added after the handler started, and the response counts it", async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES ('sample', '[]')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO documents (namespace, path, title, body) VALUES ('sample', 'gone.md', 'Gone', 'lorem ipsum')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO document_links (from_ns, from_path, type, to_ns, to_path) VALUES ('sample', 'gone.md', 'depends-on', 'sample', 'core.md')",
    ).run();

    const server = buildServer(
      { ...env, DB: racingDb(env.DB) } as never,
      "write",
      "test:integration",
    );
    const client = new Client({ name: "delete-edges", version: "1.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    const result = (await client.callTool({
      name: "capsid_delete_doc",
      arguments: { namespace: "sample", path: "gone.md", confirm: true },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    await client.close();
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    expect(JSON.parse(result.content[0].text).edges_removed).toBe(2);

    const audit = await env.DB.prepare(
      "SELECT params FROM audit_log WHERE action = 'delete' AND namespace = 'sample' AND path = 'gone.md'",
    ).first<{ params: string }>();
    expect(audit).not.toBeNull();
    const recorded = JSON.parse(audit!.params) as { edges_removed: Array<Record<string, string>> };
    expect(recorded.edges_removed).toContainEqual(EDGE);
    expect(recorded.edges_removed).toContainEqual({
      from_ns: "sample",
      from_path: "gone.md",
      type: "depends-on",
      to_ns: "sample",
      to_path: "core.md",
    });
    expect(recorded.edges_removed).toHaveLength(2);

    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM document_links WHERE (from_ns = 'sample' AND from_path = 'gone.md') OR (to_ns = 'sample' AND to_path = 'gone.md')",
    ).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
