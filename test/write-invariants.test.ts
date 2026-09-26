import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer, type ToolGrant } from "../src/server.ts";
import { fakeD1, fakeEnv, type FakeD1Rows, type Recorded } from "./fakes.ts";

// The behavioural half of the write-path invariants. test/invariants.test.ts reads the
// source; this file drives the real tool handlers over a real MCP connection and records
// the SQL they issue. A source guard cannot tell whether a statement is reached; a
// behavioural test cannot tell whether a new tool skipped the invariant entirely.
//
// The store is the shared row-backed fake from ./fakes.ts: WHERE clauses resolve against
// the bound values, so a lookup for a missing row finds nothing. It proves which
// statements a handler emits, not that the SQL is correct.

interface FakeOptions {
  namespaceExists?: boolean;
  body?: string;
  updatedAt?: string;
  // The document does not exist, so the handler takes its create path.
  exists?: boolean;
  // A concurrent writer. Runs once, immediately after the handler's pre-read of the
  // document row and before its commit-time read and its batch: the window the write
  // predicate closes.
  raceAfterPreRead?: (live: LiveState) => void;
  failBatchMatching?: RegExp;
}

// The race hook's view of the store: a thin projection over the rows the guards
// evaluate against.
interface LiveState {
  body: string | null;
  exists: boolean;
  updatedAt: string;
}

const DOC = { namespace: "capsid", path: "doc.md" };
const VERSION_ID = 42;

function connectOptions(opts: FakeOptions) {
  const { namespaceExists = true, body = "prior body", updatedAt = "2020-01-01 00:00:00", exists = true } = opts;
  const documents = exists
    ? [
        { id: 7, ...DOC, title: "Prior title", body, type: "note", status: "published", tags: "a,b", updated_at: updatedAt },
        // lint finalize only archives episodic and source docs, so the fixture
        // carries one for it to consume.
        { id: 8, namespace: "capsid", path: "ep.md", title: "An episodic", body: "ep body", type: "episodic", status: "published", tags: null, updated_at: updatedAt },
      ]
    : [];
  return {
    documents,
    versions: [
      { id: VERSION_ID, document_id: 7, ...DOC, title: "Old title", body: "old body", snapshot_at: "2026-08-01 00:00:00" },
    ],
    namespaces: namespaceExists ? [{ namespace: "capsid", repos: "[]" }] : [],
    failBatchMatching: opts.failBatchMatching,
    raceAfterPreRead: opts.raceAfterPreRead
      ? (rows: FakeD1Rows, target: { namespace: string; path: string }) => {
          const at = () => rows.documents.find((d) => d.namespace === target.namespace && d.path === target.path);
          const live: LiveState = {
            get body() {
              return at()?.body ?? null;
            },
            set body(value: string | null) {
              const row = at();
              if (row) row.body = value;
              else rows.documents.push({ id: 7, ...target, title: "Racing title", body: value, updated_at: updatedAt });
            },
            get updatedAt() {
              return at()?.updated_at ?? updatedAt;
            },
            set updatedAt(value: string) {
              const row = at();
              if (row) row.updated_at = value;
            },
            get exists() {
              return Boolean(at());
            },
            set exists(value: boolean) {
              if (value && !at()) {
                rows.documents.push({ id: 7, ...target, title: "Racing title", body: null, updated_at: updatedAt });
              } else if (!value) {
                const i = rows.documents.findIndex((d) => d.namespace === target.namespace && d.path === target.path);
                if (i !== -1) rows.documents.splice(i, 1);
              }
            },
          };
          opts.raceAfterPreRead!(live);
        }
      : undefined,
  };
}

async function connect(grant: ToolGrant, opts: FakeOptions = {}) {
  const { rows, recorded, batches, db } = fakeD1(connectOptions(opts));
  const server = buildServer(fakeEnv({ DB: db }), grant, "test:guard");
  const client = new Client({ name: "invariant-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, recorded, rows, batches, close: () => client.close() };
}

const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };

const shaOf = async (s: string) => (await import("node:crypto")).createHash("sha256").update(s).digest("hex");

const sqlFor = (recorded: Recorded[]) => recorded.map((r) => r.sql.replace(/\s+/g, " ")).join("\n");

// The four tools that overwrite, remove or rename a document, and what each must issue.
// Adding a mutating tool without adding it here is the gap the source guard in
// invariants.test.ts covers from the other side.
const MUTATORS: Array<{ tool: string; args: Record<string, unknown>; requires: RegExp[]; refusesUnregisteredWith?: RegExp }> = [
  {
    tool: "write",
    args: { namespace: "capsid", path: "doc.md", title: "New", body: "new body", confirm: true },
    requires: [/INSERT INTO document_versions/, /INSERT INTO audit_log/],
  },
  {
    tool: "delete",
    args: { namespace: "capsid", path: "doc.md", confirm: true },
    requires: [/INSERT INTO document_versions/, /INSERT INTO audit_log/],
  },
  {
    tool: "restore",
    args: { namespace: "capsid", path: "doc.md", version_id: 42, confirm: true },
    requires: [/INSERT INTO document_versions/, /INSERT INTO audit_log/],
  },
  {
    tool: "move",
    args: { namespace: "capsid", path: "doc.md", new_path: "moved.md", confirm: true },
    // A rename has no body to snapshot; the audit row is the record.
    requires: [/INSERT INTO audit_log/],
  },
  {
    // lint finalize is the widest mutation: one call renames every consumed document.
    tool: "lint",
    args: { namespace: "capsid", mode: "finalize", consumed: ["ep.md"], confirm: true },
    // Archiving is a rename, so the audit row is the record, as for move.
    requires: [/INSERT INTO audit_log/],
    // finalize does not call requireRegisteredNamespace: it fails its own per-path
    // existence check, because a document in an unregistered namespace cannot be found.
    refusesUnregisteredWith: /not found/,
  },
];

for (const { tool, args, requires } of MUTATORS) {
  test(`${tool} issues its snapshot and audit statements`, async () => {
    const { client, recorded, close } = await connect("write");
    const result = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    await close();
    assert.ok(!result.isError, `${tool} returned an error: ${result.content?.[0]?.text}`);
    // Vacuity guard: the handler has to have written something at all.
    assert.ok(recorded.length > 0, `${tool} issued no statements`);
    const sql = sqlFor(recorded);
    for (const re of requires) {
      assert.match(sql, re, `${tool} did not issue ${re}. Statements issued:\n${sql}`);
    }
  });

  test(`${tool} lands its mutation and its audit row in ONE batch`, async () => {
    // A separate .run() after the batch is two transactions, so the mutation and its
    // audit record could disagree.
    const { client, recorded, close } = await connect("write");
    await client.callTool({ name: tool, arguments: args });
    await close();
    const direct = recorded.filter((r) => r.via === "direct");
    assert.deepEqual(
      direct.map((r) => r.sql.replace(/\s+/g, " ").slice(0, 60)),
      [],
      `${tool} issued statements outside the batch`
    );
  });
}

test("a read-only key cannot reach any mutating tool, and writes nothing", async () => {
  for (const { tool, args } of MUTATORS) {
    const { client, recorded, close } = await connect("read");
    const result = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    await close();
    assert.equal(result.isError, true, `${tool} did not refuse a read-only key`);
    // The refusal names the missing scope (src/scope.ts).
    assert.match(result.content[0].text, /requires the write grant/);
    // The refusal has to come BEFORE any statement, not after the work is done.
    assert.deepEqual(recorded, [], `${tool} wrote ${recorded.length} statement(s) while refusing a read-only key`);
  }
});

test("write refuses when if_match does not describe the stored body", async () => {
  const { client, recorded, close } = await connect("write");
  const result = (await client.callTool({
    name: "write",
    arguments: { namespace: "capsid", path: "doc.md", title: "New", body: "new body", confirm: true, if_match: "0".repeat(64) },
  })) as { isError?: boolean; content: Array<{ text: string }> };
  await close();
  assert.equal(result.isError, true, "a stale if_match was accepted");
  assert.match(result.content[0].text, /if_match mismatch/);
  // Fail closed: nothing written, and the caller is told the current sha.
  assert.deepEqual(recorded, [], "a refused if_match still wrote statements");
  assert.match(result.content[0].text, /Current sha256 is [0-9a-f]{64}/);
});

test("write accepts the if_match it just handed out", async () => {
  // The round trip: the sha of the stored body is accepted.
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update("prior body").digest("hex");
  const { client, recorded, close } = await connect("write");
  const result = (await client.callTool({
    name: "write",
    arguments: { namespace: "capsid", path: "doc.md", title: "New", body: "new body", confirm: true, if_match: sha },
  })) as { isError?: boolean };
  await close();
  assert.ok(!result.isError, "a correct if_match was refused");
  assert.match(sqlFor(recorded), /INSERT INTO document_versions/);
});

test("write, delete and move all refuse an unregistered namespace, and write nothing", async () => {
  // A typo in `namespace` must not open a shadow namespace: documents the namespaces list
  // cannot see, the lint loop never counts, and brief will never assemble.
  for (const { tool, args, refusesUnregisteredWith } of MUTATORS) {
    const { client, recorded, close } = await connect("write", { namespaceExists: false });
    const result = (await client.callTool({
      name: tool,
      arguments: { ...args, namespace: "typoed-ns" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    await close();
    assert.equal(result.isError, true, `${tool} accepted an unregistered namespace`);
    assert.match(result.content[0].text, refusesUnregisteredWith ?? /unknown namespace/);
    assert.deepEqual(recorded, [], `${tool} wrote statements for an unregistered namespace`);
  }
});

test("mode meta leaves the body byte-identical, wide dash and all", async () => {
  // The body a meta write stores must be the body it read, so mode 'meta' skips
  // normalization. The fixture carries a real U+2014 built from its code point, because
  // the repo's PreToolUse hook refuses the literal character in this file.
  const EM_DASH = String.fromCharCode(0x2014);
  const dashed = `a body with an em ${EM_DASH} dash in it`;
  const { client, recorded, close } = await connect("write", { body: dashed });
  const result = (await client.callTool({
    name: "write",
    arguments: { namespace: "capsid", path: "doc.md", mode: "meta", status: "closed" },
  })) as { isError?: boolean; content: Array<{ text: string }> };
  await close();
  assert.ok(!result.isError, `meta write failed: ${result.content?.[0]?.text}`);
  const upsert = recorded.find((r) => /INSERT INTO documents/i.test(r.sql));
  assert.ok(upsert, "meta write issued no upsert");
  assert.ok(
    (upsert.params as unknown[]).includes(dashed),
    `meta rewrote the body it was told to leave alone: ${JSON.stringify(upsert.params)}`
  );
  // And the prior metadata is in the audit row, because a version snapshot does not
  // carry type, status or tags.
  const audit = recorded.find((r) => /INSERT INTO audit_log/i.test(r.sql));
  assert.match(JSON.stringify(audit?.params), /prior_meta/);
});

// The overwrite warning: an unguarded overwrite of a recently written document warns,
// because a stale read can replace another session's work with a clean response.

const recently = (minutesAgo: number) =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString().slice(0, 19).replace("T", " ");

async function writeAndRead(opts: Record<string, unknown>, args: Record<string, unknown> = {}) {
  const { client, close } = await connect("write", opts);
  const result = (await client.callTool({
    name: "write",
    arguments: { namespace: "capsid", path: "doc.md", title: "New", body: "new body", confirm: true, ...args },
  })) as { isError?: boolean; content: Array<{ text: string }> };
  await close();
  return JSON.parse(result.content[0].text) as { concurrency_warning?: string };
}

test("overwriting a document touched in the last hour WARNS", async () => {
  const out = await writeAndRead({ updatedAt: recently(10) });
  assert.ok(out.concurrency_warning, "no warning on a document written 10 minutes ago");
  assert.match(out.concurrency_warning, /possible concurrent edit/);
  assert.match(out.concurrency_warning, /pass if_match/i);
  // The warning names WHEN, because "recently" is not actionable and a timestamp is.
  assert.match(out.concurrency_warning, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
});

test("overwriting an older document does NOT warn", async () => {
  // Without this the warning could fire on every write and the test above would pass.
  assert.equal((await writeAndRead({ updatedAt: recently(61) })).concurrency_warning, undefined);
  assert.equal((await writeAndRead({ updatedAt: "2020-01-01 00:00:00" })).concurrency_warning, undefined);
});

test("a guarded write never warns, however recent", async () => {
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update("prior body").digest("hex");
  const out = await writeAndRead({ updatedAt: recently(1) }, { if_match: sha });
  assert.equal(out.concurrency_warning, undefined, "if_match already guards this write; warning is noise");
});

test("the warning NEVER refuses the write", async () => {
  const { client, recorded, close } = await connect("write", { updatedAt: recently(5) });
  const result = (await client.callTool({
    name: "write",
    arguments: { namespace: "capsid", path: "doc.md", title: "New", body: "new body", confirm: true },
  })) as { isError?: boolean };
  await close();
  assert.ok(!result.isError, "the warning turned into a refusal");
  assert.match(sqlFor(recorded), /INSERT INTO documents/, "the write did not land");
});

test("a UTC timestamp is not read as local time", async () => {
  // D1 stores datetime('now') in UTC with no zone marker. Parsing it as local time would
  // silence the warning west of UTC and fire it constantly east of it, and the bug would
  // be invisible on a machine sitting on UTC.
  const { concurrentEditWarning } = await import("../src/server.ts");
  const now = Date.parse("2026-08-14T12:00:00Z");
  assert.ok(concurrentEditWarning("2026-08-14 11:30:00", now), "30 minutes ago should warn");
  assert.equal(concurrentEditWarning("2026-08-14 10:00:00", now), null, "2 hours ago should not");
  // A future timestamp is not a concurrent edit, it is a clock problem.
  assert.equal(concurrentEditWarning("2026-08-14 13:00:00", now), null);
  assert.equal(concurrentEditWarning(null, now), null);
});

// The write predicate. Every test below turns on a store that changes between the
// handler's pre-read and its commit.

test("PREDICATE: a body that changes after the pre-read is refused at commit, not accepted", async () => {
  // The pre-check passes (the sha is correct when the handler reads it), so the refusal
  // comes from the in-batch guard.
  const sha = await shaOf("prior body");
  const { client, recorded, close } = await connect("write", {
    body: "prior body",
    raceAfterPreRead: (live) => {
      live.body = "body written by someone else";
    },
  });
  const result = await call(client, "write", {
    namespace: "capsid", path: "doc.md", title: "New", body: "new body", confirm: true, if_match: sha,
  });
  await close();
  assert.equal(result.isError, true, "the racing write was overwritten instead of refused");
  assert.match(result.content[0].text, /stored body changed after this write read it/);
  assert.match(result.content[0].text, /Current sha256 is [0-9a-f]{64}/);
  // The sha reported is the racer's body, which is what the caller must rebase onto.
  assert.match(result.content[0].text, new RegExp(await shaOf("body written by someone else")));
  // Fail closed: the aborted batch left nothing behind.
  assert.deepEqual(recorded, [], "a refused predicate still committed statements");
});

test("PREDICATE: an overwrite with no confirm is refused before any commit", async () => {
  // The pre-elicitation arm. The in-memory client advertises no elicitation capability,
  // so the handler refuses rather than waiting.
  const { client, recorded, close } = await connect("write", { body: "prior body" });
  const result = await call(client, "write", {
    namespace: "capsid", path: "doc.md", title: "New", body: "new body",
  });
  await close();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /confirmation required/);
  assert.deepEqual(recorded, [], "the confirmation path wrote before it was confirmed");
});

test("PREDICATE: an unguarded update still lands, so the guard is not a blanket refusal", async () => {
  // Without this, a predicate that refused everything would pass every test above.
  const { client, recorded, close } = await connect("write", { body: "prior body" });
  const result = await call(client, "write", {
    namespace: "capsid", path: "doc.md", title: "New", body: "new body", confirm: true,
  });
  await close();
  assert.ok(!result.isError, `an ordinary write was refused: ${result.content?.[0]?.text}`);
  assert.match(sqlFor(recorded), /INSERT INTO documents/);
});

test("CREATE COLLISION: exactly one of two racing creates wins, and the loser is refused", async () => {
  // Both writers pre-read nothing, so both take the create path. The first commits. The
  // second must NOT fall into ON CONFLICT DO UPDATE, because its statement list carries
  // no snapshot, so the winner's body would be gone with no version row anywhere.
  const { client, recorded, close } = await connect("write", {
    exists: false,
    raceAfterPreRead: (live) => {
      live.exists = true;
      live.body = "the winner body";
    },
  });
  const result = await call(client, "write", {
    namespace: "capsid", path: "new-doc.md", title: "Loser", body: "the loser body",
  });
  await close();
  assert.equal(result.isError, true, "the second create silently overwrote the first");
  assert.match(result.content[0].text, /create collision/);
  assert.match(result.content[0].text, /another writer created it first/);
  assert.deepEqual(recorded, [], "the losing create still wrote statements");
});

// Which guard write and restore arm, shown by staging the race each guard exists for
// and asserting the outcome, for both tools:
//
//   create: a racing create wins and the handler is refused. write: "CREATE COLLISION:
//     exactly one of two racing creates wins" above; restore: "restore recreating a
//     deleted document refuses a racing create" below.
//   update with if_match: a racing body change is refused. write: "PREDICATE: a body
//     that changes after the pre-read is refused at commit" above; restore: "restore
//     refuses at the PREDICATE when the live body changes after its pre-read" below.
//   plain update: last writer wins, deliberately. The test below.
test("RACE: a confirmed write and restore with no if_match both land over a body changed after the pre-read", async () => {
  const race = (live: LiveState) => {
    live.body = "body written by someone else";
  };
  const w = await connect("write", { body: "prior body", raceAfterPreRead: race });
  const wRes = await call(w.client, "write", { namespace: "capsid", path: "doc.md", title: "T", body: "b", confirm: true });
  await w.close();
  assert.ok(!wRes.isError, `a plain write was refused by a guard it did not ask for: ${wRes.content?.[0]?.text}`);
  assert.match(sqlFor(w.recorded), /INSERT INTO documents/);

  const r = await connect("write", { body: "prior body", raceAfterPreRead: race });
  const rRes = await call(r.client, "restore", { namespace: "capsid", path: "doc.md", version_id: VERSION_ID, confirm: true });
  await r.close();
  assert.ok(!rRes.isError, `a plain restore was refused by a guard it did not ask for: ${rRes.content?.[0]?.text}`);
  assert.match(sqlFor(r.recorded), /INSERT INTO documents/);
});

test("CREATE COLLISION: an uncontested create still succeeds", async () => {
  const { client, recorded, close } = await connect("write", { exists: false });
  const result = await call(client, "write", {
    namespace: "capsid", path: "new-doc.md", title: "T", body: "b",
  });
  await close();
  assert.ok(!result.isError, `an uncontested create was refused: ${result.content?.[0]?.text}`);
  const out = JSON.parse(result.content[0].text) as { action: string; snapshotted: boolean };
  assert.equal(out.action, "created");
  assert.equal(out.snapshotted, false);
  assert.match(sqlFor(recorded), /INSERT INTO documents/);
});

// What restore binds, not just which statements it issues. A restore that wrote the live
// body back over itself would issue the same statements; only the value bound to the
// upsert distinguishes them. The version row carries "old body" and the live document
// carries "prior body".
test("restore writes the VERSION body, and snapshots the LIVE one", async () => {
  const { client, recorded, close } = await connect("write");
  const result = (await client.callTool({
    name: "restore",
    arguments: { namespace: "capsid", path: "doc.md", version_id: 42, confirm: true },
  })) as { isError?: boolean; content: Array<{ text: string }> };
  await close();
  assert.ok(!result.isError, `restore failed: ${result.content?.[0]?.text}`);

  const upsert = recorded.find((r) => /INSERT INTO documents [(]/i.test(r.sql));
  assert.ok(upsert, "restore issued no upsert into documents");
  assert.ok(
    upsert.params.includes("old body"),
    `restore did not write the version body. It bound: ${JSON.stringify(upsert.params)}`
  );
  assert.equal(
    upsert.params.includes("prior body"),
    false,
    `restore wrote the LIVE body back instead of the version body. It bound: ${JSON.stringify(upsert.params)}`
  );
  // The title travels with the body.
  assert.ok(upsert.params.includes("Old title"), `restore did not write the version title: ${JSON.stringify(upsert.params)}`);

  // The snapshot must capture the live row being replaced, or the restore is not itself
  // undoable. The fake does not evaluate INSERT ... SELECT, so that is proven against real
  // SQLite in test-integration/live-snapshot.test.ts.
});

// history. Namespace and path are part of the lookup, so an id alone cannot walk every
// snapshot in the store.

test("history lists the versions of the document asked for", async () => {
  const { client, close } = await connect("write");
  const result = await call(client, "history", { namespace: "capsid", path: "doc.md" });
  await close();
  assert.ok(!result.isError, `history failed: ${result.content?.[0]?.text}`);
  const out = JSON.parse(result.content[0].text) as { versions: Array<{ id: number }>; live: unknown };
  assert.deepEqual(out.versions.map((v) => v.id), [42], "history did not return the document's own snapshot");
  assert.ok(out.live, "history did not report the live document");
});

test("history returns nothing for a path with no snapshots", async () => {
  const { client, close } = await connect("write");
  const result = await call(client, "history", { namespace: "capsid", path: "ep.md" });
  await close();
  const out = JSON.parse(result.content[0].text) as { versions: unknown[] };
  assert.deepEqual(out.versions, [], "a document's history leaked another document's snapshots");
});

test("fetching a version by id is scoped to its own document", async () => {
  // The same id, asked for under a path it does not belong to.
  const { client, close } = await connect("write");
  const wrongPath = await call(client, "history", { namespace: "capsid", path: "ep.md", version_id: 42 });
  await close();
  assert.equal(wrongPath.isError, true, "a snapshot was readable through a document it does not belong to");
  assert.match(wrongPath.content[0].text, /no version 42/);
});

test("fetching a version by id returns that version's body", async () => {
  const { client, close } = await connect("write");
  const result = await call(client, "history", { namespace: "capsid", path: "doc.md", version_id: 42 });
  await close();
  assert.ok(!result.isError, `history by id failed: ${result.content?.[0]?.text}`);
  const out = JSON.parse(result.content[0].text) as { id: number; body: string; bytes: number };
  assert.equal(out.id, 42);
  assert.equal(out.body, "old body");
  assert.equal(out.bytes, "old body".length);
});

// Lookups that must miss: the fake resolves WHERE clauses against the bound values, so a
// wrong id, path or namespace finds nothing.

test("a version id that does not exist is refused, not silently substituted", async () => {
  const { client, recorded, close } = await connect("write");
  const result = await call(client, "restore", {
    namespace: "capsid", path: "doc.md", version_id: 99, confirm: true,
  });
  await close();
  assert.equal(result.isError, true, "restore accepted a version id that does not exist");
  assert.match(result.content[0].text, /no version 99/);
  assert.deepEqual(recorded, [], "a restore of a missing version still wrote statements");
});

test("a version belonging to another document is not reachable by id", async () => {
  // namespace and path are part of the version lookup on purpose: an id alone would let a
  // caller walk every snapshot in the store by incrementing a number.
  const { client, close } = await connect("write");
  const result = await call(client, "restore", {
    namespace: "capsid", path: "some-other-doc.md", version_id: 42, confirm: true,
  });
  await close();
  assert.equal(result.isError, true, "a snapshot was reachable from a document it does not belong to");
  assert.match(result.content[0].text, /no version 42/);
});

test("a document that does not exist is not found at a path that does", async () => {
  // delete reads the row before it does anything, and a missing row stops it.
  const { client, recorded, close } = await connect("write");
  const result = await call(client, "delete", {
    namespace: "capsid", path: "never-existed.md", confirm: true,
  });
  await close();
  assert.equal(result.isError, true, "delete accepted a path with no document");
  assert.match(result.content[0].text, /not found/);
  assert.deepEqual(recorded, [], "a delete of a missing document still wrote statements");
});

test("restore accepts if_match and refuses a stale one", async () => {
  const stale = await connect("write", { body: "prior body" });
  const staleRes = await call(stale.client, "restore", {
    namespace: "capsid", path: "doc.md", version_id: 42, confirm: true, if_match: "0".repeat(64),
  });
  await stale.close();
  assert.equal(staleRes.isError, true, "restore accepted a stale if_match");
  assert.match(staleRes.content[0].text, /if_match mismatch/);
  assert.match(staleRes.content[0].text, /Current sha256 is [0-9a-f]{64}/);
  assert.deepEqual(stale.recorded, [], "a refused restore still wrote statements");

  const good = await connect("write", { body: "prior body" });
  const okRes = await call(good.client, "restore", {
    namespace: "capsid", path: "doc.md", version_id: 42, confirm: true, if_match: await shaOf("prior body"),
  });
  await good.close();
  assert.ok(!okRes.isError, `restore refused a correct if_match: ${okRes.content?.[0]?.text}`);
  assert.match(sqlFor(good.recorded), /INSERT INTO document_versions \(document_id, namespace, path, title, body\)/);
});

test("restore refuses at the PREDICATE when the live body changes after its pre-read", async () => {
  const { client, recorded, close } = await connect("write", {
    body: "prior body",
    raceAfterPreRead: (live) => {
      live.body = "changed under the restore";
    },
  });
  const result = await call(client, "restore", {
    namespace: "capsid", path: "doc.md", version_id: 42, confirm: true, if_match: await shaOf("prior body"),
  });
  await close();
  assert.equal(result.isError, true, "restore committed over a body that changed beneath it");
  assert.match(result.content[0].text, /live body changed after this restore read it/);
  assert.deepEqual(recorded, [], "a refused restore still committed statements");
});

test("restore recreating a deleted document refuses a racing create", async () => {
  const { client, recorded, close } = await connect("write", {
    exists: false,
    raceAfterPreRead: (live) => {
      live.exists = true;
      live.body = "recreated by someone else";
    },
  });
  const result = await call(client, "restore", {
    namespace: "capsid", path: "doc.md", version_id: 42, confirm: true,
  });
  await close();
  assert.equal(result.isError, true, "restore overwrote a document created during its flight");
  assert.match(result.content[0].text, /create collision/);
  assert.deepEqual(recorded, [], "the losing restore still wrote statements");
});

test("the concurrency warning is read at COMMIT time, not from the pre-read", async () => {
  // The pre-read sees an old timestamp, so a warning computed from it could not fire. A
  // writer then lands during the handler's flight and the commit-time read sees it.
  const fresh = new Date(Date.now() - 5 * 60_000).toISOString().slice(0, 19).replace("T", " ");
  const { client, close } = await connect("write", {
    updatedAt: "2020-01-01 00:00:00",
    raceAfterPreRead: (live) => {
      live.updatedAt = fresh;
    },
  });
  const result = await call(client, "write", {
    namespace: "capsid", path: "doc.md", title: "New", body: "new body", confirm: true,
  });
  await close();
  const out = JSON.parse(result.content[0].text) as { concurrency_warning?: string };
  assert.ok(out.concurrency_warning, "the warning was computed from the stale pre-read, not from a fresh read at commit");
  assert.match(out.concurrency_warning, /possible concurrent edit/);
  assert.match(out.concurrency_warning, new RegExp(fresh));
});

// The elicited arm. A client without the elicitation capability is refused before a
// guard is chosen, so this client declares it and answers the request. "if_match
// mismatch" means the sha sent is not what is stored; "stale confirmation" means a human
// approved an overwrite of a body that changed while the prompt was open.
async function connectEliciting(opts: FakeOptions = {}, answer: "accept" | "decline" = "accept") {
  const { recorded, reads, rows, batches, db } = fakeD1(connectOptions(opts));
  const server = buildServer(fakeEnv({ DB: db }), "write", "test:guard");
  const client = new Client({ name: "eliciting-test", version: "1.0.0" }, { capabilities: { elicitation: {} } });
  // Counted, because a test that silently fell back to the unsupported path would assert
  // nothing: it would be refused with "confirmation required" and never reach the guard.
  const prompts: string[] = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    prompts.push(String(request.params.message));
    return answer === "accept" ? { action: "accept", content: { confirm: true } } : { action: "decline" };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, recorded, reads, rows, batches, prompts, close: () => client.close() };
}

test("an accepted elicitation reaches the commit, so the arm is really reachable", async () => {
  // The harness check: if this path reverted to "unsupported" the wording tests below
  // would pass by refusing early for a different reason.
  const { client, recorded, prompts, close } = await connectEliciting({ body: "prior body" });
  const result = await call(client, "write", {
    namespace: "capsid", path: "doc.md", title: "New", body: "new body",
  });
  await close();
  assert.equal(prompts.length, 1, "no elicitation was requested, so this client is not exercising the elicited arm");
  assert.match(prompts[0], /Overwrite capsid\/doc\.md\?/);
  assert.ok(!result.isError, `an approved overwrite was refused: ${result.content?.[0]?.text}`);
  assert.match(sqlFor(recorded), /INSERT INTO documents/);
});

test("RACE: after an elicitation, write, restore and delete each refuse a body changed while the prompt was open", async () => {
  // Consent given through elicitation is bound to the body it was about, in all three
  // tools. No call passes confirm or if_match, so the elicited signal is the only thing
  // that can arm the body guard.
  const calls: Array<[string, Record<string, unknown>]> = [
    ["write", { namespace: "capsid", path: "doc.md", title: "T", body: "b" }],
    ["restore", { namespace: "capsid", path: "doc.md", version_id: VERSION_ID }],
    ["delete", { namespace: "capsid", path: "doc.md" }],
  ];
  for (const [tool, args] of calls) {
    const { client, recorded, prompts, close } = await connectEliciting({
      body: "prior body",
      raceAfterPreRead: (live) => {
        live.body = "body written while the prompt was up";
      },
    });
    const result = await call(client, tool, args);
    await close();
    assert.equal(prompts.length, 1, `${tool} did not elicit, so the elicited arm was not exercised`);
    assert.equal(result.isError, true, `${tool} landed on a body that changed under an open prompt`);
    assert.deepEqual(recorded, [], `${tool} committed statements after its guard should have fired`);
  }
  // The delete refusal says why, since a delete has no if_match to blame.
  const { client, close } = await connectEliciting({
    body: "prior body",
    raceAfterPreRead: (live) => {
      live.body = "body written while the prompt was up";
    },
  });
  const refused = await call(client, "delete", { namespace: "capsid", path: "doc.md" });
  await close();
  assert.match(refused.content[0].text, /changed or was removed while the confirmation was open/);
});

test("RACE: after an elicitation with no race, write, restore and delete each land", async () => {
  // The innocent direction: a body guard that fired on every call would pass the test above.
  const calls: Array<[string, Record<string, unknown>]> = [
    ["write", { namespace: "capsid", path: "doc.md", title: "T", body: "b" }],
    ["restore", { namespace: "capsid", path: "doc.md", version_id: VERSION_ID }],
    ["delete", { namespace: "capsid", path: "doc.md" }],
  ];
  for (const [tool, args] of calls) {
    const { client, recorded, prompts, close } = await connectEliciting({ body: "prior body" });
    const result = await call(client, tool, args);
    await close();
    assert.equal(prompts.length, 1, `${tool} did not elicit`);
    assert.ok(!result.isError, `${tool} was refused: ${result.content?.[0]?.text}`);
    assert.ok(recorded.length > 0, `${tool} committed nothing`);
  }
});

test("RACE: a confirm: true delete lands over a changed body, and is refused when the row is gone", async () => {
  // confirm: true approves deleting the path, not a particular body, so the guard is
  // existence only. A body change in flight does not stop it; a removal does, or the
  // delete would snapshot and audit a row it never removed.
  const changed = await connect("write", {
    body: "prior body",
    raceAfterPreRead: (live) => {
      live.body = "body written by someone else";
    },
  });
  const landed = await call(changed.client, "delete", { namespace: "capsid", path: "doc.md", confirm: true });
  await changed.close();
  assert.ok(!landed.isError, `a confirmed delete was refused over a body change: ${landed.content?.[0]?.text}`);
  assert.match(sqlFor(changed.recorded), /DELETE FROM documents/);

  const removed = await connect("write", {
    body: "prior body",
    raceAfterPreRead: (live) => {
      live.exists = false;
    },
  });
  const refused = await call(removed.client, "delete", { namespace: "capsid", path: "doc.md", confirm: true });
  await removed.close();
  assert.equal(refused.isError, true, "a delete of a row removed in flight reported success");
  assert.match(refused.content[0].text, /no longer exists/);
  assert.deepEqual(removed.recorded, [], "the refused delete still committed statements");
});

test("a declined elicitation refuses, and writes nothing", async () => {
  const { client, recorded, prompts, close } = await connectEliciting({ body: "prior body" }, "decline");
  const result = await call(client, "write", {
    namespace: "capsid", path: "doc.md", title: "New", body: "new body",
  });
  await close();
  assert.equal(prompts.length, 1);
  assert.equal(result.isError, true, "a declined overwrite was written anyway");
  assert.match(result.content[0].text, /overwrite of capsid\/doc\.md declined/);
  assert.deepEqual(recorded, [], "a declined overwrite still issued statements");
});

test("STALE CONFIRMATION is named as itself, not as an if_match mismatch", async () => {
  // No if_match was sent, so "if_match mismatch" would point the caller at an argument
  // they did not use.
  const { client, recorded, prompts, close } = await connectEliciting({
    body: "prior body",
    raceAfterPreRead: (live) => {
      live.body = "body written while the prompt was up";
    },
  });
  const result = await call(client, "write", {
    namespace: "capsid", path: "doc.md", title: "New", body: "new body",
  });
  await close();
  assert.equal(prompts.length, 1, "the elicited arm was not exercised");
  assert.equal(result.isError, true, "a write landed on a body that changed under an open prompt");
  const text = result.content[0].text;
  assert.match(text, /^stale confirmation on capsid\/doc\.md:/, `wrong refusal: ${text}`);
  assert.doesNotMatch(text, /if_match mismatch/, "a stale confirmation was reported as an if_match mismatch");
  // The clause that says WHY it went stale, which only this arm can produce.
  assert.match(text, /and while the overwrite confirmation was pending/);
  assert.match(text, new RegExp(await shaOf("body written while the prompt was up")));
  assert.deepEqual(recorded, [], "a refused stale confirmation still committed statements");
});

test("IF_MATCH MISMATCH keeps its own wording, and no pending clause", async () => {
  // This caller did send a sha, so the refusal names it, and the confirmation clause
  // must not appear: there was no prompt.
  const sha = await shaOf("prior body");
  const { client, close } = await connectEliciting({
    body: "prior body",
    raceAfterPreRead: (live) => {
      live.body = "body written by someone else";
    },
  });
  const result = await call(client, "write", {
    namespace: "capsid", path: "doc.md", title: "New", body: "new body", confirm: true, if_match: sha,
  });
  await close();
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /^if_match mismatch on capsid\/doc\.md:/, `wrong refusal: ${text}`);
  assert.doesNotMatch(text, /stale confirmation/);
  assert.doesNotMatch(text, /overwrite confirmation was pending/, "a caller who sent if_match was told about a prompt that never happened");
});

test("the two refusals are DIFFERENT strings for the same underlying conflict", async () => {
  // Same race, same guard, same commit-time abort; only the route in differs. If these
  // converge, one of the two callers is told something untrue.
  const race = (live: LiveState) => {
    live.body = "the racer";
  };
  const stale = await connectEliciting({ body: "prior body", raceAfterPreRead: race });
  const staleText = (await call(stale.client, "write", { namespace: "capsid", path: "doc.md", title: "T", body: "b" })).content[0].text;
  await stale.close();

  const mismatch = await connectEliciting({ body: "prior body", raceAfterPreRead: race });
  const mismatchText = (
    await call(mismatch.client, "write", {
      namespace: "capsid", path: "doc.md", title: "T", body: "b", confirm: true, if_match: await shaOf("prior body"),
    })
  ).content[0].text;
  await mismatch.close();

  assert.notEqual(staleText, mismatchText, "the two refusals have collapsed into one message");
  assert.ok(staleText.startsWith("stale confirmation"), staleText);
  assert.ok(mismatchText.startsWith("if_match mismatch"), mismatchText);
});

// A batch failure is a clean refusal, not an exception.

// The fake's batch throws on a matching statement, producing a D1 failure that is not
// one of the commit-time guards. Every mutator must answer it with a normal error result.
async function connectExploding(sql: RegExp) {
  const { db, recorded } = fakeD1(connectOptions({ failBatchMatching: sql }));
  const server = buildServer(fakeEnv({ DB: db }), "write", "test:guard");
  const client = new Client({ name: "f30-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, recorded, close: () => client.close() };
}

const F30_CASES = [
  { tool: "write", args: { namespace: "capsid", path: "doc.md", title: "T", body: "b", confirm: true } },
  { tool: "restore", args: { namespace: "capsid", path: "doc.md", version_id: 42, confirm: true } },
  { tool: "delete", args: { namespace: "capsid", path: "doc.md", confirm: true } },
  { tool: "move", args: { namespace: "capsid", path: "doc.md", new_path: "moved.md", confirm: true } },
  { tool: "lint", args: { namespace: "capsid", mode: "finalize", consumed: ["ep.md"], confirm: true } },
];

for (const { tool, args } of F30_CASES) {
  test(`${tool} returns a clean failure when the batch throws`, async () => {
    const { client, close } = await connectExploding(/INSERT INTO document_versions|UPDATE documents|INSERT INTO documents|DELETE FROM documents/);
    let result: { isError?: boolean; content: Array<{ text: string }> };
    try {
      result = (await client.callTool({ name: tool, arguments: args })) as typeof result;
    } catch (err) {
      await close();
      assert.fail(`${tool} threw out of the handler instead of returning a failure: ${err instanceof Error ? err.message : String(err)}`);
    }
    await close();
    assert.equal(result.isError, true, `${tool} reported success on a failed batch`);
    const text = result.content?.[0]?.text ?? "";
    assert.match(text, /database is locked/, `${tool} lost the reason: ${text}`);
    assert.match(text, /nothing (was written|changed|archived)/i, `${tool} did not say the store is unchanged: ${text}`);
  });
}

// A landed GitHub write is not reported as a failure.

test("write_repo_file reports success with a warning when the audit insert fails", async () => {
  // guardedWrite commits to GitHub and then writes its audit row, and the two cannot share
  // a transaction. Reporting a failure would invite a retry, which is a second commit.
  const { db } = fakeD1(connectOptions({}));
  (db as { prepare: unknown }).prepare = ((sql: string) => {
    const base = { bind: () => base, first: async () => null, all: async () => ({ results: [], meta: { changes: 0 } }), run: async () => ({ meta: { changes: 1 } }) } as Record<string, unknown>;
    if (/INSERT INTO audit_log/i.test(sql)) {
      base.run = async () => {
        throw new Error("D1_ERROR: no such table: audit_log");
      };
    }
    if (/FROM namespaces/i.test(sql)) base.first = async () => ({ repos: JSON.stringify([{ repo: "o/r", label: "primary" }]) });
    return base;
  }) as never;

  const server = buildServer({ DB: db, APP_KV: { get: async (k: string) => (k.startsWith("gh:token:") ? "t" : null), put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) } } as never, "write", "test:guard");
  const client = new Client({ name: "f17-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname;
    if (path === "/repos/o/r" && method === "GET") return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    if (path === "/repos/o/r/contents/doc.md" && method === "GET") return new Response("{}", { status: 404 });
    if (path === "/repos/o/r/contents/doc.md" && method === "PUT") {
      return new Response(JSON.stringify({ commit: { sha: "landed-sha" }, content: { sha: "file-sha" } }), { status: 201 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const result = (await client.callTool({
      name: "write_repo_file",
      arguments: { namespace: "capsid", path: "doc.md", content: "hi", message: "m", mode: "direct" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.ok(!result.isError, `the landed write was reported as a failure: ${result.content?.[0]?.text}`);
    const payload = JSON.parse(result.content[0].text) as { commitSha?: string; audit_warning?: string };
    // The result still describes what landed, and says the log does not know.
    assert.equal(payload.commitSha, "landed-sha");
    assert.match(payload.audit_warning ?? "", /SUCCEEDED/);
    assert.match(payload.audit_warning ?? "", /no such table: audit_log/);
    assert.match(payload.audit_warning ?? "", /Do not retry/);
  } finally {
    globalThis.fetch = original;
    await client.close();
  }
});

// What guardedWrite files. A fake D1 that answers the namespace lookup and records every
// audit_log insert, and a server over it.
async function connectAuditRecording() {
  const { db } = fakeD1(connectOptions({}));
  const audits: unknown[][] = [];
  (db as { prepare: unknown }).prepare = ((sql: string) => {
    let bound: unknown[] = [];
    const base = {
      bind: (...args: unknown[]) => {
        bound = args;
        return base;
      },
      first: async () => null,
      all: async () => ({ results: [], meta: { changes: 0 } }),
      run: async () => {
        if (/INSERT INTO audit_log/i.test(sql)) audits.push(bound);
        return { meta: { changes: 1 } };
      },
    } as Record<string, unknown>;
    if (/FROM namespaces/i.test(sql)) base.first = async () => ({ repos: JSON.stringify([{ repo: "o/r", label: "primary" }]) });
    return base;
  }) as never;
  const server = buildServer({ DB: db, APP_KV: { get: async (k: string) => (k.startsWith("gh:token:") ? "t" : null), put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) } } as never, "write", "test:guard");
  const client = new Client({ name: "f3-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, audits };
}

test("a pr-mode write whose commit landed but whose PR open failed is audited and reported, not failed", async () => {
  // The commit is on the work branch before openPr runs, so a failed PR open must still
  // be audited and reported as landed, or the caller retries into a second commit.
  const { client, audits } = await connectAuditRecording();
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname;
    if (path === "/repos/o/r" && method === "GET") return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    if (path === "/repos/o/r/git/ref/heads/main") return new Response(JSON.stringify({ object: { sha: "base-sha" } }), { status: 200 });
    if (path === "/repos/o/r/git/refs" && method === "POST") return new Response("{}", { status: 201 });
    if (path === "/repos/o/r/contents/doc.md" && method === "GET") return new Response("{}", { status: 404 });
    if (path === "/repos/o/r/contents/doc.md" && method === "PUT") {
      return new Response(JSON.stringify({ commit: { sha: "landed-sha" }, content: { sha: "file-sha" } }), { status: 201 });
    }
    if (path === "/repos/o/r/pulls" && method === "POST") return new Response("secondary rate limit", { status: 403 });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const result = (await client.callTool({
      name: "write_repo_file",
      arguments: { namespace: "capsid", path: "doc.md", content: "hi", message: "m" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.ok(!result.isError, `the landed commit was reported as a failure: ${result.content?.[0]?.text}`);
    const payload = JSON.parse(result.content[0].text) as { commitSha?: string; pr?: unknown; pr_error?: string; branch?: string };
    assert.equal(payload.commitSha, "landed-sha");
    assert.equal(payload.pr, null);
    assert.match(payload.pr_error ?? "", /THE COMMIT LANDED/);
    assert.match(payload.pr_error ?? "", /secondary rate limit/);
    assert.match(payload.pr_error ?? "", /Do not retry/);
    assert.equal(audits.length, 1, "the landed commit has no audit row");
    assert.equal(audits[0][1], "write_repo_file");
    assert.match(String(audits[0][4]), /landed-sha/);
  } finally {
    globalThis.fetch = original;
    await client.close();
  }
});

for (const { label, args } of [
  { label: "a comment action with no comment", args: { namespace: "capsid", number: 7, action: "comment" } },
  { label: "a comment on a merge", args: { namespace: "capsid", number: 7, action: "merge", comment: "lgtm" } },
]) {
  test(`manage_pr refuses ${label} as an error with no audit row`, async () => {
    // A refusal returned from inside guardedWrite would be filed as a landed result.
    const { client, audits } = await connectAuditRecording();
    const original = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    try {
      const result = (await client.callTool({ name: "manage_pr", arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      assert.equal(result.isError, true, `the refusal read as success: ${result.content?.[0]?.text}`);
      assert.match(result.content[0].text, /comment/);
      assert.equal(audits.length, 0, "a refused call wrote an audit row");
      assert.equal(fetched, 0, "a refused call reached GitHub");
    } finally {
      globalThis.fetch = original;
      await client.close();
    }
  });
}

// Patch uniqueness, through the write tool. test/write-modes.test.ts proves the rule on
// `assembleBody` directly; these prove the handler applies it. A handler that treated
// patch as replace would keep every helper test green. The assertion that matters is
// refused and nothing written.

test("PLANT: a patch whose find occurs ZERO times is refused by the tool and writes nothing", async () => {
  const { client, recorded, close } = await connect("write", { body: "alpha beta gamma" });
  const out = await call(client, "write", {
    ...DOC,
    mode: "patch",
    find: "no such text",
    replace_with: "x",
    confirm: true,
  });
  await close();
  assert.equal(out.isError, true, "a patch with no match was applied");
  assert.match(out.content[0].text, /occurs 0 times|not found|exactly once/i, out.content[0].text);
  assert.equal(
    recorded.filter((r) => /INSERT INTO documents/i.test(r.sql)).length,
    0,
    "a refused patch still wrote the document"
  );
});

test("PLANT: a patch whose find occurs TWICE is refused by the tool and writes nothing", async () => {
  // The ambiguous case, the dangerous one.
  const { client, recorded, close } = await connect("write", { body: "repeat once, repeat twice" });
  const out = await call(client, "write", {
    ...DOC,
    mode: "patch",
    find: "repeat",
    replace_with: "x",
    confirm: true,
  });
  await close();
  assert.equal(out.isError, true, "an ambiguous patch was applied");
  assert.match(out.content[0].text, /occurs 2 times|exactly once/i, out.content[0].text);
  assert.equal(
    recorded.filter((r) => /INSERT INTO documents/i.test(r.sql)).length,
    0,
    "a refused patch still wrote the document"
  );
});

test("THE INNOCENT DIRECTION: a patch matching exactly once lands through the tool", async () => {
  // Without this, the two plants above pass against a handler that refuses every patch.
  const { client, recorded, close } = await connect("write", { body: "alpha beta gamma" });
  const out = await call(client, "write", {
    ...DOC,
    mode: "patch",
    find: "beta",
    replace_with: "DELTA",
    confirm: true,
  });
  await close();
  assert.equal(out.isError ?? false, false, out.content[0].text);
  const insert = recorded.find((r) => /INSERT INTO documents/i.test(r.sql));
  assert.ok(insert, "an accepted patch wrote nothing");
  assert.ok(
    insert.params.some((p) => typeof p === "string" && p === "alpha DELTA gamma"),
    `the stored body was not the patched one: ${JSON.stringify(insert.params)}`
  );
});
