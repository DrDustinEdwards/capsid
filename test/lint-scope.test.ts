import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { defaultScopes } from "../src/agents-schema.ts";
import { adminAgent, type Agent } from "../src/agents.ts";
import { fakeD1, fakeEnv, fakeKv, withFetch, type FetchCall } from "./fakes.ts";

// RULING E2-L16 (2026-09-25): lint is filtered to the caller's namespace and may not
// read outside it, except capsid/schema.md and capsid/conventions.md, which every
// caller's lint reads as its rules. Before it, a caller scoped only to "sample" saw
// whether documents in other namespaces exist through dangling edges (and persisted
// those into its own report), and had its namespace's repo tree read with no check
// against its repos axis.

const OWN_REPO = "example/sample-repo";

// Edges touching "sample": one inside it, one into "other", which this caller is not
// scoped to. Both dangle, so each answers a different question about existence.
const DANGLING = [
  { from_ns: "sample", from_path: "spec.md", type: "implements", to_ns: "sample", to_path: "gone.md", source_missing: 0, target_missing: 1 },
  { from_ns: "sample", from_path: "spec.md", type: "cites", to_ns: "other", to_path: "private-plan.md", source_missing: 0, target_missing: 1 },
];
const EDGES = DANGLING.map(({ from_ns, from_path, type, to_ns, to_path }) => ({ from_ns, from_path, type, to_ns, to_path }));
const RULES = [{ namespace: "capsid", path: "conventions.md", title: "Conventions", body: "lorem ipsum rules" }];

function scopedTo(namespaces: string[], repos: string[] | "*"): Agent {
  const scopes = defaultScopes(namespaces);
  scopes.grants = ["read", "write"];
  scopes.repos = repos;
  return { id: "agent_lintscope1", name: "lintscope", kind: "session", actor: "agent:lintscope", scopes, admin: false, row: null };
}

async function connect(agent: Agent) {
  const base = fakeD1({
    documents: [{ namespace: "sample", path: "core.md", type: "core", body: "lorem" }],
    namespaces: [{ namespace: "sample", repos: JSON.stringify([{ repo: OWN_REPO, label: "primary" }]) }],
  });
  const asked: string[] = [];
  const canned = (results: unknown[]) => {
    const s = { bind: () => s, all: async () => ({ results }), first: async () => results[0] ?? null };
    return s;
  };
  const db = {
    ...base.db,
    prepare: (sql: string) => {
      const flat = sql.replace(/\s+/g, " ");
      asked.push(flat);
      if (/LEFT JOIN documents t/.test(flat)) return canned(DANGLING);
      if (/FROM document_links WHERE from_ns/.test(flat)) return canned(EDGES);
      if (/namespace = 'capsid' AND path IN/.test(flat)) return canned(RULES);
      return base.db.prepare(sql);
    },
  };
  const env = fakeEnv({ DB: db, APP_KV: fakeKv({ seedToken: true }).kv });
  const server = buildServer(env, agent);
  const client = new Client({ name: "lint-scope", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { client, asked, recorded: base.recorded, close: () => client.close() };
}

const call = async (client: Client, args: Record<string, unknown>) =>
  (await client.callTool({ name: "lint", arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
const text = (result: { content: Array<{ text: string }> }) => result.content.map((c) => c.text).join("");

const treeRoutes = {
  [`GET /repos/${OWN_REPO}`]: { body: { default_branch: "main" } },
  [`GET /repos/${OWN_REPO}/git/trees/main`]: { body: { truncated: false, tree: [{ path: "README.md", type: "blob" }] } },
};
const treeReads = (calls: FetchCall[]) => calls.filter((c) => c.path.includes("/git/trees/")).length;

test("PLANT: gather for a caller scoped to one namespace gets the capsid rules and nothing else outside it", async () => {
  const { client, asked, close } = await connect(scopedTo(["sample"], "*"));
  try {
    const result = await call(client, { namespace: "sample" });
    assert.ok(!result.isError, text(result));
    const packet = JSON.parse(text(result));
    // capsid/schema.md and capsid/conventions.md are exempt from the filter (ruling,
    // 2026-09-25): they are the rules every caller's lint runs under.
    assert.deepEqual(packet.rules, RULES, "the capsid rules were withheld from a caller not scoped to capsid");
    assert.equal(packet.rules_withheld, undefined);
    // The exemption is those two paths only: no other capsid document is read.
    const capsidReads = asked.filter((sql) => /namespace = 'capsid'/.test(sql));
    assert.equal(capsidReads.length, 1);
    assert.match(capsidReads[0], /path IN \('schema\.md', 'conventions\.md'\)/);
    assert.deepEqual(
      packet.dangling_edges.map((e: { to_ns: string }) => e.to_ns),
      ["sample"],
      "a dangling edge into an out-of-scope namespace was returned"
    );
  } finally {
    await close();
  }
});

test("PLANT: report for a caller scoped to one namespace persists nothing about another, and skips a repo off its axis", async () => {
  const { client, recorded, close } = await connect(scopedTo(["sample"], ["example/unrelated"]));
  try {
    await withFetch(treeRoutes, async (calls) => {
      const result = await call(client, { namespace: "sample", mode: "report" });
      assert.ok(!result.isError, text(result));
      assert.equal(treeReads(calls), 0, "the repo tree was read although the repo is outside the caller's repos axis");
    });
    const written = recorded.flatMap((r) => r.params.map(String)).join("\n");
    assert.ok(written.includes("sample/gone.md"), "the in-scope dangling edge is missing from the stored report; the test is not looking at the report");
    assert.ok(!written.includes("other/private-plan.md"), "the stored report names a document in a namespace the caller is not scoped to");
  } finally {
    await close();
  }
});

test("THE INNOCENT DIRECTION: an unrestricted caller still gets the rules, every edge and the repo tree", async () => {
  const { client, recorded, close } = await connect(adminAgent("DrDustinEdwards"));
  try {
    const gathered = JSON.parse(text(await call(client, { namespace: "sample" })));
    assert.equal(gathered.rules.length, 1);
    assert.equal(gathered.rules_withheld, undefined);
    assert.equal(gathered.dangling_edges.length, 2);
    await withFetch(treeRoutes, async (calls) => {
      const result = await call(client, { namespace: "sample", mode: "report" });
      assert.ok(!result.isError, text(result));
      assert.equal(treeReads(calls), 1, "the repo tree was not read for a caller whose repos axis is *");
    });
    const written = recorded.flatMap((r) => r.params.map(String)).join("\n");
    assert.ok(written.includes("other/private-plan.md"), "an unrestricted caller lost a cross-namespace edge");
  } finally {
    await close();
  }
});
