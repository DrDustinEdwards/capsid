import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server";

// Brief's grouped provenance against real SQLite: test/brief.test.ts's fake answers by pattern, so it cannot
// tell whether SQLite accepts json_each over a bound parameter or returns the NEWEST actor per document.

async function brief(namespace: string) {
  const server = buildServer(env as never, "read", "test:integration");
  const client = new Client({ name: "brief", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const result = (await client.callTool({
    name: "capsid_start_session",
    arguments: { namespace },
  })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await client.close();
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

describe("brief provenance", () => {
  it("returns the newest actor per document, and null where there is no audit row", async () => {
    const doc = (ns: string, path: string, type: string) =>
      env.DB.prepare(
        "INSERT INTO documents (namespace, path, title, body, type, status) VALUES (?1, ?2, 't', 'b', ?3, 'published')",
      )
        .bind(ns, path, type)
        .run();
    await doc("capsid", "conventions.md", "procedural");
    await doc("sample", "core.md", "core");
    await doc("sample", "TASK-a.md", "task");
    await doc("sample", "TASK-b.md", "task");
    const audit = (ns: string, path: string, actor: string) =>
      env.DB.prepare(
        "INSERT INTO audit_log (namespace, path, action, actor) VALUES (?1, ?2, 'write', ?3)",
      )
        .bind(ns, path, actor)
        .run();
    await audit("sample", "core.md", "agent:older");
    await audit("sample", "core.md", "agent:newer");
    await audit("sample", "TASK-b.md", "agent:seat");
    // Same path in another namespace must not be borrowed.
    await audit("capsid", "core.md", "agent:wrong-namespace");

    const out = await brief("sample");
    expect(out.core.last_actor).toBe("agent:newer");
    expect(out.conventions.last_actor).toBeNull();
    const byPath = Object.fromEntries(
      out.open_tasks.map((t: { path: string; last_actor: string | null }) => [
        t.path,
        t.last_actor,
      ]),
    );
    expect(byPath).toEqual({ "TASK-a.md": null, "TASK-b.md": "agent:seat" });
  });

  it("returns open handoffs written in the last 14 days, not older, closed or archived ones", async () => {
    const doc = (path: string, status: string, age: string) =>
      env.DB.prepare(
        "INSERT INTO documents (namespace, path, title, body, type, status, updated_at) VALUES ('sample-h', ?1, 't', 'b', 'episodic', ?2, datetime('now', ?3))",
      )
        .bind(path, status, age)
        .run();
    await doc("handoff/new.md", "published", "-1 days");
    await doc("handoff/edge.md", "published", "-13 days");
    await doc("handoff/old.md", "published", "-15 days");
    await doc("handoff/closed.md", "closed", "-1 days");
    await doc("archive/handoff/gone.md", "published", "-1 days");
    await doc("note.md", "published", "-1 days");
    const out = await brief("sample-h");
    expect(out.open_handoffs.map((h: { path: string }) => h.path)).toEqual([
      "handoff/new.md",
      "handoff/edge.md",
    ]);
  });
});
