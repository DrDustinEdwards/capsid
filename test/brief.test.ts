import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server.ts";
import { BRIEF_BUDGET } from "../src/limits.ts";
import { type DocRow, fakeD1, fakeEnv, type FakeD1Options } from "./fakes.ts";

// Open tasks come back as stubs and every open handoff stays whole while the packet fits; nothing is cut when the documents it never
// trims are over budget on their own, since no trim could help.

async function brief(opts: FakeD1Options) {
  const fake = fakeD1(opts);
  const server = buildServer(fakeEnv({ DB: fake.db }), "write", "test:brief");
  const client = new Client({ name: "brief-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = (await client.callTool({
    name: "capsid_start_session",
    arguments: { namespace: "capsid" },
  })) as {
    content: Array<{ text: string }>;
  };
  await client.close();
  return { out: JSON.parse(result.content[0].text), reads: fake.reads };
}

const text = (n: number) => "x".repeat(n);
const floor = (each: number): DocRow[] => [
  { namespace: "capsid", path: "conventions.md", body: text(each) },
  { namespace: "capsid", path: "core.md", body: text(each) },
];
const task = (i: number, size: number): DocRow => ({
  namespace: "capsid",
  path: `TASK-${i}.md`,
  type: "task",
  status: "active",
  body: text(size),
  updated_at: `2026-09-0${i + 1} 00:00:00`,
});
const handoff = (i: number, size: number, extra: Partial<DocRow> = {}): DocRow => ({
  namespace: "capsid",
  path: `handoff/area-${i}.md`,
  type: "episodic",
  status: "published",
  body: text(size),
  updated_at: `2026-08-0${i + 1} 00:00:00`,
  ...extra,
});

const auditReads = (reads: Array<{ sql: string }>) =>
  reads.filter((r) => /FROM audit_log/i.test(r.sql)).length;

test("a floor over budget with no tasks reports the floor, not a trim of nothing", async () => {
  const each = Math.ceil(BRIEF_BUDGET / 2) + 1000;
  const { out } = await brief({ documents: floor(each) });
  assert.equal(
    out.trimmed,
    undefined,
    `brief reported a trim it did not make: ${JSON.stringify(out.trimmed)}`,
  );
  assert.deepEqual(out.floor_exceeds_budget, {
    conventions: each,
    core: each,
    floor: each * 2,
    budget: BRIEF_BUDGET,
  });
});

test("open tasks come back as stubs whatever the budget, and keep their provenance fields", async () => {
  const { out } = await brief({ documents: [...floor(100), task(0, 5000), task(1, 5000)] });
  assert.equal(out.trimmed, undefined);
  for (const t of out.open_tasks as Array<{ body: string; path: string; title: unknown }>) {
    assert.match(t.body, /not in the packet: read it with capsid_read_doc/);
    assert.ok(t.body.length < 200, `stub for ${t.path} is ${t.body.length} chars`);
  }
  assert.ok(out.approx_chars < 1000, `approx_chars ${out.approx_chars} counts task bodies`);
});

test("every open handoff comes back, newest first, whole while the packet fits and a stub after", async () => {
  // 2026-11-28: start_session returned the 3 newest episodics, so a fourth area's handoff was
  // invisible to the next thread. Five open handoffs, one closed, one archived, one plain note.
  const docs = [
    ...floor(5000),
    ...[0, 1, 2, 3, 4].map((i) => handoff(i, 3000)),
    handoff(5, 10, { status: "closed" }),
    { ...handoff(6, 10), path: "archive/handoff/old.md" },
    { ...handoff(7, 10), path: "session-7.md" },
  ];
  const { out } = await brief({ documents: docs });
  assert.deepEqual(
    out.open_handoffs.map((h: { path: string }) => h.path),
    [4, 3, 2, 1, 0].map((i) => `handoff/area-${i}.md`),
  );
  assert.equal(out.trimmed, undefined);
  assert.equal(out.open_handoffs[4].body.length, 3000);

  const big = await brief({
    documents: [...floor(5000), handoff(0, 2000), handoff(1, BRIEF_BUDGET), handoff(2, 2000)],
  });
  assert.deepEqual(big.out.trimmed, ["1 handoff bodies"]);
  const [newest, middle, oldest] = big.out.open_handoffs;
  assert.equal(newest.body.length, 2000);
  assert.match(middle.body, /not in the packet/);
  assert.equal(oldest.body.length, 2000, "a smaller handoff after the cut still fits whole");
  assert.ok(big.out.approx_chars <= BRIEF_BUDGET);
});

test("each handoff carries its checklist counts, stub or whole", async () => {
  const body = "Partial.\n\n- [x] fixed the dispatch\n- [ ] verify live\n* [X] tests\n";
  const { out } = await brief({
    documents: [...floor(10), handoff(0, 0, { body }), handoff(1, 0, { body: "no list" })],
  });
  const byPath = new Map(out.open_handoffs.map((h: { path: string }) => [h.path, h]));
  assert.deepEqual((byPath.get("handoff/area-0.md") as { checklist: unknown }).checklist, {
    done: 2,
    open: 1,
    open_items: ["verify live"],
  });
  assert.equal((byPath.get("handoff/area-1.md") as { checklist: unknown }).checklist, null);
});

test("provenance costs ONE audit_log query however many documents the brief carries", async () => {
  const tasks = Array.from({ length: 6 }, (_, i) => task(i, 10));
  const { out, reads } = await brief({
    documents: [...floor(10), ...tasks, handoff(0, 10), handoff(1, 10)],
    auditLog: [
      { namespace: "capsid", path: "core.md", actor: "github:someone" },
      { namespace: "capsid", path: "core.md", actor: "agent:capsid-driver" },
      { namespace: "capsid", path: "TASK-2.md", actor: "agent:seat" },
      { namespace: "capsid", path: "handoff/area-1.md", actor: "agent:other" },
    ],
    links: [
      {
        from_ns: "capsid",
        from_path: "core.md",
        type: "references",
        to_ns: "capsid",
        to_path: "decisions.md",
      },
    ],
  });
  // The edge reads run in the same Promise.all as the section reads, so a slip there
  // drops core_links silently.
  assert.equal(out.core_links?.outgoing.length, 1, "the outgoing-edge read came back empty");
  assert.equal(auditReads(reads), 1, `brief issued ${auditReads(reads)} audit_log queries`);
  assert.ok(
    reads.length <= 8,
    `brief issued ${reads.length} queries, more than 2 documents, the portfolio list, 4 section reads and 1 provenance`,
  );
  // And the answer is still right per document: the newest actor wins, and a
  // document with no audit row reads null rather than borrowing a neighbor's.
  assert.equal(out.core.last_actor, "agent:capsid-driver");
  assert.equal(out.conventions.last_actor, null);
  const byPath = new Map(
    out.open_tasks.map((t: { path: string; last_actor: string | null }) => [t.path, t.last_actor]),
  );
  assert.equal(byPath.get("TASK-2.md"), "agent:seat");
  assert.equal(byPath.get("TASK-0.md"), null);
  const ep = new Map(
    out.open_handoffs.map((t: { path: string; last_actor: string | null }) => [
      t.path,
      t.last_actor,
    ]),
  );
  assert.equal(ep.get("handoff/area-1.md"), "agent:other");
});

test("a namespace with no core.md still resolves provenance for what it has", async () => {
  const { out, reads } = await brief({
    documents: [{ namespace: "capsid", path: "conventions.md", body: "c" }],
    auditLog: [{ namespace: "capsid", path: "conventions.md", actor: "agent:seat" }],
  });
  assert.equal(out.core, null);
  assert.equal(out.conventions.last_actor, "agent:seat");
  assert.equal(auditReads(reads), 1);
});
