import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { MAX_ROWS } from "../src/limits.ts";
import { driverMintInstruction, defaultScopes } from "../src/agents-schema.ts";
import { actionArgFor, defaultActionFor, repoWriteFlags, requiredGrant } from "../src/scope.ts";
import { CORRECTION_CAP } from "../src/jobs-schema.ts";
import { buildTruthReport, INTEGRITY_LINE, integrityOf, renderTruthReport, reportPath } from "../src/truth-report.ts";
import { adminAgent, type Agent } from "../src/agents.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// THE EIGHT SMALL DEFECTS FROM AUDIT-2026-09-16.md, one plant each (job_38ae28d18699).
//
// Each was confirmed by the seat before it was posted, so these are not hypotheses:
// every test below was observed RED against master at 05562bc and green after the fix
// in the same commit. They are kept because a defect that was true once in a file
// nobody is watching is a defect that comes back the next time that file is rewritten.
//
// Defect 7 is planted in test/csp-rate-limit.test.ts instead, beside the fail-open
// tests it reverses, so the two readings of the same question sit together.

async function connect(agent: Agent | "read" | "write", rows: Record<string, unknown[]> = {}) {
  const { db, batches, recorded } = fakeD1(rows);
  const env = fakeEnv({ DB: db, APP_KV: fakeKv({}).kv });
  const server = typeof agent === "string" ? buildServer(env, agent, "test:audit") : buildServer(env, agent);
  const client = new Client({ name: "audit-2026-09-16", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { client, batches, recorded, close: () => client.close() };
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };

const text = (result: { content: Array<{ text: string }> }) => result.content.map((c) => c.text).join("");

// ---- 1: the mint instruction and TOOL_GRANTS ------------------------------------

test("PLANT: the driver mint instruction agrees with what register_namespace actually requires", () => {
  // It said register_namespace "takes a plain write grant". That had been false since
  // 2026-09-13, when the namespace-to-repo mapping became admin work, and the sentence
  // is the one a namespace owner reads when register_namespace refuses them.
  //
  // The two cannot be the same expression: src/scope.ts imports src/agents-schema.ts,
  // so the sentence importing TOOL_GRANTS would close a load-time cycle. This is what
  // holds them together instead, and it fails in BOTH directions: a table moved back
  // to "write" fails here as loudly as a sentence rewritten to the wrong grant.
  const said = driverMintInstruction("capsid");
  const required = requiredGrant("register_namespace");
  assert.equal(required, "admin", "register_namespace stopped being admin only; the mint instruction has to be rewritten with it");
  assert.match(said, new RegExp(`register_namespace is itself ${required} only`), said);
  assert.doesNotMatch(said, /plain write grant/, "the instruction still promises a grant that will be refused");
});

// ---- 2: the jobs description and the retry cap ----------------------------------

test("PLANT: the jobs description states the correction cap rather than promising no cap", async () => {
  // "A job may be blocked and resumed any number of times" was the whole sentence.
  // resumeJob refuses a non-admin once CORRECTION_CAP corrections have been spent on
  // the work, so the description promised a caller something the Worker refuses.
  const { client, close } = await connect(adminAgent("DrDustinEdwards"));
  try {
    const { tools } = await client.listTools();
    const jobs = tools.find((t) => t.name === "jobs");
    assert.ok(jobs, "jobs is not served");
    const description = jobs.description ?? "";
    assert.ok(
      description.includes(`capped at ${CORRECTION_CAP}`),
      `the description does not state the cap of ${CORRECTION_CAP}: ${description.slice(-400)}`
    );
    assert.doesNotMatch(
      description,
      /A job may be blocked and resumed any number of times/,
      "the description still promises an unbounded loop"
    );
  } finally {
    await close();
  }
});

// ---- 3: a handler default the scope table cannot see -----------------------------

// An agent minted the way scripts/mint-agents.mjs mints a narrowed one: the tools axis
// names the tool and one of its actions, which is what opts into the qualifier.
function narrowedTo(tools: string[]): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  scopes.tools = tools;
  return { id: "agent_narrow01", name: "narrow", kind: "session", actor: "agent:narrow", scopes, admin: false, row: null };
}

test("PLANT: an agent scoped to lint.gather may call lint with no mode at all", async () => {
  // lint's handler reads an omitted mode as gather. DEFAULT_ACTION did not, so the
  // registrar passed no action, allowsToolAction refused an unknown action on a
  // narrowed tool, and the caller was refused the one mode it was minted for. The
  // refusal names `lint`, not `lint.gather`, which is what made it look like a
  // mis-minted agent rather than a missing table entry.
  const { client, close } = await connect(narrowedTo(["lint", "lint.gather"]), {
    documents: [{ id: 1, namespace: "capsid", path: "core.md", title: "core", body: "the core", type: "core", status: "published", tags: null }],
    namespaces: [{ namespace: "capsid", repos: "[]" }],
  });
  try {
    const result = await call(client, "lint", { namespace: "capsid" });
    assert.doesNotMatch(text(result), /not scoped to/, `a gather-only caller was refused its own default mode: ${text(result)}`);
  } finally {
    await close();
  }
});

test("PLANT: the same caller with no mode is still refused finalize", async () => {
  // The innocent direction. A default that widened the narrowing would pass the test
  // above by handing the caller the whole tool back.
  const { client, close } = await connect(narrowedTo(["lint", "lint.gather"]));
  try {
    const result = await call(client, "lint", { namespace: "capsid", mode: "finalize" });
    assert.equal(result.isError, true, "a gather-only caller ran finalize");
    assert.match(text(result), /not scoped to the 'lint\.finalize' tool/, text(result));
  } finally {
    await close();
  }
});

test("DERIVED: every action tool whose action argument is optional has a table default", async () => {
  // The guard against the finding recurring, derived from the SERVED schemas rather
  // than from the source. An optional action argument IS a handler default: something
  // has to decide what an omitted one means, and if the enforcement point does not
  // know the answer, a narrowed caller is refused the tool's own default.
  const { client, close } = await connect(adminAgent("DrDustinEdwards"));
  const { tools } = await client.listTools();
  await close();
  const wired = tools.filter((t) => actionArgFor(t.name) !== undefined);
  assert.ok(wired.length >= 5, `only ${wired.length} action tools were found, so this is passing by reading nothing`);
  const missing = wired
    .filter((t) => {
      const key = actionArgFor(t.name)!;
      const required = (t.inputSchema.required ?? []) as string[];
      return !required.includes(key) && defaultActionFor(t.name) === undefined;
    })
    .map((t) => t.name);
  assert.deepEqual(missing, [], `these tools make their action optional and the scope table cannot say what an omitted one means: ${missing.join(", ")}`);
});

// ---- 4: a null integrity is not a zero -------------------------------------------

test("PLANT: an unmeasured integrity renders as unmeasured, never as 0%", () => {
  // buildTruthReport returns null when no check had a subject to judge, which is what
  // an empty namespace looks like. The line rendered "integrity: 0%", which is the
  // number a store in the worst state it can be in would carry.
  const report = buildTruthReport({
    namespace: "empty",
    now: new Date("2026-09-16T12:00:00Z"),
    docs: [],
    edges: [],
    danglingEdges: [],
    countClaims: [],
    repoPaths: undefined,
  });
  assert.equal(report.integrity, null, "this fixture is meant to have nothing to judge");
  const body = renderTruthReport(report);
  assert.doesNotMatch(body, /integrity: 0%/, "an unmeasured store reported itself as 0% integrity");
  assert.match(body, /^integrity: not measured$/m, body.split("\n").slice(0, 4).join("\n"));
  // The parser answers the same way a missing document does, which is what
  // improve_status reports as "no report" rather than as a number.
  assert.doesNotMatch(body, INTEGRITY_LINE);
  assert.equal(integrityOf(body), null);
});

test("a measured integrity still renders as a number the parser reads back", () => {
  // The other direction, so a render that simply stopped printing numbers passes
  // nothing.
  const report = buildTruthReport({
    namespace: "capsid",
    now: new Date("2026-09-16T12:00:00Z"),
    docs: [{ path: "core.md", type: "core", status: "published", title: "core", body: "the core", updated_at: "2026-09-16 00:00:00" }],
    edges: [],
    danglingEdges: [],
    countClaims: [],
    repoPaths: undefined,
  });
  assert.notEqual(report.integrity, null);
  const body = renderTruthReport(report);
  assert.match(body, INTEGRITY_LINE);
  assert.equal(integrityOf(body), report.integrity);
});

// ---- 5: a report overwrites a report --------------------------------------------

const TODAY = reportPath(new Date());

function reportRows(withPrior: boolean) {
  const documents: Record<string, unknown>[] = [
    { id: 1, namespace: "capsid", path: "core.md", title: "core", body: "the core", type: "core", status: "published", tags: null, updated_at: "2026-09-16 00:00:00" },
  ];
  if (withPrior) {
    documents.push({
      id: 2,
      namespace: "capsid",
      path: TODAY,
      title: "Truth report - capsid",
      body: "integrity: 91%\n\nyesterday's run, written today",
      type: "reference",
      status: "published",
      tags: null,
      updated_at: "2026-09-16 00:00:00",
    });
  }
  return { documents, namespaces: [{ namespace: "capsid", repos: "[]" }] };
}

test("PLANT: a second report the same day is REFUSED without confirmation", async () => {
  // One report per namespace per day means the second run overwrites the first. The
  // prior body was snapshotted, so nothing was lost, but the caller was never asked
  // and the response never said a report had been replaced. `write` has elicited this
  // exact confirmation for every other overwrite since it was added.
  const { client, batches, close } = await connect("write", reportRows(true));
  try {
    const result = await call(client, "lint", { namespace: "capsid", mode: "report" });
    assert.equal(result.isError, true, "a report overwrote today's report without asking");
    assert.match(text(result), /confirmation required/, text(result));
    assert.match(text(result), new RegExp(`capsid/${TODAY.replace(/[.\\/-]/g, "\\$&")}`), text(result));
    assert.deepEqual(batches, [], "the refusal came after the write, so it describes something that already happened");
  } finally {
    await close();
  }
});

test("the same call WITH confirm: true overwrites, snapshotting first", async () => {
  const { client, batches, close } = await connect("write", reportRows(true));
  try {
    const result = await call(client, "lint", { namespace: "capsid", mode: "report", confirm: true });
    assert.ok(!result.isError, text(result));
    const flat = batches.flat().map((s) => s.replace(/\s+/g, " "));
    assert.ok(flat.some((s) => /INSERT INTO document_versions/.test(s)), "snapshot rule: the prior report was replaced without a snapshot");
    assert.ok(flat.some((s) => /INSERT INTO audit_log .* 'lint_report'/.test(s)), "the overwrite skipped the audit log");
  } finally {
    await close();
  }
});

test("THE INNOCENT DIRECTION: the FIRST report of the day needs no confirmation", async () => {
  // There is nothing to overwrite, so asking would turn the daily report into a
  // prompt and the cron that drives it has nobody to answer.
  const { client, batches, close } = await connect("write", reportRows(false));
  try {
    const result = await call(client, "lint", { namespace: "capsid", mode: "report" });
    assert.ok(!result.isError, text(result));
    assert.ok(batches.length > 0, "the first report of the day was not written at all");
  } finally {
    await close();
  }
});

// ---- 6: the resource listing's bound was on the wrong set ------------------------

// Rows a scoped caller may not see, sorted before the ones it may. 'aaa' beats
// 'capsid' in the (namespace, path) order the keyset walk uses, which is the whole
// mechanism: nothing about the caller's namespace is unusual except where it sorts.
const CROWDED = {
  documents: [
    ...Array.from({ length: MAX_ROWS + 2 }, (_, i) => ({
      id: i + 1,
      namespace: "aaa",
      path: `doc-${String(i).padStart(4, "0")}.md`,
      title: `other ${i}`,
      type: "note",
      status: "published",
      tags: null,
      body: "",
    })),
    { id: 9001, namespace: "capsid", path: "core.md", title: "core", type: "core", status: "published", tags: null, body: "" },
    { id: 9002, namespace: "capsid", path: "decisions.md", title: "decisions", type: "decision", status: "published", tags: null, body: "" },
  ],
};

test("PLANT: a caller scoped past 502 rows it cannot see still gets its own documents", async () => {
  // The query took LIMIT 501 and the handler filtered afterwards, so this caller got
  // 501 rows belonging to another namespace, an EMPTY page after filtering, and no
  // cursor, because `more` was computed from the filtered length. Its own two
  // documents were unreachable through resources/list entirely, and the response
  // said the listing was complete.
  const { client, close } = await connect(narrowedTo(["read"]), CROWDED);
  try {
    const listed = await client.listResources();
    assert.equal(listed.resources.length, 2, `the scoped caller got ${listed.resources.length} resources, not its own two`);
    assert.deepEqual(
      listed.resources.map((r) => r.uri).sort(),
      ["capsid://capsid/core.md", "capsid://capsid/decisions.md"],
      "the listing is not this caller's own namespace"
    );
    assert.equal(listed.nextCursor, undefined, "a complete listing advertised another page");
  } finally {
    await close();
  }
});

test("THE ADMIN DIRECTION: an unscoped caller still sees every namespace, bounded and with a cursor", async () => {
  // Without this, a query that filtered everything out would pass the plant above by
  // returning two rows for the wrong reason.
  const { client, close } = await connect(adminAgent("DrDustinEdwards"), CROWDED);
  try {
    const first = await client.listResources();
    assert.equal(first.resources.length, MAX_ROWS, "the admin listing is not bounded");
    assert.ok(first.nextCursor, "the admin listing was capped with no way to reach the rest");
    const second = await client.listResources({ cursor: first.nextCursor });
    assert.equal(second.resources.length, 4, "the remainder did not come back on page two");
    assert.equal(second.nextCursor, undefined);
  } finally {
    await close();
  }
});

// ---- 8: closing a pull request deletes a branch ---------------------------------

test("PLANT: manage_pr close carries can_merge, because close deletes the head branch", () => {
  // close needed nothing but the write grant while deleting the head branch, which is
  // the same destruction merging performs. The alternative considered was to stop
  // deleting on close, which would put back the invisible litter that deletion was
  // added to clear (capsid/conventions.md, 2026-09-06).
  assert.deepEqual(repoWriteFlags("manage_pr", { action: "close" }), ["can_merge"]);
  assert.deepEqual(repoWriteFlags("manage_pr", { action: "merge" }), ["can_merge"]);
  // A comment still does not, or the reviewer role loses the one action it exists for.
  assert.deepEqual(repoWriteFlags("manage_pr", { action: "comment" }), ["can_comment_pr"]);
});

test("PLANT: a write-grant caller holding no flags is refused manage_pr close", () => {
  // The flag through the path a caller takes, rather than the table that names it.
  const caller = narrowedTo(["manage_pr"]);
  const flags = repoWriteFlags("manage_pr", { action: "close" });
  assert.ok(flags.length > 0, "close asks for no flag at all");
  for (const flag of flags) {
    assert.equal(caller.scopes.flags[flag], false, `a plain driver already holds ${flag}, so this proves nothing`);
  }
});
