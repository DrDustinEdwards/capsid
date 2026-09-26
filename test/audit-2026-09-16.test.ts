import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { MAX_ROWS } from "../src/limits.ts";
import { driverMintInstruction, defaultScopes } from "../src/agents-schema.ts";
import { actionArgFor, defaultActionFor, requiredGrant } from "../src/scope.ts";
import { CORRECTION_CAP } from "../src/jobs-schema.ts";
import { buildTruthReport, INTEGRITY_LINE, integrityOf, renderTruthReport, reportPath } from "../src/truth-report.ts";
import { adminAgent, type Agent } from "../src/agents.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// Small defects from AUDIT-2026-09-16.md, one plant each, kept so a fixed defect
// cannot return unnoticed when its file is rewritten. The CSP rate-limit defect is
// planted in test/csp-rate-limit.test.ts, beside the fail-open tests it reverses.

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

// the mint instruction and TOOL_GRANTS

test("PLANT: the driver mint instruction agrees with what register_namespace actually requires", () => {
  // The two cannot be the same expression: src/scope.ts imports src/agents-schema.ts,
  // so the sentence importing TOOL_GRANTS would close a load-time cycle. This holds
  // them together instead, and fails if either the table or the sentence changes.
  const said = driverMintInstruction("capsid");
  const required = requiredGrant("register_namespace");
  assert.match(said, new RegExp(`register_namespace is itself ${required} only`), said);
});

// the jobs description and the retry cap

test("PLANT: the jobs description states the correction cap rather than promising no cap", async () => {
  // resumeJob refuses a non-admin once CORRECTION_CAP corrections have been spent, so
  // the description must state the cap.
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
  } finally {
    await close();
  }
});

// a handler default the scope table cannot see

// An agent minted the way scripts/mint-agents.mjs mints a narrowed one: the tools axis
// names the tool and one of its actions, which is what opts into the qualifier.
function narrowedTo(tools: string[]): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  scopes.tools = tools;
  return { id: "agent_narrow01", name: "narrow", kind: "session", actor: "agent:narrow", scopes, admin: false, row: null };
}

test("PLANT: an agent scoped to lint.gather may call lint with no mode at all", async () => {
  // lint's handler reads an omitted mode as gather. Unless DEFAULT_ACTION agrees, the
  // registrar passes no action and allowsToolAction refuses an unknown action on a
  // narrowed tool, so the caller is refused the one mode it was minted for.
  const { client, close } = await connect(narrowedTo(["lint", "lint.gather"]), {
    documents: [{ id: 1, namespace: "capsid", path: "core.md", title: "core", body: "the core", type: "core", status: "published", tags: null }],
    namespaces: [{ namespace: "capsid", repos: "[]" }],
  });
  try {
    const result = await call(client, "lint", { namespace: "capsid" });
    assert.notEqual(result.isError, true, `a gather-only caller was refused its own default mode: ${text(result)}`);
    const packet = JSON.parse(text(result)) as { mode: string; namespace: string; core: { body?: string } | null };
    assert.equal(packet.mode, "gather", "an omitted mode did not run gather");
    assert.equal(packet.namespace, "capsid");
    assert.equal(packet.core?.body, "the core", "the gather packet came back without the namespace's core document");
  } finally {
    await close();
  }
});

test("PLANT: the same caller with no mode is still refused finalize", async () => {
  // A default that widened the narrowing would pass the test above by handing the
  // caller the whole tool back.
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
  // Derived from the served schemas. An optional action argument is a handler default,
  // and if the enforcement point does not know it, a narrowed caller is refused the
  // tool's own default.
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

// a null integrity is not a zero

test("PLANT: an unmeasured integrity renders as unmeasured, never as 0%", () => {
  // buildTruthReport returns null when no check had a subject to judge, as for an
  // empty namespace. 0% would claim the worst possible state.
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
  // The parser answers as for a missing document, which improve_status reports as
  // "no report".
  assert.doesNotMatch(body, INTEGRITY_LINE);
  assert.equal(integrityOf(body), null);
});

test("a measured integrity still renders as a number the parser reads back", () => {
  // So a render that stopped printing numbers fails.
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

// a report overwrites a report

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
  // One report per namespace per day means the second run overwrites the first, so it
  // asks for the same confirmation `write` asks for on every other overwrite.
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
  const { client, batches, recorded, close } = await connect("write", reportRows(true));
  try {
    const result = await call(client, "lint", { namespace: "capsid", mode: "report", confirm: true });
    assert.ok(!result.isError, text(result));
    const flat = batches.flat().map((s) => s.replace(/\s+/g, " "));
    assert.ok(flat.some((s) => /INSERT INTO document_versions/.test(s)), "snapshot rule: the prior report was replaced without a snapshot");
    assert.ok(
      recorded.some((r) => /INSERT INTO audit_log/.test(r.sql) && r.params[1] === "lint_report"),
      "the overwrite skipped the audit log"
    );
  } finally {
    await close();
  }
});

test("THE INNOCENT DIRECTION: the FIRST report of the day needs no confirmation", async () => {
  // There is nothing to overwrite, and the cron that drives the report has nobody to
  // answer a prompt.
  const { client, batches, recorded, close } = await connect("write", reportRows(false));
  try {
    const result = await call(client, "lint", { namespace: "capsid", mode: "report" });
    assert.ok(!result.isError, text(result));
    assert.ok(batches.length > 0, "the first report of the day was not written at all");
    const written = recorded.find((r) => /INSERT INTO documents/.test(r.sql));
    assert.ok(written, "no document write was issued for the report");
    assert.equal(written.params[0], "capsid");
    assert.equal(written.params[1], TODAY, "the report was written somewhere other than today's report path");
    assert.match(String(written.params[3]), /^# Truth report - capsid/);
    assert.match(String(written.params[3]), /integrity: \d+%/);
    assert.ok(
      recorded.some((r) => /INSERT INTO audit_log/.test(r.sql) && r.params[1] === "lint_report" && r.params[3] === TODAY),
      "the first report skipped the audit log"
    );
  } finally {
    await close();
  }
});

// the resource listing's bound is on the caller's rows

// Rows a scoped caller may not see, sorted before the ones it may: 'aaa' sorts before
// 'capsid' in the (namespace, path) order the keyset walk uses.
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
  // A LIMIT applied before the scope filter would give this caller an empty page and
  // no cursor, leaving its own two documents unreachable.
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

// closing a pull request deletes a branch

// A write-grant caller holding no flags is refused manage_pr close: driven through a
// real MCP call, both directions, as a row of PLANTS in test/blast-radius.test.ts.
