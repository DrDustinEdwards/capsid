import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server";

// conventions-read (job_3396ab4fb746), against real SQLite: the NOT EXISTS window, the
// row's address, and that last_actor is still the document's last writer.

async function call(name: string, args: Record<string, unknown>, actor = "test:reader") {
  const server = buildServer(env as never, "read", actor);
  const client = new Client({ name: "t", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  await client.close();
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

const rows = (actor?: string) =>
  env.DB.prepare("SELECT actor, namespace, path, params FROM audit_log WHERE action = 'conventions-read' AND (?1 IS NULL OR actor = ?1) ORDER BY id")
    .bind(actor ?? null)
    .all<{ actor: string; namespace: string; path: string | null; params: string }>()
    .then((r) => r.results);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM audit_log").run();
  await env.DB.prepare("DELETE FROM documents").run();
  const doc = (ns: string, path: string, type: string) =>
    env.DB.prepare("INSERT INTO documents (namespace, path, title, body, type, status) VALUES (?1, ?2, 't', 'b', ?3, 'published')")
      .bind(ns, path, type)
      .run();
  await doc("capsid", "conventions.md", "procedural");
  await doc("capsid", "repo-structure.md", "procedural");
  await doc("sample", "core.md", "core");
  await doc("sample", "notes.md", "reference");
});

describe("conventions-read", () => {
  it("a direct read of capsid/conventions.md writes one row, addressed to no document", async () => {
    await call("read", { namespace: "capsid", path: "conventions.md" });
    const out = await rows();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ actor: "test:reader", namespace: "capsid", path: null });
    expect(JSON.parse(out[0].params)).toEqual({ via: "read", for_namespace: "capsid" });
  });

  it("a brief writes one row, naming the namespace it was for", async () => {
    await call("brief", { namespace: "sample" });
    const out = await rows();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].params)).toEqual({ via: "brief", for_namespace: "sample" });
  });

  it("a second read by the same caller inside the hour writes none, whichever tool it came by", async () => {
    await call("brief", { namespace: "sample" });
    await call("read", { namespace: "capsid", path: "conventions.md" });
    await call("brief", { namespace: "sample" });
    expect(await rows()).toHaveLength(1);
  });

  it("another caller's read is its own row", async () => {
    await call("read", { namespace: "capsid", path: "conventions.md" }, "agent:one");
    await call("read", { namespace: "capsid", path: "conventions.md" }, "agent:two");
    expect((await rows()).map((r) => r.actor)).toEqual(["agent:one", "agent:two"]);
  });

  it("a read after the hour writes a new row, and one just inside it does not", async () => {
    await env.DB.prepare(
      "INSERT INTO audit_log (actor, action, namespace, path, params, at) VALUES ('test:reader', 'conventions-read', 'capsid', NULL, '{}', datetime('now', '-61 minutes'))"
    ).run();
    await call("read", { namespace: "capsid", path: "conventions.md" });
    expect(await rows("test:reader")).toHaveLength(2);
    await env.DB.prepare("UPDATE audit_log SET at = datetime('now', '-59 minutes') WHERE action = 'conventions-read'").run();
    await call("read", { namespace: "capsid", path: "conventions.md" });
    expect(await rows("test:reader")).toHaveLength(2);
  });

  it("a read of any other document writes none, in capsid or elsewhere", async () => {
    await call("read", { namespace: "capsid", path: "repo-structure.md" });
    await call("read", { namespace: "sample", path: "core.md" });
    await call("read", { namespace: "sample", path: "notes.md" });
    expect(await rows()).toEqual([]);
  });

  it("a brief for a namespace with no core.md still counts, because it still carries the rules", async () => {
    await call("brief", { namespace: "empty" });
    expect(await rows()).toHaveLength(1);
  });

  it("does not make the reader the document's last_actor", async () => {
    await env.DB.prepare("INSERT INTO audit_log (namespace, path, action, actor) VALUES ('capsid', 'conventions.md', 'write', 'access:dustin')").run();
    const first = await call("read", { namespace: "capsid", path: "conventions.md" });
    const second = await call("brief", { namespace: "sample" }, "agent:other");
    expect(first.last_actor).toBe("access:dustin");
    expect(second.conventions.last_actor).toBe("access:dustin");
  });
});
