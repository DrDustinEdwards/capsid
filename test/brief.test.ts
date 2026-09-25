import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { BRIEF_BUDGET } from "../src/limits.ts";
import { type DocRow, fakeD1, fakeEnv, type FakeD1Options } from "./fakes.ts";

// BRIEF REPORTED A TRIM IT DID NOT MAKE (AUDIT-2026-09-16.md).
//
// The trim pushed "N episodic bodies" and "N task bodies" whenever the running total
// was still over budget, with N = 0 included, and it trimmed task bodies even when
// the three documents it never trims were over budget on their own, so the trim
// could not bring the packet under the budget. On 2026-09-17 the live capsid brief returned
// ["0 episodic bodies", "18 task bodies"] over a floor of 48,361 characters against
// a 40,000 budget: one claim was false and the other removed 1,065 characters for
// nothing.

async function brief(opts: FakeD1Options) {
  const fake = fakeD1(opts);
  const server = buildServer(fakeEnv({ DB: fake.db }), "write", "test:brief");
  const client = new Client({ name: "brief-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = (await client.callTool({ name: "brief", arguments: { namespace: "capsid" } })) as {
    content: Array<{ text: string }>;
  };
  await client.close();
  return { out: JSON.parse(result.content[0].text), reads: fake.reads };
}

const text = (n: number) => "x".repeat(n);
const floor = (each: number): DocRow[] => [
  { namespace: "capsid", path: "conventions.md", body: text(each) },
  { namespace: "capsid", path: "repo-structure.md", body: text(each) },
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
const episodic = (i: number, size: number): DocRow => ({
  namespace: "capsid",
  path: `session-${i}.md`,
  type: "episodic",
  body: text(size),
  created_at: `2026-08-0${i + 1} 00:00:00`,
});

const auditReads = (reads: Array<{ sql: string }>) => reads.filter((r) => /FROM audit_log/i.test(r.sql)).length;

test("a floor over budget with no tasks reports the floor, not a trim of nothing", async () => {
  const each = Math.ceil(BRIEF_BUDGET / 3) + 1000;
  const { out } = await brief({ documents: floor(each) });
  assert.equal(out.trimmed, undefined, `brief reported a trim it did not make: ${JSON.stringify(out.trimmed)}`);
  assert.deepEqual(out.floor_exceeds_budget, {
    conventions: each,
    repo_structure: each,
    core: each,
    floor: each * 3,
    budget: BRIEF_BUDGET,
  });
});

test("a floor over budget leaves task bodies whole, because cutting them cannot fit the packet", async () => {
  const each = Math.ceil(BRIEF_BUDGET / 3) + 1000;
  const { out } = await brief({ documents: [...floor(each), task(0, 500), task(1, 500)] });
  assert.equal(out.trimmed, undefined);
  assert.ok(out.floor_exceeds_budget);
  assert.deepEqual(out.open_tasks.map((t: { body: string }) => t.body.length), [500, 500]);
});

test("a trim names only sections that had bodies to cut", async () => {
  // Floor under budget, tasks push it over, no episodics at all.
  const { out } = await brief({ documents: [...floor(5000), task(0, BRIEF_BUDGET)] });
  assert.deepEqual(out.trimmed, ["1 task bodies"]);
  assert.equal(out.floor_exceeds_budget, undefined);
  assert.match(out.open_tasks[0].body, /trimmed for size/);
  assert.ok(out.approx_chars <= BRIEF_BUDGET, `approx_chars ${out.approx_chars} is over the budget after trimming`);
});

test("episodics are cut first, and tasks stay whole when that is enough", async () => {
  const { out } = await brief({ documents: [...floor(5000), task(0, 100), episodic(0, BRIEF_BUDGET)] });
  assert.deepEqual(out.trimmed, ["1 episodic bodies"]);
  assert.equal(out.open_tasks[0].body.length, 100);
});

test("a packet under budget carries neither field", async () => {
  const { out } = await brief({ documents: [...floor(100), task(0, 100), episodic(0, 100)] });
  assert.equal(out.trimmed, undefined);
  assert.equal(out.floor_exceeds_budget, undefined);
});

test("provenance costs ONE audit_log query however many documents the brief carries", async () => {
  // Was one per document: 3 + open tasks + episodics. On the live capsid brief of
  // 2026-09-17 (18 open tasks, 0 episodics) that was 21 of its 28 queries.
  const tasks = Array.from({ length: 6 }, (_, i) => task(i, 10));
  const { out, reads } = await brief({
    documents: [...floor(10), ...tasks, episodic(0, 10), episodic(1, 10)],
    auditLog: [
      { namespace: "capsid", path: "core.md", actor: "github:someone" },
      { namespace: "capsid", path: "core.md", actor: "agent:capsid-driver" },
      { namespace: "capsid", path: "TASK-2.md", actor: "agent:seat" },
      { namespace: "capsid", path: "session-1.md", actor: "agent:other" },
    ],
    links: [{ from_ns: "capsid", from_path: "core.md", type: "references", to_ns: "capsid", to_path: "decisions.md" }],
  });
  // The edge reads run in the same Promise.all as the section reads, so a slip there
  // drops core_links silently. Moved here from test/bounded-reads.test.ts.
  assert.equal(out.core_links?.outgoing.length, 1, "the outgoing-edge read came back empty");
  assert.equal(auditReads(reads), 1, `brief issued ${auditReads(reads)} audit_log queries`);
  assert.ok(reads.length <= 8, `brief issued ${reads.length} queries, more than 3 documents, 4 section reads and 1 provenance`);
  // And the answer is still right per document: the newest actor wins, and a
  // document with no audit row reads null rather than borrowing a neighbour's.
  assert.equal(out.core.last_actor, "agent:capsid-driver");
  assert.equal(out.conventions.last_actor, null);
  const byPath = new Map(out.open_tasks.map((t: { path: string; last_actor: string | null }) => [t.path, t.last_actor]));
  assert.equal(byPath.get("TASK-2.md"), "agent:seat");
  assert.equal(byPath.get("TASK-0.md"), null);
  const ep = new Map(out.recent_episodics.map((t: { path: string; last_actor: string | null }) => [t.path, t.last_actor]));
  assert.equal(ep.get("session-1.md"), "agent:other");
});

test("a namespace with no core.md still resolves provenance for what it has", async () => {
  const { out, reads } = await brief({
    documents: [
      { namespace: "capsid", path: "conventions.md", body: "c" },
      { namespace: "capsid", path: "repo-structure.md", body: "r" },
    ],
    auditLog: [{ namespace: "capsid", path: "conventions.md", actor: "agent:seat" }],
  });
  assert.equal(out.core, null);
  assert.equal(out.conventions.last_actor, "agent:seat");
  assert.equal(auditReads(reads), 1);
});
