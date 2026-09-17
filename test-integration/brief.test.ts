import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server";

// BRIEF'S GROUPED PROVENANCE, AGAINST REAL SQLITE. test/brief.test.ts proves brief
// issues one audit_log query; its fake answers that query by pattern, so it cannot
// tell whether SQLite accepts json_each over a bound parameter, or whether the
// correlated subquery returns the NEWEST actor per document. This can.

async function brief(namespace: string) {
  const server = buildServer(env as never, "read", "test:integration");
  const client = new Client({ name: "brief", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const result = (await client.callTool({ name: "brief", arguments: { namespace } })) as {
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
        "INSERT INTO documents (namespace, path, title, body, type, status) VALUES (?1, ?2, 't', 'b', ?3, 'published')"
      )
        .bind(ns, path, type)
        .run();
    await doc("capsid", "conventions.md", "procedural");
    await doc("capsid", "repo-structure.md", "procedural");
    await doc("sample", "core.md", "core");
    await doc("sample", "TASK-a.md", "task");
    await doc("sample", "TASK-b.md", "task");
    const audit = (ns: string, path: string, actor: string) =>
      env.DB.prepare("INSERT INTO audit_log (namespace, path, action, actor) VALUES (?1, ?2, 'write', ?3)")
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
    const byPath = Object.fromEntries(out.open_tasks.map((t: { path: string; last_actor: string | null }) => [t.path, t.last_actor]));
    expect(byPath).toEqual({ "TASK-a.md": null, "TASK-b.md": "agent:seat" });
  });
});
