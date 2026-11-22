import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer, concurrentEditWarning, type ToolGrant } from "../src/server.ts";
import { fakeD1, fakeEnv, type FakeD1Rows, type Recorded } from "./fakes.ts";

// The behavioral half of the write-path invariants. test/invariants.test.ts reads the
// source; this file drives the real tool handlers over a real MCP connection and records
// the SQL they issue. The store is the shared row-backed fake from ./fakes.ts: WHERE
// clauses resolve against the bound values. It proves which statements a handler emits,
// not that the SQL is correct.

interface FakeOptions {
  namespaceExists?: boolean;
  body?: string;
  updatedAt?: string;
  // The document does not exist, so the handler takes its create path.
  exists?: boolean;
  // A concurrent writer. Runs once, after the handler's pre-read of the document row and
  // before its commit-time read and its batch: the window the write predicate closes.
  raceAfterPreRead?: (live: LiveState) => void;
}

interface LiveState {
  body: string | null;
  exists: boolean;
  updatedAt: string;
}

const DOC = { namespace: "capsid", path: "doc.md" };
const VERSION_ID = 42;
const RACED = "body written by someone else";

function connectOptions(opts: FakeOptions) {
  const {
    namespaceExists = true,
    body = "prior body",
    updatedAt = "2020-01-01 00:00:00",
    exists = true,
  } = opts;
  const documents = exists
    ? [
        {
          id: 7,
          ...DOC,
          title: "Prior title",
          body,
          type: "note",
          status: "published",
          tags: "a,b",
          updated_at: updatedAt,
        },
        // lint finalize only archives episodic and source docs.
        {
          id: 8,
          namespace: "capsid",
          path: "ep.md",
          title: "An episodic",
          body: "ep body",
          type: "episodic",
          status: "published",
          tags: null,
          updated_at: updatedAt,
        },
      ]
    : [];
  return {
    documents,
    versions: [
      {
        id: VERSION_ID,
        document_id: 7,
        ...DOC,
        title: "Old title",
        body: "old body",
        snapshot_at: "2026-08-01 00:00:00",
      },
    ],
    namespaces: namespaceExists ? [{ namespace: "capsid", repos: "[]" }] : [],
    raceAfterPreRead: opts.raceAfterPreRead
      ? (rows: FakeD1Rows, target: { namespace: string; path: string }) => {
          const at = () =>
            rows.documents.find((d) => d.namespace === target.namespace && d.path === target.path);
          const racer = (value: string | null) => ({
            id: 7,
            ...target,
            title: "Racing title",
            body: value,
            updated_at: updatedAt,
          });
          const live: LiveState = {
            get body() {
              return at()?.body ?? null;
            },
            set body(value: string | null) {
              const row = at();
              if (row) row.body = value;
              else rows.documents.push(racer(value));
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
              if (value && !at()) rows.documents.push(racer(null));
              else if (!value) {
                const i = rows.documents.findIndex(
                  (d) => d.namespace === target.namespace && d.path === target.path,
                );
                if (i !== -1) rows.documents.splice(i, 1);
              }
            },
          };
          opts.raceAfterPreRead!(live);
        }
      : undefined,
  };
}

type Result = { isError?: boolean; content: Array<{ text: string }> };

// A client with the elicitation capability answers the overwrite prompt; one without it is
// refused with "confirmation required" before a guard is chosen.
async function connect(
  grant: ToolGrant,
  opts: FakeOptions = {},
  elicit?: "accept" | "decline",
  failBatchMatching?: RegExp,
) {
  const { rows, recorded, db } = fakeD1({ ...connectOptions(opts), failBatchMatching });
  const server = buildServer(fakeEnv({ DB: db }), grant, "test:guard");
  const client = new Client(
    { name: "invariant-test", version: "1.0.0" },
    elicit ? { capabilities: { elicitation: {} } } : undefined,
  );
  // Counted, because a test that silently fell back to the unsupported path would never reach the guard.
  const prompts: string[] = [];
  if (elicit) {
    client.setRequestHandler("elicitation/create", async (request) => {
      prompts.push(String(request.params.message));
      return elicit === "accept"
        ? { action: "accept", content: { confirm: true } }
        : { action: "decline" };
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, recorded, rows, prompts, close: () => client.close() };
}

// One call on a fresh connection: the result, its first text, and the statements issued.
async function run(
  tool: string,
  args: Record<string, unknown>,
  opts: FakeOptions = {},
  extra: { grant?: ToolGrant; elicit?: "accept" | "decline" } = {},
) {
  const c = await connect(extra.grant ?? "write", opts, extra.elicit);
  const result = (await c.client.callTool({ name: tool, arguments: args })) as Result;
  await c.close();
  return {
    result,
    text: result.content?.[0]?.text ?? "",
    recorded: c.recorded,
    prompts: c.prompts,
  };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sqlFor = (recorded: Recorded[]) => recorded.map((r) => r.sql.replace(/\s+/g, " ")).join("\n");
const hasUpsert = (recorded: Recorded[]) => /INSERT INTO documents/.test(sqlFor(recorded));

const WRITE = { action: "write", ...DOC, title: "New", body: "new body", confirm: true };
const RESTORE = { action: "restore", ...DOC, version_id: VERSION_ID, confirm: true };
const DELETE = { ...DOC, confirm: true };
const MOVE = { action: "move", ...DOC, new_path: "moved.md", confirm: true };

// The snapshot itself: the statement that copies the live title and body into a version
// row. A bare /INSERT INTO document_versions/ would also match the requireExists and
// requireBodyUnchanged guards, so a batch that lost its snapshot would still match.
const SNAPSHOT_COPY = /INSERT INTO document_versions \(document_id, namespace, path, title, body\)/;

// The tools and actions that overwrite, remove or rename a document, and what each must
// issue. Adding a mutating tool without adding it here is the gap the source guard in
// invariants.test.ts covers from the other side.
const MUTATORS: Array<{
  label: string;
  tool: string;
  args: Record<string, unknown>;
  requires: RegExp[];
  refusesUnregisteredWith?: RegExp;
}> = [
  {
    label: "capsid_write_doc.write",
    tool: "capsid_write_doc",
    args: WRITE,
    requires: [SNAPSHOT_COPY, /INSERT INTO audit_log/],
  },
  {
    label: "capsid_delete_doc",
    tool: "capsid_delete_doc",
    args: DELETE,
    requires: [SNAPSHOT_COPY, /INSERT INTO audit_log/],
  },
  {
    label: "capsid_write_doc.restore",
    tool: "capsid_write_doc",
    args: RESTORE,
    requires: [SNAPSHOT_COPY, /INSERT INTO audit_log/],
  },
  // A rename has no body to snapshot; the audit row is the record.
  {
    label: "capsid_write_doc.move",
    tool: "capsid_write_doc",
    args: MOVE,
    requires: [/INSERT INTO audit_log/],
  },
  {
    // The widest mutation: one call renames every consumed document.
    label: "capsid_lint_namespace.finalize",
    tool: "capsid_lint_namespace",
    args: { namespace: "capsid", mode: "finalize", consumed: ["ep.md"], confirm: true },
    requires: [/INSERT INTO audit_log/],
    // finalize fails its own per-path existence check instead of requireRegisteredNamespace.
    refusesUnregisteredWith: /not found/,
  },
];

for (const { label, tool, args, requires } of MUTATORS) {
  test(`${label} issues its snapshot and audit statements, all in ONE batch`, async () => {
    const { result, text, recorded } = await run(tool, args);
    assert.ok(!result.isError, `${label} returned an error: ${text}`);
    assert.ok(recorded.length > 0, `${label} issued no statements`);
    const sql = sqlFor(recorded);
    for (const re of requires) assert.match(sql, re, `${label} did not issue ${re}:\n${sql}`);
    // A separate .run() after the batch is two transactions, so the mutation and its audit record could disagree.
    assert.deepEqual(
      recorded.filter((r) => r.via === "direct").map((r) => r.sql.slice(0, 60)),
      [],
      `${label} issued statements outside the batch`,
    );
  });

  test(`${label} returns a clean failure, and says nothing changed, when the batch throws`, async () => {
    const c = await connect(
      "write",
      {},
      undefined,
      /INSERT INTO document_versions|UPDATE documents|INSERT INTO documents|DELETE FROM documents/,
    );
    const result = (await c.client.callTool({ name: tool, arguments: args })) as Result;
    await c.close();
    const text = result.content?.[0]?.text ?? "";
    assert.equal(result.isError, true, `${label} reported success on a failed batch`);
    assert.match(text, /database is locked/);
    assert.match(text, /nothing (was written|changed|archived)/i);
  });
}

test("capsid_delete_doc copies title and body to document_versions before the DELETE", async () => {
  const { recorded } = await run("capsid_delete_doc", DELETE);
  const statements = recorded.map((r) => r.sql.replace(/\s+/g, " "));
  const snapshot = statements.findIndex((q) => SNAPSHOT_COPY.test(q));
  const removal = statements.findIndex((q) => /DELETE FROM documents WHERE/.test(q));
  assert.ok(removal >= 0 && snapshot >= 0, statements.join("\n"));
  assert.ok(snapshot < removal, "the snapshot must come before the DELETE in the batch");
});

test("a read-only key cannot reach any mutating tool, and writes nothing", async () => {
  for (const { label, tool, args } of MUTATORS) {
    const c = await connect("read");
    // A tool that needs write in whole is not served to a read grant, so the protocol refuses
    // it; an action tool is served and refuses the write action by name.
    const result = (await c.client
      .callTool({ name: tool, arguments: args })
      .catch((error: unknown) => ({
        isError: true,
        content: [{ text: error instanceof Error ? error.message : String(error) }],
      }))) as Result;
    await c.close();
    assert.equal(result.isError, true, `${label} did not refuse a read-only key`);
    assert.match(result.content[0].text, /requires the write grant|not found/);
    assert.deepEqual(c.recorded, [], `${label} wrote while refusing a read-only key`);
  }
});

test("every mutator refuses an unregistered namespace, and writes nothing", async () => {
  // A typo in `namespace` must not open a shadow namespace the lint loop never counts.
  for (const { label, tool, args, refusesUnregisteredWith } of MUTATORS) {
    const { result, text, recorded } = await run(
      tool,
      { ...args, namespace: "typoed-ns" },
      { namespaceExists: false },
    );
    assert.equal(result.isError, true, `${label} accepted an unregistered namespace`);
    assert.match(text, refusesUnregisteredWith ?? /unknown namespace/);
    assert.deepEqual(recorded, [], label);
  }
});

test("mode meta leaves the body byte-identical, wide dash and all, and audits the prior metadata", async () => {
  // Built from its code point, because the repo's PreToolUse hook refuses the literal character.
  const dashed = `a body with an em ${String.fromCharCode(0x2014)} dash in it`;
  const { result, text, recorded } = await run(
    "capsid_write_doc",
    { action: "write", ...DOC, mode: "meta", status: "closed" },
    { body: dashed },
  );
  assert.ok(!result.isError, text);
  const upsert = recorded.find((r) => /INSERT INTO documents/i.test(r.sql));
  assert.ok(
    upsert?.params.includes(dashed),
    `meta rewrote the body: ${JSON.stringify(upsert?.params)}`,
  );
  // A version snapshot does not carry type, status or tags.
  const audit = recorded.find((r) => /INSERT INTO audit_log/i.test(r.sql));
  assert.match(JSON.stringify(audit?.params), /prior_meta/);
});

test("if_match: a stale one refuses with the current sha, a write or restore with the right one lands", async () => {
  for (const args of [WRITE, RESTORE]) {
    const stale = await run("capsid_write_doc", { ...args, if_match: "0".repeat(64) });
    assert.equal(stale.result.isError, true, "a stale if_match was accepted");
    assert.match(stale.text, /if_match mismatch/);
    assert.match(stale.text, /Current sha256 is [0-9a-f]{64}/);
    assert.deepEqual(stale.recorded, [], "a refused if_match still wrote statements");

    const good = await run("capsid_write_doc", { ...args, if_match: sha("prior body") });
    assert.ok(!good.result.isError, good.text);
    assert.match(sqlFor(good.recorded), SNAPSHOT_COPY);
  }
});

// The overwrite warning: an unguarded overwrite of a recently written document warns,
// because a stale read can replace another session's work with a clean response.

const recently = (minutesAgo: number) =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString().slice(0, 19).replace("T", " ");

const warningFor = async (opts: FakeOptions, args: Record<string, unknown> = {}) => {
  const { result, text, recorded } = await run("capsid_write_doc", { ...WRITE, ...args }, opts);
  assert.ok(!result.isError, "the warning turned into a refusal");
  assert.ok(hasUpsert(recorded), "the write did not land");
  return (JSON.parse(text) as { concurrency_warning?: string }).concurrency_warning;
};

test("overwriting a document touched in the last hour warns, with the time, and still lands", async () => {
  const warning = await warningFor({ updatedAt: recently(10) });
  assert.match(warning ?? "", /possible concurrent edit/);
  assert.match(warning ?? "", /pass if_match/i);
  assert.match(warning ?? "", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
});

test("an older document or a guarded write does not warn", async () => {
  assert.equal(await warningFor({ updatedAt: recently(61) }), undefined);
  assert.equal(await warningFor({ updatedAt: "2020-01-01 00:00:00" }), undefined);
  assert.equal(
    await warningFor({ updatedAt: recently(1) }, { if_match: sha("prior body") }),
    undefined,
  );
});

test("a UTC timestamp is not read as local time", () => {
  // D1 stores datetime('now') in UTC with no zone marker; parsed as local it would be wrong off a UTC machine.
  const now = Date.parse("2026-08-14T12:00:00Z");
  assert.ok(concurrentEditWarning("2026-08-14 11:30:00", now));
  assert.equal(concurrentEditWarning("2026-08-14 10:00:00", now), null);
  // A future timestamp is a clock problem, not a concurrent edit.
  assert.equal(concurrentEditWarning("2026-08-14 13:00:00", now), null);
  assert.equal(concurrentEditWarning(null, now), null);
});

test("the concurrency warning is read at COMMIT time, not from the pre-read", async () => {
  const fresh = recently(5);
  const warning = await warningFor({
    updatedAt: "2020-01-01 00:00:00",
    raceAfterPreRead: (live) => {
      live.updatedAt = fresh;
    },
  });
  assert.match(warning ?? "", new RegExp(fresh));
});

// The write predicate: every test below turns on a store that changes between the
// handler's pre-read and its commit.

test("a body that changes after the pre-read is refused at commit, with the racer's sha", async () => {
  // The pre-check passes (the sha is right when the handler reads it), so the refusal comes from the in-batch guard.
  const { result, text, recorded } = await run(
    "capsid_write_doc",
    { ...WRITE, if_match: sha("prior body") },
    {
      raceAfterPreRead: (live) => {
        live.body = RACED;
      },
    },
  );
  assert.equal(result.isError, true, "the racing write was overwritten instead of refused");
  assert.match(text, /stored body changed after this write read it/);
  // The sha reported is the one the caller must rebase onto.
  assert.match(text, new RegExp(`Current sha256 is ${sha(RACED)}`));
  assert.deepEqual(recorded, [], "a refused predicate still committed statements");
});

test("an overwrite with no confirm is refused before any commit", async () => {
  const { result, text, recorded } = await run("capsid_write_doc", {
    ...WRITE,
    confirm: undefined,
  });
  assert.equal(result.isError, true);
  assert.match(text, /confirmation required/);
  assert.deepEqual(recorded, []);
});

test("of two racing creates exactly one wins; the loser is refused, not turned into an overwrite", async () => {
  // The loser's statement list carries no snapshot, so falling into ON CONFLICT DO UPDATE would lose the winner's body.
  const create = {
    action: "write",
    namespace: "capsid",
    path: "new-doc.md",
    title: "T",
    body: "b",
  };
  const lost = await run("capsid_write_doc", create, {
    exists: false,
    raceAfterPreRead: (live) => {
      live.exists = true;
      live.body = "the winner body";
    },
  });
  assert.equal(lost.result.isError, true, "the second create silently overwrote the first");
  assert.match(lost.text, /create collision/);
  assert.match(lost.text, /another writer created it first/);
  assert.deepEqual(lost.recorded, []);

  const clean = await run("capsid_write_doc", create, { exists: false });
  assert.ok(!clean.result.isError, clean.text);
  const out = JSON.parse(clean.text) as { action: string; snapshotted: boolean };
  assert.deepEqual([out.action, out.snapshotted], ["created", false]);
  assert.ok(hasUpsert(clean.recorded));
});

test("restore writes the VERSION body and title, and snapshots the LIVE one", async () => {
  // A restore that wrote the live body back over itself would issue the same statements;
  // only the bound value tells them apart. The snapshot's INSERT ... SELECT runs against
  // real SQLite in test-integration/live-snapshot.test.ts.
  const { result, text, recorded } = await run("capsid_write_doc", RESTORE);
  assert.ok(!result.isError, text);
  const upsert = recorded.find((r) => /INSERT INTO documents [(]/i.test(r.sql));
  assert.ok(upsert, "restore issued no upsert");
  assert.ok(upsert.params.includes("old body"), JSON.stringify(upsert.params));
  assert.ok(upsert.params.includes("Old title"));
  assert.equal(upsert.params.includes("prior body"), false, "restore wrote the LIVE body back");
});

test("restore refuses a body changed after its pre-read, and a racing create when it recreates a deleted document", async () => {
  const changed = await run(
    "capsid_write_doc",
    { ...RESTORE, if_match: sha("prior body") },
    {
      raceAfterPreRead: (live) => {
        live.body = "changed under the restore";
      },
    },
  );
  assert.equal(
    changed.result.isError,
    true,
    "restore committed over a body that changed beneath it",
  );
  assert.match(changed.text, /live body changed after this restore read it/);
  assert.deepEqual(changed.recorded, []);

  const created = await run("capsid_write_doc", RESTORE, {
    exists: false,
    raceAfterPreRead: (live) => {
      live.exists = true;
      live.body = "recreated by someone else";
    },
  });
  assert.equal(
    created.result.isError,
    true,
    "restore overwrote a document created during its flight",
  );
  assert.match(created.text, /create collision/);
  assert.deepEqual(created.recorded, []);
});

// Version history is scoped by namespace and path, so an id alone cannot walk every
// snapshot in the store.

test("capsid_read_doc versions lists, scopes and fetches versions of the document asked for", async () => {
  const read = (path: string, extra: Record<string, unknown> = {}) =>
    run("capsid_read_doc", { action: "versions", namespace: "capsid", path, ...extra });

  const list = await read("doc.md");
  const listed = JSON.parse(list.text) as { versions: Array<{ id: number }>; live: unknown };
  assert.deepEqual(
    listed.versions.map((v) => v.id),
    [VERSION_ID],
  );
  assert.ok(listed.live);

  const other = await read("ep.md");
  assert.deepEqual((JSON.parse(other.text) as { versions: unknown[] }).versions, []);

  const wrongPath = await read("ep.md", { version_id: VERSION_ID });
  assert.equal(wrongPath.result.isError, true, "a snapshot was readable through another document");
  assert.match(wrongPath.text, /no version 42/);

  const byId = JSON.parse((await read("doc.md", { version_id: VERSION_ID })).text) as {
    id: number;
    body: string;
  };
  assert.deepEqual([byId.id, byId.body], [VERSION_ID, "old body"]);
});

test("restore and delete refuse a version or document that does not exist, and write nothing", async () => {
  const cases: Array<[string, string, Record<string, unknown>, RegExp]> = [
    ["capsid_write_doc", "a missing version id", { ...RESTORE, version_id: 99 }, /no version 99/],
    [
      "capsid_write_doc",
      "a version of another document",
      { ...RESTORE, path: "some-other-doc.md" },
      /no version 42/,
    ],
    [
      "capsid_delete_doc",
      "a missing document",
      { ...DELETE, path: "never-existed.md" },
      /not found/,
    ],
  ];
  for (const [tool, label, args, re] of cases) {
    const { result, text, recorded } = await run(tool, args);
    assert.equal(result.isError, true, label);
    assert.match(text, re, label);
    assert.deepEqual(recorded, [], label);
  }
});

// The elicited arm: consent given through elicitation is bound to the body it was about.
// No call passes confirm or if_match, so the elicited signal is the only thing that can arm
// the body guard.

const ELICITED: Array<[string, string, Record<string, unknown>]> = [
  ["write", "capsid_write_doc", { ...WRITE, confirm: undefined }],
  ["restore", "capsid_write_doc", { ...RESTORE, confirm: undefined }],
  ["delete", "capsid_delete_doc", { ...DELETE, confirm: undefined }],
];

test("after an elicitation, write, restore and delete each refuse a body changed while the prompt was open, and each lands with no race", async () => {
  for (const [label, tool, args] of ELICITED) {
    const raced = await run(
      tool,
      args,
      {
        raceAfterPreRead: (live) => {
          live.body = "body written while the prompt was up";
        },
      },
      { elicit: "accept" },
    );
    assert.equal(raced.prompts.length, 1, `${label} did not elicit`);
    assert.equal(
      raced.result.isError,
      true,
      `${label} landed on a body that changed under an open prompt`,
    );
    assert.deepEqual(raced.recorded, [], label);
    if (label === "delete") {
      assert.match(raced.text, /changed or was removed while the confirmation was open/);
    }

    // The innocent direction: a guard that fired on every call would pass the above.
    const clean = await run(tool, args, {}, { elicit: "accept" });
    assert.equal(clean.prompts.length, 1, label);
    assert.ok(!clean.result.isError, `${label} was refused: ${clean.text}`);
    assert.ok(clean.recorded.length > 0, label);
  }
});

test("a confirm: true delete lands over a changed body, and is refused when the row is gone", async () => {
  // confirm: true approves deleting the path, not a body, so the guard is existence only;
  // otherwise the delete would snapshot and audit a row it never removed.
  const changed = await run("capsid_delete_doc", DELETE, {
    raceAfterPreRead: (live) => {
      live.body = RACED;
    },
  });
  assert.ok(!changed.result.isError, changed.text);
  assert.match(sqlFor(changed.recorded), /DELETE FROM documents/);

  const removed = await run("capsid_delete_doc", DELETE, {
    raceAfterPreRead: (live) => {
      live.exists = false;
    },
  });
  assert.equal(
    removed.result.isError,
    true,
    "a delete of a row removed in flight reported success",
  );
  assert.match(removed.text, /no longer exists/);
  assert.deepEqual(removed.recorded, []);
});

test("a declined elicitation refuses, and writes nothing", async () => {
  const { result, text, prompts, recorded } = await run(
    "capsid_write_doc",
    { ...WRITE, confirm: undefined },
    {},
    { elicit: "decline" },
  );
  assert.equal(prompts.length, 1);
  assert.equal(result.isError, true, "a declined overwrite was written anyway");
  assert.match(text, /overwrite of capsid\/doc\.md declined/);
  assert.deepEqual(recorded, []);
});

test("a stale confirmation and an if_match mismatch are each named as themselves", async () => {
  const race = {
    raceAfterPreRead: (live: LiveState) => {
      live.body = RACED;
    },
  };
  // No if_match was sent, so "if_match mismatch" would point the caller at an argument they did not use.
  const stale = await run("capsid_write_doc", { ...WRITE, confirm: undefined }, race, {
    elicit: "accept",
  });
  assert.equal(stale.result.isError, true);
  assert.match(stale.text, /^stale confirmation on capsid\/doc\.md:/);
  assert.doesNotMatch(stale.text, /if_match mismatch/);
  assert.match(stale.text, /and while the overwrite confirmation was pending/);
  assert.match(stale.text, new RegExp(sha(RACED)));
  assert.deepEqual(stale.recorded, []);

  // This caller sent a sha and was never prompted, so no pending clause.
  const mismatch = await run("capsid_write_doc", { ...WRITE, if_match: sha("prior body") }, race, {
    elicit: "accept",
  });
  assert.equal(mismatch.result.isError, true);
  assert.match(mismatch.text, /^if_match mismatch on capsid\/doc\.md:/);
  assert.doesNotMatch(mismatch.text, /stale confirmation|overwrite confirmation was pending/);
});

// A landed GitHub change is not reported as a failure.

test("capsid_close_pr close reports success with a warning when the audit insert fails", async () => {
  // guardedWrite changes GitHub and then writes its audit row, and the two cannot share a
  // transaction. Reporting a failure would invite a retry of a change already made.
  const { db } = fakeD1(connectOptions({}));
  (db as { prepare: unknown }).prepare = ((sql: string) => {
    const base = {
      bind: () => base,
      first: async () => null,
      all: async () => ({ results: [], meta: { changes: 0 } }),
      run: async () => ({ meta: { changes: 1 } }),
    } as Record<string, unknown>;
    if (/INSERT INTO audit_log/i.test(sql)) {
      base.run = async () => {
        throw new Error("D1_ERROR: no such table: audit_log");
      };
    }
    if (/FROM namespaces/i.test(sql))
      base.first = async () => ({ repos: JSON.stringify([{ repo: "o/r", label: "primary" }]) });
    return base;
  }) as never;

  const server = buildServer(
    fakeEnv({
      DB: db,
      APP_KV: {
        get: async (k: string) => (k.startsWith("gh:token:") ? "t" : null),
        put: async () => {},
        delete: async () => {},
        list: async () => ({ keys: [], list_complete: true }),
      },
    }),
    "write",
    "test:guard",
  );
  const client = new Client({ name: "close-pr-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (new URL(url).pathname === "/repos/o/r/pulls/7" && method === "PATCH") {
      return new Response(
        JSON.stringify({ number: 7, state: "closed", html_url: "https://github.com/o/r/pull/7" }),
        { status: 200 },
      );
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const result = (await client.callTool({
      name: "capsid_close_pr",
      arguments: { action: "close", namespace: "capsid", number: 7 },
    })) as Result;
    assert.ok(
      !result.isError,
      `the landed close was reported as a failure: ${result.content?.[0]?.text}`,
    );
    const payload = JSON.parse(result.content[0].text) as {
      state?: string;
      audit_warning?: string;
    };
    assert.equal(payload.state, "closed");
    assert.match(payload.audit_warning ?? "", /SUCCEEDED/);
    assert.match(payload.audit_warning ?? "", /no such table: audit_log/);
    assert.match(payload.audit_warning ?? "", /Do not retry/);
  } finally {
    globalThis.fetch = original;
    await client.close();
  }
});

// Patch uniqueness: test/write-modes.test.ts proves the rule on `assembleBody`; this proves
// the handler applies it. The assertion that matters is refused and nothing written.

test("a patch whose find occurs zero or several times is refused and writes nothing; exactly once lands", async () => {
  const patch = (body: string, find: string) =>
    run(
      "capsid_write_doc",
      { action: "write", ...DOC, mode: "patch", find, replace_with: "DELTA", confirm: true },
      { body },
    );
  for (const [body, find, re] of [
    ["alpha beta gamma", "no such text", /occurs 0 times|not found|exactly once/i],
    ["repeat once, repeat twice", "repeat", /occurs 2 times|exactly once/i],
  ] as const) {
    const { result, text, recorded } = await patch(body, find);
    assert.equal(result.isError, true, `a patch with ${find} was applied`);
    assert.match(text, re);
    assert.equal(hasUpsert(recorded), false, "a refused patch still wrote the document");
  }
  const { result, text, recorded } = await patch("alpha beta gamma", "beta");
  assert.ok(!result.isError, text);
  const insert = recorded.find((r) => /INSERT INTO documents/i.test(r.sql));
  assert.ok(insert?.params.includes("alpha DELTA gamma"), JSON.stringify(insert?.params));
});
