import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server.ts";
import { defaultScopes } from "../src/agents-schema.ts";
import type { Agent } from "../src/agents.ts";
import { fakeEnv } from "./fakes.ts";
import { d1, migratedDb } from "./sqlite-d1.ts";

function fresh(): DatabaseSync {
  const raw = migratedDb();
  for (const ns of ["sample", "other"])
    raw.prepare("INSERT INTO namespaces (namespace) VALUES (?)").run(ns);
  for (const [ns, path] of [
    ["sample", "old.md"],
    ["sample", "core.md"],
    ["other", "old.md"],
  ]) {
    raw
      .prepare("INSERT INTO documents (namespace, path, title, body) VALUES (?, ?, ?, 'body')")
      .run(ns, path, path);
  }
  return raw;
}

// A driver as docs/bootstrap.md mints one: write on its own namespace, no flag.
function driver(): Agent {
  const scopes = defaultScopes(["sample"]);
  scopes.grants = ["read", "write"];
  return {
    id: "agent_0123456789ab",
    name: "sample-driver",
    kind: "driver",
    actor: "agent:sample-driver",
    scopes,
    admin: false,
    row: null,
  };
}

async function call(
  raw: DatabaseSync,
  caller: Agent | "write",
  tool: string,
  args: Record<string, unknown>,
) {
  const server = buildServer(
    fakeEnv({ DB: d1(raw) }),
    caller,
    caller === "write" ? "test:docs-guards" : "",
  );
  const client = new Client({ name: "docs-guards", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const result = (await client.callTool({ name: tool, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await client.close();
  await server.close();
  return result;
}

const write = (raw: DatabaseSync, caller: Agent, args: Record<string, unknown>) =>
  call(raw, caller, "capsid_write_doc", { action: "write", ...args });

const edges = (raw: DatabaseSync) =>
  raw.prepare("SELECT type, to_ns, to_path FROM document_links ORDER BY to_ns, to_path").all();

test("PLANT: a supersedes or replaces edge needs the write grant on its target's namespace and the seat for canon", async () => {
  for (const link of [
    { type: "supersedes", to_ns: "other", to_path: "old.md" },
    { type: "replaces", to_ns: "other", to_path: "old.md" },
    { type: "supersedes", to_path: "core.md" },
  ]) {
    const raw = fresh();
    const result = await write(raw, driver(), {
      namespace: "sample",
      path: "new.md",
      title: "New",
      body: "new",
      links: JSON.stringify([link]),
    });
    assert.equal(result.isError, true, `the edge ${JSON.stringify(link)} was stored`);
    assert.match(result.content[0].text, /Nothing was written/);
    assert.deepEqual(edges(raw), [], "a refused write stored an edge");
    assert.equal(
      raw.prepare("SELECT COUNT(*) AS n FROM documents WHERE path = 'new.md'").get()?.n,
      0,
      "a refused write stored the document",
    );
  }
});

test("PLANT: replacing a document's edges records the edges it replaced in the audit row", async () => {
  const raw = fresh();
  const first = [
    { type: "supersedes", to_path: "old.md" },
    { type: "references", to_ns: "other", to_path: "old.md" },
  ];
  assert.equal(
    (
      await write(raw, driver(), {
        namespace: "sample",
        path: "new.md",
        title: "New",
        body: "new",
        links: JSON.stringify(first),
      })
    ).isError,
    undefined,
  );
  const second = await write(raw, driver(), {
    namespace: "sample",
    path: "new.md",
    mode: "meta",
    status: "draft",
    links: "[]",
  });
  assert.equal(second.isError, undefined, second.content[0]?.text);
  assert.deepEqual(edges(raw), []);
  const rows = raw
    .prepare("SELECT params FROM audit_log WHERE action = 'links' ORDER BY id")
    .all() as Array<{ params: string }>;
  assert.equal(rows.length, 2);
  assert.deepEqual(JSON.parse(rows[0].params), { edges: 2, edges_replaced: [] });
  const replaced = JSON.parse(rows[1].params) as {
    edges: number;
    edges_replaced: Array<Record<string, string>>;
  };
  assert.equal(replaced.edges, 0);
  assert.deepEqual(
    replaced.edges_replaced.sort((a, b) => a.to_ns.localeCompare(b.to_ns)),
    [
      { type: "references", to_ns: "other", to_path: "old.md" },
      { type: "supersedes", to_ns: "sample", to_path: "old.md" },
    ],
  );
});

test("PLANT: the links read shows an incoming edge only when the caller may read its source", async () => {
  const raw = fresh();
  raw
    .prepare(
      "INSERT INTO documents (namespace, path, title, body) VALUES ('other', 'secret-plan.md', 'plan', 'body')",
    )
    .run();
  const link = raw.prepare(
    "INSERT INTO document_links (from_ns, from_path, type, to_ns, to_path) VALUES (?, ?, 'references', 'sample', 'old.md')",
  );
  link.run("other", "secret-plan.md");
  link.run("sample", "core.md");
  const read = async (caller: Agent | "write") =>
    JSON.parse(
      (
        await call(raw, caller, "capsid_read_doc", {
          action: "links",
          namespace: "sample",
          path: "old.md",
        })
      ).content[0].text,
    ) as { incoming: Array<{ from_ns: string; from_path: string }> };
  assert.deepEqual(
    (await read(driver())).incoming.map((e) => `${e.from_ns}/${e.from_path}`),
    ["sample/core.md"],
    "a driver of sample saw an edge from a namespace it cannot read",
  );
  assert.deepEqual(
    (await read("write")).incoming.map((e) => `${e.from_ns}/${e.from_path}`).sort(),
    ["other/secret-plan.md", "sample/core.md"],
    "the admin lost an edge",
  );
});
