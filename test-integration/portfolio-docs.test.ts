import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server";
import { defaultScopes } from "../src/agents-schema";
import type { Agent } from "../src/agents";

// Real SQLite: the GLOB and json_each narrowing the unit fake models by name, and FTS5 search, which the fake answers with fixed rows.

function carrelDriver(): Agent {
  const scopes = defaultScopes(["carrel"]);
  scopes.grants = ["read", "write"];
  return {
    id: "agent_0123456789ab",
    name: "carrel-driver",
    kind: "driver",
    actor: "agent:carrel-driver",
    scopes,
    admin: false,
    row: null,
  };
}

async function call(name: string, args: Record<string, unknown>) {
  const server = buildServer(env as never, carrelDriver());
  const client = new Client({ name: "t", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await client.close();
  return result;
}

const ok = async (name: string, args: Record<string, unknown>) => {
  const result = await call(name, args);
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return JSON.parse(result.content[0].text);
};

const ALLOWED = ["conventions.md", "core.md", "rulings/remove-improve-loop-2026-10-19.md"];
const DENIED = [
  "decisions.md",
  "policy/gates.md",
  "research/plan.md",
  "rulings-secret/plan.md",
  "rulings/deeper/nested.md",
];

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM audit_log").run();
  await env.DB.prepare("DELETE FROM documents").run();
  const doc = (ns: string, path: string) =>
    env.DB.prepare(
      "INSERT INTO documents (namespace, path, title, body, type, status) VALUES (?1, ?2, ?2, 'the gatepost rule', 'decision', 'published')",
    )
      .bind(ns, path)
      .run();
  for (const path of [...ALLOWED, ...DENIED]) await doc("capsid", path);
  await doc("carrel", "core.md");
});

describe("portfolio documents", () => {
  it("list in capsid returns exactly the portfolio documents to a carrel driver", async () => {
    const out = await ok("capsid_find_docs", { action: "list", namespace: "capsid" });
    expect(out.documents.map((d: { path: string }) => d.path)).toEqual(ALLOWED);
  });

  it("search in capsid returns only portfolio documents, though every capsid document matches", async () => {
    const out = await ok("capsid_find_docs", {
      action: "search",
      namespace: "capsid",
      query: "gatepost",
    });
    expect(out.documents.map((d: { path: string }) => d.path).sort()).toEqual(ALLOWED);
  });
});
