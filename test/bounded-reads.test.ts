import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server.ts";
import { GATHER_BUDGET, MAX_ROWS, SEARCH_ROWS } from "../src/limits.ts";
import { defaultScopes } from "../src/agents-schema.ts";
import type { Agent } from "../src/agents.ts";
import { type DocRow, fakeD1, fakeEnv, type FakeD1Options, type Recorded } from "./fakes.ts";

// Every read says when it cut. Two assertions per site: the response reports truncation, and the query asked the store for a bounded page; only the
// second protects the isolate, since a handler fetching every row then slicing satisfies the first.

async function connect(opts: FakeD1Options = {}, caller?: Agent) {
  const { db, reads } = fakeD1(opts);
  const env = fakeEnv({ DB: db });
  const server = caller ? buildServer(env, caller) : buildServer(env, "write", "test:bounds");
  const client = new Client({ name: "bounds-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, reads, close: () => client.close() };
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

// The bound is enforced in SQL, so the proof is the value bound to the LIMIT, read by the index the LIMIT names rather than by position.
const limitBoundTo = (recorded: Recorded[], match: RegExp): unknown => {
  const stmt = recorded.find((r) => match.test(r.sql.replace(/\s+/g, " ")));
  assert.ok(stmt, `no statement matched ${match}`);
  const limit = /LIMIT \?(\d+)/.exec(stmt.sql.replace(/\s+/g, " "));
  assert.ok(limit, "the query carries no LIMIT, so the whole table is materialized");
  return stmt.params[Number(limit[1]) - 1];
};

const docs = (n: number, namespace = "capsid", prefix = "doc"): DocRow[] =>
  Array.from({ length: n }, (_, i) => ({
    namespace,
    path: `${prefix}-${String(i).padStart(4, "0")}.md`,
    title: `Doc ${i}`,
  }));

test("list returns a bounded page and says it was cut, and under the bound says nothing", async () => {
  for (const [n, truncated] of [
    [MAX_ROWS + 25, true],
    [3, false],
  ] as const) {
    const { client, reads, close } = await connect({ documents: docs(n) });
    const out = parse(await call(client, "capsid_find_docs", { action: "list" }));
    await close();
    assert.equal(out.truncated, truncated);
    assert.equal(out.count, Math.min(n, MAX_ROWS));
    assert.equal(out.note === undefined, !truncated);
    assert.equal(
      limitBoundTo(reads, /FROM documents WHERE \(\?1 IS NULL OR namespace/),
      MAX_ROWS + 1,
    );
  }
});

test("a namespace-scoped list is not truncated by another namespace's documents", async () => {
  // MAX_ROWS is set above the largest real namespace so scoped reads are not cut.
  // If the filter were dropped, these 30 rows would arrive with 600 others and truncate.
  const { client, close } = await connect({
    documents: [...docs(600, "sample"), ...docs(30, "capsid")],
  });
  const out = parse(
    await call(client, "capsid_find_docs", { action: "list", namespace: "capsid" }),
  );
  await close();
  assert.equal(
    out.truncated,
    false,
    "a scoped list truncated, so the filter is not reaching the query",
  );
  assert.equal(out.count, 30);
});

test("find returns a bounded page and says it was cut; a glob matching a handful is complete", async () => {
  const big = await connect({ documents: docs(MAX_ROWS + 10) });
  const cut = parse(
    await call(big.client, "capsid_find_docs", { action: "glob", glob: "doc-*.md" }),
  );
  await big.close();
  assert.equal(cut.truncated, true);
  assert.equal(cut.count, MAX_ROWS);
  assert.equal(limitBoundTo(big.reads, /WHERE path GLOB/), MAX_ROWS + 1);

  const few = await connect({
    documents: [...docs(400, "capsid", "other"), ...docs(4, "capsid", "notes/session")],
  });
  const whole = parse(
    await call(few.client, "capsid_find_docs", { action: "glob", glob: "notes/*.md" }),
  );
  await few.close();
  assert.equal(whole.truncated, false);
  assert.equal(whole.count, 4);
});

test("search returns its top page and says when more matched", async () => {
  const { client, reads, close } = await connect({ ftsRows: SEARCH_ROWS + 5 });
  const out = parse(
    await call(client, "capsid_find_docs", { action: "search", query: "anything" }),
  );
  await close();
  assert.equal(
    out.truncated,
    true,
    "search silently returned a full page as if it were the whole answer",
  );
  assert.equal(out.count, SEARCH_ROWS);
  assert.equal(limitBoundTo(reads, /FROM documents_fts/), SEARCH_ROWS + 1);
});

// A packet that trims must still be usable: core and the rules survive whatever
// else goes, because they are the instructions for the job.
const BIG = "x".repeat(40_000);

const gatherFixture = (): FakeD1Options => ({
  documents: [
    { namespace: "capsid", path: "core.md", type: "note", body: "the core" },
    { namespace: "capsid", path: "schema.md", type: "note", body: "the schema rules" },
    { namespace: "capsid", path: "conventions.md", type: "note", body: "the conventions" },
    ...Array.from({ length: 4 }, (_, i) => ({
      namespace: "capsid",
      path: `concept-${i}.md`,
      type: "concept",
      body: BIG,
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      namespace: "capsid",
      path: `session-${i}.md`,
      type: "episodic",
      body: BIG,
      created_at: `2026-08-0${i + 1} 00:00:00`,
    })),
  ],
});

test("gather trims an oversized packet and names what it dropped", async () => {
  // 8 x 40KB of body against a 150KB budget, so the packet cannot fit and the
  // tool must choose.
  const { client, close } = await connect(gatherFixture());
  const out = parse(
    await call(client, "capsid_lint_namespace", { namespace: "capsid", mode: "gather" }),
  );
  await close();

  assert.equal(out.truncated, true, "an oversized packet reported itself as whole");
  assert.ok(
    out.packet_chars <= GATHER_BUDGET,
    `packet is ${out.packet_chars}, over the ${GATHER_BUDGET} budget`,
  );
  assert.equal(out.budget, GATHER_BUDGET);
  assert.ok(Array.isArray(out.trimmed) && out.trimmed.length > 0, "nothing was named as trimmed");

  assert.match(out.trimmed.join(" | "), /wiki bodies/);
  assert.ok(
    out.wiki.length > 0,
    "the packet carries no wiki rows, so the stub check below checks nothing",
  );
  for (const row of out.wiki) {
    assert.match(
      row.body,
      /^\(trimmed for size: read it with capsid_read_doc, capsid\/concept-\d\.md\)$/,
    );
  }
  // core and the rules are never trimmed: without them the packet is useless. capsid/schema.md
  // is in the store but is not a rule document, so it is not read.
  assert.equal(out.core.body, "the core");
  assert.deepEqual(out.rules.map((r: { path: string; body: string }) => r.body).sort(), [
    "the conventions",
  ]);
});

test("gather keeps the OLDEST unconsolidated bodies, which is the compile order", async () => {
  const { client, close } = await connect(gatherFixture());
  const out = parse(
    await call(client, "capsid_lint_namespace", { namespace: "capsid", mode: "gather" }),
  );
  await close();

  const kept = out.unconsolidated.filter((r: { body: string }) => !r.body.startsWith("(trimmed"));
  const held = out.unconsolidated.filter((r: { body: string }) => r.body.startsWith("(trimmed"));
  assert.ok(kept.length > 0, "everything was held back, so the packet does no work");
  assert.ok(held.length > 0, "this fixture is meant to exceed the budget");
  // Whole documents, never half a body: a truncated markdown file cannot be told
  // apart from a complete one by the client reading it.
  for (const row of kept) assert.equal(row.body, BIG);
  // Oldest first. If this reversed, a client compiling "the next batch" would
  // repeatedly get the newest and never drain the queue.
  const keptPaths = kept.map((r: { path: string }) => r.path);
  assert.deepEqual(
    keptPaths,
    [...keptPaths].sort(),
    "kept documents are not the oldest by created_at",
  );
  assert.ok(
    keptPaths[keptPaths.length - 1] < held[0].path,
    `kept ${keptPaths.join(",")} but held ${held.map((h: { path: string }) => h.path).join(",")}`,
  );
});

test("a gather that fits is not trimmed at all", async () => {
  const { client, close } = await connect({
    documents: [
      { namespace: "capsid", path: "core.md", type: "note", body: "the core" },
      { namespace: "capsid", path: "session-0.md", type: "episodic", body: "small" },
    ],
  });
  const out = parse(
    await call(client, "capsid_lint_namespace", { namespace: "capsid", mode: "gather" }),
  );
  await close();
  assert.equal(out.truncated, false);
  assert.equal(out.trimmed, undefined);
  assert.equal(out.unconsolidated[0].body, "small");
});

test("resources/list is bounded, and hands back a cursor to the rest", async () => {
  const { client, reads, close } = await connect({ documents: docs(MAX_ROWS + 7) });
  const first = await client.listResources({ cursor: "" });
  assert.equal(first.resources.length, MAX_ROWS, "the resource listing is unbounded");
  assert.ok(first.nextCursor, "the listing was capped with no way to reach the rest");
  assert.equal(limitBoundTo(reads, /SELECT namespace, path, title FROM documents/), MAX_ROWS + 1);

  const second = await client.listResources({ cursor: first.nextCursor });
  await close();
  assert.equal(second.resources.length, 7, "the second page did not return the remainder");
  assert.equal(second.nextCursor, undefined, "the last page still advertised more");

  // No overlap and no gap: keyset pagination is only correct if the tuple compare
  // is right, and an off-by-one there repeats or skips a document silently.
  const firstUris = first.resources.map((r) => r.uri);
  const secondUris = second.resources.map((r) => r.uri);
  assert.equal(
    new Set([...firstUris, ...secondUris]).size,
    MAX_ROWS + 7,
    "pages overlap or drop documents",
  );
});

test("resources/list paginates across namespaces without skipping a boundary", async () => {
  // The tuple compare exists for exactly this: 'ns-a' and 'ns' both prefix each
  // other once a separator is glued on, so a concatenated cursor key reorders the
  // rows and loses whichever straddles the page edge.
  const { client, close } = await connect({
    documents: [...docs(MAX_ROWS - 1, "ns"), ...docs(4, "ns-a")],
  });
  // An explicit cursor asks the v2 client for one page; without one it walks every page.
  const first = await client.listResources({ cursor: "" });
  const second = await client.listResources({ cursor: first.nextCursor });
  await close();
  const all = [...first.resources, ...second.resources].map((r) => r.uri);
  assert.equal(
    new Set(all).size,
    MAX_ROWS + 3,
    "a document was skipped or repeated at the namespace boundary",
  );
});

test("PLANT: a caller scoped past MAX_ROWS rows it cannot see still gets its own documents", async () => {
  // A LIMIT applied before the scope filter would give this caller an empty page and no cursor. 'aaa' sorts before 'capsid'.
  const scopes = defaultScopes(["capsid"]);
  scopes.tools = ["capsid_read_doc"];
  const caller: Agent = {
    id: "agent_narrow01",
    name: "narrow",
    kind: "session",
    actor: "agent:narrow",
    scopes,
    admin: false,
    row: null,
  };
  const { client, close } = await connect(
    {
      documents: [
        ...docs(MAX_ROWS + 2, "aaa"),
        { namespace: "capsid", path: "core.md", title: "core" },
        { namespace: "capsid", path: "decisions.md", title: "decisions" },
      ],
    },
    caller,
  );
  const listed = await client.listResources();
  await close();
  assert.deepEqual(listed.resources.map((r) => r.uri).sort(), [
    "capsid://capsid/core.md",
    "capsid://capsid/decisions.md",
  ]);
  assert.equal(listed.nextCursor, undefined);
});
