import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server.ts";
import { CORE_CAP_BYTES, RULE_DOC_CAP_BYTES, ruleDocCap, ruleDocProblem, ruleDocWriteRefusal, staleToolNames } from "../src/rule-docs.ts";
import { buildTruthReport, type ReportDoc } from "../src/truth-report.ts";
import { TOOL_GRANTS } from "../src/scope.ts";
import { fakeD1, fakeEnv, type FakeD1Options } from "./fakes.ts";

// The rule documents' two checks (src/rule-docs.ts, job_c13dc0d4f22f): the cap
// (conventions 10.2 and 10.3) and stale tool names. Each is planted and seen red here; the
// maintenance query runs against real D1 in test-integration/maintenance.test.ts.

test("which documents are rule documents, and their caps", () => {
  const rules: Array<[string, string, number]> = [
    ["sample", "core.md", CORE_CAP_BYTES],
    ["sample", "decisions.md", RULE_DOC_CAP_BYTES],
    ["sample", "decisions-vol-2.md", RULE_DOC_CAP_BYTES],
    ["capsid", "conventions.md", RULE_DOC_CAP_BYTES],
    ["capsid", "conventions-web.md", RULE_DOC_CAP_BYTES],
    ["capsid", "repo-structure.md", RULE_DOC_CAP_BYTES],
    ["capsid", "schema.md", RULE_DOC_CAP_BYTES],
    ["capsid", "seat-operations.md", RULE_DOC_CAP_BYTES],
    ["capsid", "rulings/testing-2026-10-04.md", RULE_DOC_CAP_BYTES],
  ];
  const records: Array<[string, string]> = [
    ["capsid", "archive/decisions-vol-7.md"],
    ["capsid", "research/design-mcp-servers.md"],
    ["capsid", "reports/lint-2026-09-12.md"],
    ["capsid", "audits/CLOSED-2026-09.md"],
    ["capsid", "jobs/job_0123456789ab.md"],
    ["capsid", "rulings/old/one.md"],
    ["sample", "conventions.md"],
    ["sample", "schema.md"],
  ];
  for (const [ns, path, cap] of rules) assert.equal(ruleDocCap(ns, path), cap, `${ns}/${path}`);
  for (const [ns, path] of records) assert.equal(ruleDocCap(ns, path), null, `${ns}/${path} is a record, not a rule document`);
});

test("PLANT: an oversize rule document is a problem, and one byte under its cap is not", () => {
  const over = "x".repeat(RULE_DOC_CAP_BYTES + 1);
  const p = ruleDocProblem("capsid", "decisions.md", over);
  assert.ok(p?.oversize, "a decisions log one byte over 20KB passed the cap check");
  assert.equal(ruleDocProblem("capsid", "decisions.md", "x".repeat(RULE_DOC_CAP_BYTES)), null);
  assert.ok(ruleDocProblem("sample", "core.md", "x".repeat(CORE_CAP_BYTES + 1))?.oversize, "core.md over 8KB passed");
  // Bytes, not characters: 7,000 two-byte characters are 14,000 bytes.
  assert.ok(ruleDocProblem("sample", "core.md", "é".repeat(7000))?.oversize, "the cap counted characters, not bytes");
  assert.equal(ruleDocProblem("capsid", "research/big.md", over), null, "a record is not held to the rule cap");
});

test("PLANT: each stale tool reference is found, and served names are not", () => {
  const stale = [
    "Use the `register_namespace` tool to add one.", // an old tool in a span
    "Call `jobs.post` with the body.", // an old tool.action
    "1. `lint(namespace)` returns the packet.", // an old call
    "a merge stays with manage_pr behind can_merge", // an old name outside backticks
    "ask `capsid_jobs` for the queue", // a capsid_ name the Worker does not serve
    "`capsid_work_jobs` action `approve`", // a served tool with an action it does not take
    "`capsid_read_repo.read_file`", // the same, dotted
  ];
  for (const line of stale) assert.equal(staleToolNames(line).length, 1, `not found: ${line}`);
  const clean = [
    "Use `capsid_admin_manage_namespaces` action `register`.",
    "Call `capsid_work_jobs` action `post`, then `capsid_find_docs`.",
    "`capsid_change_repo` (actions `write_file` and `create_branch`)",
    "the `write` grant, the `jobs` table, `jobs.claimed_by`",
    "`capsid_close_pr` action `delete_branch`",
    "the capsid-driver agent and capsid/decisions.md",
    "```sql\nSELECT jobs.status FROM jobs;\nregister_namespace(x)\n```",
    "Each write(s) is snapshotted, and list(s) are bounded.",
    "The health route reports `capsid_sha`; the Portal sets capsid_portal_csrf.",
  ];
  for (const text of clean) assert.deepEqual(staleToolNames(text), [], `false positive: ${text}`);
  assert.equal(staleToolNames("then manage_pr(...) it, and manage_pr again").length, 2, "a call and a bare name are two references, not three");
  // Derived both ways: every served tool reads clean, and each one with a typo does not.
  for (const tool of Object.keys(TOOL_GRANTS)) {
    assert.deepEqual(staleToolNames(`call \`${tool}\``), [], tool);
    assert.equal(staleToolNames(`call \`${tool}x\``).length, 1, `${tool}x read as served`);
  }
});

test("a write may cut an over-cap document or leave an old stale name, never make either worse", () => {
  const big = "x".repeat(RULE_DOC_CAP_BYTES + 100);
  assert.match(ruleDocWriteRefusal("capsid", "decisions.md", null, big) ?? "", /over the 20480-byte cap/, "creating an over-cap document");
  assert.match(ruleDocWriteRefusal("capsid", "decisions.md", big, `${big}y`) ?? "", /larger than/, "growing an over-cap document");
  assert.equal(ruleDocWriteRefusal("capsid", "decisions.md", big, big.slice(10)), null, "a cut that is still over the cap");
  const old = "a merge stays with manage_pr.\n";
  assert.equal(ruleDocWriteRefusal("capsid", "schema.md", old, `${old}A new line.\n`), null, "an append beside an old stale name");
  assert.match(ruleDocWriteRefusal("capsid", "schema.md", old, `${old}Call \`jobs.post\`.\n`) ?? "", /does not serve/, "a second stale name");
  assert.equal(ruleDocWriteRefusal("capsid", "research/notes.md", null, `${big} manage_pr`), null, "a record");
  assert.equal(ruleDocWriteRefusal("sample", "core.md", "Call `jobs` here. one", "Call `jobs` here. two"), null, "an edit elsewhere on a line that already held a stale name");
});

test("the truth report names both checks, judged over the rule documents only", () => {
  const doc = (path: string, body: string): ReportDoc => ({ path, type: "note", status: "published", title: "t", body, updated_at: "2026-10-10 00:00:00" });
  const report = buildTruthReport({
    namespace: "capsid",
    now: new Date("2026-10-11T00:00:00Z"),
    docs: [doc("decisions.md", "x".repeat(RULE_DOC_CAP_BYTES + 1)), doc("schema.md", "Use `register_namespace`."), doc("conventions.md", "fine"), doc("research/r.md", "manage_pr")],
    edges: [],
    danglingEdges: [],
    countClaims: [],
  });
  const caps = report.checks.find((c) => c.check === "rule_doc_caps")!;
  const names = report.checks.find((c) => c.check === "stale_tool_names")!;
  assert.equal(caps.subjects, 3, "three rule documents, the research note is a record");
  assert.deepEqual(caps.findings.map((f) => f.subject), ["capsid/decisions.md"]);
  assert.deepEqual(names.findings.map((f) => f.subject), ["capsid/schema.md"]);
});

// The write tool, over a real MCP connection.

async function connect(opts: FakeD1Options) {
  const { db, recorded } = fakeD1(opts);
  const server = buildServer(fakeEnv({ DB: db }), "write", "github:dustin");
  const client = new Client({ name: "rule-docs-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, recorded, close: () => client.close() };
}
const call = async (client: Client, args: Record<string, unknown>) =>
  (await client.callTool({ name: "capsid_write_doc", arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
const namespaces = [{ namespace: "capsid", repos: JSON.stringify([{ repo: "o/r", label: "primary" }]) }];

test("PLANT: capsid_write_doc refuses a stale tool name in a rule document and writes nothing", async () => {
  const { client, recorded, close } = await connect({ namespaces, documents: [{ namespace: "capsid", path: "schema.md", title: "Schema", body: "clean", type: "procedural" }] });
  try {
    const out = await call(client, { namespace: "capsid", path: "schema.md", mode: "append", body: "\nUse the `register_namespace` tool." });
    assert.equal(out.isError, true, "a stale tool name reached a rule document");
    assert.match(out.content[0].text, /rule document .*does not serve/);
    assert.equal(recorded.length, 0, "a refused write still touched the store");
    const fine = await call(client, { namespace: "capsid", path: "schema.md", mode: "append", body: "\nUse `capsid_admin_manage_namespaces` action `register`." });
    assert.equal(fine.isError ?? false, false, fine.content[0].text);
  } finally {
    await close();
  }
});

test("PLANT: capsid_write_doc refuses to grow a rule document past its cap, and allows a record to", async () => {
  const { client, recorded, close } = await connect({ namespaces, documents: [{ namespace: "capsid", path: "decisions.md", title: "Log", body: "x".repeat(RULE_DOC_CAP_BYTES - 10), type: "decision" }] });
  try {
    const out = await call(client, { namespace: "capsid", path: "decisions.md", mode: "append", body: "y".repeat(100) });
    assert.equal(out.isError, true, "the decisions log grew past 20KB");
    assert.match(out.content[0].text, /over the 20480-byte cap.*next volume/);
    assert.equal(recorded.length, 0);
    const record = await call(client, { namespace: "capsid", path: "research/long.md", title: "Long", body: "z".repeat(RULE_DOC_CAP_BYTES * 2) });
    assert.equal(record.isError ?? false, false, record.content[0].text);
  } finally {
    await close();
  }
});

test("a move of a rule document to a volume, and a restore that recreates one, put back what was held", async () => {
  const big = "x".repeat(RULE_DOC_CAP_BYTES + 100);
  const moved = await connect({ namespaces, documents: [
      { namespace: "capsid", path: "decisions.md", title: "Log", body: `${big}\nmanage_pr`, type: "decision" },
      { namespace: "capsid", path: "research/big.md", title: "Old design", body: "a merge stays with manage_pr", type: "spec" },
    ],
  });
  try {
    const out = (await moved.client.callTool({ name: "capsid_write_doc", arguments: { action: "move", namespace: "capsid", path: "decisions.md", new_path: "decisions-vol-9.md", confirm: true } })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(out.isError ?? false, false, out.content[0].text);
    const onto = (await moved.client.callTool({ name: "capsid_write_doc", arguments: { action: "move", namespace: "capsid", path: "research/big.md", new_path: "schema.md", confirm: true } })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.ok(onto.isError, "a record moved onto a rule path is held to the checks");
    assert.match(onto.content[0].text, /rule document .*does not serve/);
  } finally {
    await moved.close();
  }
});
