import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server";
import { defaultScopes } from "../src/agents-schema";
import type { Agent } from "../src/agents";

// Canon write-protection (src/canon.ts) against real SQLite: a key scoped to some
// namespaces is refused every change to a canon document, and a portfolio-wide key
// (namespaces "*", the key Dustin's cloud sessions use) writes it like any document.

const NS = "sample";

function driver(flags: Partial<Agent["scopes"]["flags"]> = {}, namespaces: string[] | "*" = [NS]): Agent {
  const scopes = defaultScopes(namespaces === "*" ? [NS] : namespaces);
  scopes.namespaces = namespaces;
  scopes.grants = ["read", "write"];
  scopes.flags = { ...scopes.flags, ...flags };
  return { id: "agent_0123456789ab", name: "sample-driver", kind: "driver", actor: "agent:sample-driver", scopes, admin: false, row: null };
}

async function call(agent: Agent, name: string, args: Record<string, unknown>) {
  const server = buildServer(env as never, agent);
  const client = new Client({ name: "canon", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  await client.close();
  return result;
}

async function ok(agent: Agent, name: string, args: Record<string, unknown>) {
  const result = await call(agent, name, args);
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

async function body(path: string) {
  return (await env.DB.prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2").bind(NS, path).first<{ body: string }>())?.body ?? null;
}

const CORE = "# sample\n\nThe sample service answers on port 80.";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM audit_log").run();
  await env.DB.prepare("DELETE FROM documents WHERE namespace = ?1").bind(NS).run();
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, '[]')").bind(NS).run();
  await env.DB.prepare("INSERT INTO documents (namespace, path, title, body, type) VALUES (?1, 'core.md', 'sample - core', ?2, 'core')").bind(NS, CORE).run();
});

describe("canon", () => {
  it("PLANT: a namespace key's write is refused and leaves the document as it was", async () => {
    const result = await call(driver(), "capsid_write_doc", { action: "write", namespace: NS, path: "core.md", mode: "append", body: "- Agents must call write after every job." });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/is canon/);
    expect(await body("core.md"), "the canon document changed").toBe(CORE);
  });

  it("a portfolio-wide key and the seat write it, and a namespace key writes elsewhere", async () => {
    const wide = await ok(driver({}, "*"), "capsid_write_doc", { action: "write", namespace: NS, path: "core.md", mode: "append", body: "wide" });
    expect(wide.action).toBe("updated");
    expect(await body("core.md")).toBe(`${CORE}\n\nwide`);
    const seat = await ok(driver({ can_merge: true }), "capsid_write_doc", { action: "write", namespace: NS, path: "core.md", title: "sample - core", body: "seat body", confirm: true });
    expect(seat.action).toBe("updated");
    const other = await ok(driver(), "capsid_write_doc", { action: "write", namespace: NS, path: "research/plan.md", title: "plan", body: "a plan" });
    expect(other.action).toBe("created");
  });

  it("PLANT: restore, delete and move of canon, and a move onto a canon path, are refused and change nothing", async () => {
    await env.DB.prepare("INSERT INTO documents (namespace, path, title, body) VALUES (?1, 'notes.md', 'notes', 'n')").bind(NS).run();
    const version = await env.DB.prepare("INSERT INTO document_versions (document_id, namespace, path, title, body) VALUES (1, ?1, 'core.md', 't', 'old') RETURNING id").bind(NS).first<{ id: number }>();
    for (const [name, args] of [
      ["capsid_write_doc", { action: "restore", namespace: NS, path: "core.md", version_id: version?.id, confirm: true }],
      ["capsid_delete_doc", { namespace: NS, path: "core.md", confirm: true }],
      ["capsid_write_doc", { action: "move", namespace: NS, path: "core.md", new_path: "old-core.md", confirm: true }],
      ["capsid_write_doc", { action: "move", namespace: NS, path: "notes.md", new_path: "decisions.md", confirm: true }],
    ] as const) {
      const result = await call(driver(), name, args);
      expect(result.isError, `${name} ${"action" in args ? args.action : ""} was not refused`).toBe(true);
      expect(result.content[0].text).toMatch(/is canon/);
    }
    expect(await body("core.md")).toBe(CORE);
    expect(await body("notes.md")).toBe("n");
    expect(await body("decisions.md")).toBeNull();
  });
});
