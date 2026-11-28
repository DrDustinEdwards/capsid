import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server";

// conventions-read against real SQLite: the NOT EXISTS window, the row's address, and that last_actor is
// still the document's last writer.

async function call(name: string, args: Record<string, unknown>, actor = "test:reader") {
  const server = buildServer(env as never, "read", actor);
  const client = new Client({ name: "t", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await client.close();
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

const rows = (actor?: string) =>
  env.DB.prepare(
    "SELECT actor, namespace, path, params FROM audit_log WHERE action = 'conventions-read' AND (?1 IS NULL OR actor = ?1) ORDER BY id",
  )
    .bind(actor ?? null)
    .all<{ actor: string; namespace: string; path: string | null; params: string }>()
    .then((r) => r.results);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM audit_log").run();
  await env.DB.prepare("DELETE FROM documents").run();
  const doc = (ns: string, path: string, type: string) =>
    env.DB.prepare(
      "INSERT INTO documents (namespace, path, title, body, type, status) VALUES (?1, ?2, 't', 'b', ?3, 'published')",
    )
      .bind(ns, path, type)
      .run();
  await doc("capsid", "conventions.md", "procedural");
  await doc("capsid", "repo-structure.md", "procedural");
  await doc("sample", "core.md", "core");
  await doc("sample", "notes.md", "reference");
});

describe("conventions-read", () => {
  it("a read of capsid/conventions.md and a brief each write one row with their address; a read of any other document writes none", async () => {
    await call("capsid_read_doc", {
      action: "read",
      namespace: "capsid",
      path: "repo-structure.md",
    });
    await call("capsid_read_doc", { action: "read", namespace: "sample", path: "core.md" });
    await call("capsid_read_doc", { action: "read", namespace: "sample", path: "notes.md" });
    expect(await rows()).toEqual([]);
    await call(
      "capsid_read_doc",
      { action: "read", namespace: "capsid", path: "conventions.md" },
      "agent:one",
    );
    await call("capsid_start_session", { namespace: "sample" }, "agent:two");
    // A namespace with no core.md still counts: the brief still carries the rules.
    await call("capsid_start_session", { namespace: "empty" }, "agent:three");
    const out = await rows();
    expect(out.map((r) => [r.actor, r.namespace, r.path, JSON.parse(r.params)])).toEqual([
      ["agent:one", "capsid", null, { via: "read", for_namespace: "capsid" }],
      ["agent:two", "capsid", null, { via: "brief", for_namespace: "sample" }],
      ["agent:three", "capsid", null, { via: "brief", for_namespace: "empty" }],
    ]);
  });

  it("a caller's second read inside the hour writes none, whichever tool it came by; one after the hour writes a new row", async () => {
    await call("capsid_start_session", { namespace: "sample" });
    await call("capsid_read_doc", { action: "read", namespace: "capsid", path: "conventions.md" });
    await call("capsid_start_session", { namespace: "sample" });
    expect(await rows("test:reader")).toHaveLength(1);
    await env.DB.prepare(
      "UPDATE audit_log SET at = datetime('now', '-59 minutes') WHERE action = 'conventions-read'",
    ).run();
    await call("capsid_read_doc", { action: "read", namespace: "capsid", path: "conventions.md" });
    expect(await rows("test:reader")).toHaveLength(1);
    await env.DB.prepare(
      "UPDATE audit_log SET at = datetime('now', '-61 minutes') WHERE action = 'conventions-read'",
    ).run();
    await call("capsid_read_doc", { action: "read", namespace: "capsid", path: "conventions.md" });
    expect(await rows("test:reader")).toHaveLength(2);
  });

  it("threads that name themselves are counted one by one under one login, and a thread once an hour", async () => {
    await call("capsid_start_session", { namespace: "sample", thread: "Thread A" });
    await call("capsid_start_session", { namespace: "sample", thread: "Thread B" });
    await call("capsid_start_session", { namespace: "sample", thread: "Thread A" });
    const out = await rows();
    expect(out.map((r) => JSON.parse(r.params).thread)).toEqual(["Thread A", "Thread B"]);
  });

  it("does not make the reader the document's last_actor", async () => {
    await env.DB.prepare(
      "INSERT INTO audit_log (namespace, path, action, actor) VALUES ('capsid', 'conventions.md', 'write', 'access:dustin')",
    ).run();
    const first = await call("capsid_read_doc", {
      action: "read",
      namespace: "capsid",
      path: "conventions.md",
    });
    const second = await call("capsid_start_session", { namespace: "sample" }, "agent:other");
    expect(first.last_actor).toBe("access:dustin");
    expect(second.conventions.last_actor).toBe("access:dustin");
  });
});
