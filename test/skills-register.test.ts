import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { defaultScopes } from "../src/agents-schema.ts";
import { adminAgent, type Agent } from "../src/agents.ts";
import { checkScope, needFor, requiredForAction } from "../src/scope.ts";
import { registerSkill, type SkillRegistration } from "../src/skills-register.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// REGISTERING A CANDIDATE SKILL BY HAND. Before this, the only INSERT into
// improve_skills was recordSkill, reached only from a kept improve attempt. The first
// test pins that, so a third creator cannot appear without this file noticing.

interface Stmt {
  sql: string;
  params: unknown[];
}

interface World {
  job?: { id: string; namespace: string; status: string } | null;
  outcome?: { prs_merged: number | null; ci_green: number | null } | null;
  abstractedFrom?: { id: string; status: string } | null;
  idTaken?: boolean;
}

function fakeDb(world: World) {
  const batches: Stmt[][] = [];
  const answer = (sql: string): unknown => {
    const flat = sql.replace(/\s+/g, " ");
    if (/FROM jobs WHERE id/.test(flat)) return world.job ?? null;
    if (/FROM job_outcomes WHERE job_id/.test(flat)) return world.outcome ?? null;
    if (/FROM improve_skills WHERE source_job/.test(flat)) return world.abstractedFrom ?? null;
    if (/FROM improve_skills WHERE id/.test(flat)) return world.idTaken ? { id: "taken" } : null;
    if (/FROM namespaces WHERE namespace/.test(flat)) return { repos: JSON.stringify([{ repo: "o/r", label: "primary" }]) };
    return null;
  };
  const db = {
    prepare(sql: string) {
      const make = (params: unknown[]) => ({
        sql,
        params,
        bind: (...next: unknown[]) => make(next),
        first: async () => answer(sql),
        all: async () => ({ results: [] }),
        run: async () => ({ meta: {} }),
      });
      return make([]);
    },
    batch: async (stmts: Stmt[]) => {
      batches.push(stmts.map((s) => ({ sql: s.sql, params: s.params })));
      return [];
    },
  };
  return { db, batches };
}

const DONE_JOB = { id: "job_000000000001", namespace: "sample", status: "done" };
const VERIFIED = { prs_merged: 1, ci_green: 1 };

function input(over: Partial<SkillRegistration> = {}): SkillRegistration {
  return {
    id: "reproduce-before-fixing",
    title: "Reproduce the failure before fixing it",
    trigger_condition: "A task reports that a guard or test is broken.",
    termination_test: "The failure was observed red before the fix and green after.",
    composition_interface: "Takes a reported defect; hands on a reproduction and a fix.",
    namespaces: null,
    body: "Lorem ipsum dolor sit amet.\n",
    source_job: DONE_JOB.id,
    ...over,
  };
}

function world(over: World = {}) {
  const fake = fakeDb({ job: DONE_JOB, outcome: VERIFIED, ...over });
  return { ...fake, env: fakeEnv({ DB: fake.db }) };
}

// ---- the claim this change rests on ------------------------------------------------

// ---- what it writes ------------------------------------------------------------------

test("a verified job registers one candidate at version 1, with the namespace taken from the job", async () => {
  const { env, batches } = world();
  const result = await registerSkill(env, "github:admin", input({ namespaces: ["sample"] }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(batches.length, 1, "the document, the row and the audit row go in one batch");

  const [batch] = batches;
  const row = batch.find((s) => /INSERT INTO improve_skills/.test(s.sql));
  assert.ok(row, "no improve_skills row was written");
  assert.match(row.sql, /'candidate', 1/, "a registered skill starts candidate at version 1");
  assert.doesNotMatch(row.sql, /ON CONFLICT/, "a duplicate id must abort the batch, not overwrite a row");
  assert.deepEqual(row.params, [
    "reproduce-before-fixing",
    "sample",
    "Reproduce the failure before fixing it",
    "improve/skills/reproduce-before-fixing.md",
    DONE_JOB.id,
    "A task reports that a guard or test is broken.",
    '["sample"]',
    "The failure was observed red before the fix and green after.",
    "Takes a reported defect; hands on a reproduction and a fix.",
  ]);

  const doc = batch.find((s) => /INSERT INTO documents/.test(s.sql));
  assert.ok(doc, "the instruction body must be written as a document");
  assert.deepEqual(doc.params.slice(0, 2), ["capsid", "improve/skills/reproduce-before-fixing.md"]);

  const audits = batch.filter((s) => /INSERT INTO audit_log/.test(s.sql));
  assert.equal(audits.length, 2, "one audit row for the document and one for the registration");
  for (const audit of audits) assert.equal(audit.params[0], "github:admin", "the audit row must name the caller, not the loop");
  const registered = audits.find((s) => s.params[1] === "skill-registered");
  assert.ok(registered);
  assert.equal(JSON.parse(String(registered.params[4])).source_job, DONE_JOB.id);
});

test("null namespaces is stored as NULL, meaning any namespace", async () => {
  const { env, batches } = world();
  assert.equal((await registerSkill(env, "github:admin", input())).ok, true);
  const row = batches[0].find((s) => /INSERT INTO improve_skills/.test(s.sql));
  assert.equal(row?.params[6], null);
});

// ---- what it refuses, and that a refusal writes nothing ---------------------------------

const REFUSALS: Array<{ what: string; world?: World; input?: Partial<SkillRegistration>; reason: RegExp }> = [
  { what: "an id with capitals or spaces", input: { id: "Reproduce It" }, reason: /skill id/ },
  { what: "an empty trigger condition", input: { trigger_condition: "  " }, reason: /trigger_condition is empty/ },
  { what: "an empty body", input: { body: "" }, reason: /body is empty/ },
  { what: "an empty namespace list", input: { namespaces: [] }, reason: /empty list/ },
  { what: "a job that does not exist", world: { job: null }, reason: /no job/ },
  { what: "a job still claimed", world: { job: { ...DONE_JOB, status: "claimed" } }, reason: /not done/ },
  { what: "a job with no outcome row", world: { outcome: null }, reason: /not fully verified/ },
  { what: "a job that merged nothing", world: { outcome: { prs_merged: 0, ci_green: 1 } }, reason: /not fully verified/ },
  { what: "a job whose CI was red", world: { outcome: { prs_merged: 1, ci_green: 0 } }, reason: /not fully verified/ },
  { what: "a job that already produced a retired skill", world: { abstractedFrom: { id: "old", status: "retired" } }, reason: /already produced skill old \(retired\)/ },
  { what: "an id already registered", world: { idTaken: true }, reason: /already registered/ },
];

for (const r of REFUSALS) {
  test(`refuses ${r.what}, and writes nothing`, async () => {
    const { env, batches } = world(r.world);
    const result = await registerSkill(env, "github:admin", input(r.input));
    assert.equal(result.ok, false, `${r.what} was registered`);
    assert.match(result.ok ? "" : result.error, r.reason);
    assert.equal(batches.length, 0, "a refusal must not write");
  });
}

// ---- admin only ------------------------------------------------------------------------

function driver(): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  return { id: "agent_0123456789ab", name: "capsid-driver", kind: "driver", actor: "agent:capsid-driver", scopes, admin: false, row: null };
}

test("register_skill takes improve_run's admin default in the scope table", () => {
  assert.equal(requiredForAction("improve_run", "register_skill"), "admin");
  const refusal = checkScope(driver(), {
    tool: "improve_run",
    action: "register_skill",
    namespace: "capsid",
    ...needFor(requiredForAction("improve_run", "register_skill")),
  });
  assert.match(refusal ?? "", /admin only/);
});

interface ToolResult {
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function callAs(caller: Agent, fake: ReturnType<typeof fakeDb>): Promise<ToolResult> {
  const env = fakeEnv({ DB: fake.db, APP_KV: fakeKv({ seedToken: true }).kv });
  const server = buildServer(env, caller);
  const client = new Client({ name: "skills-register", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = (await client.callTool({
    name: "improve_run",
    arguments: { action: "register_skill", namespace: "capsid", skill: input() },
  })) as ToolResult;
  await client.close();
  await server.close();
  return result;
}

test("PLANT: a driver calling register_skill over a real connection is refused and nothing is written", async () => {
  const fake = fakeDb({ job: DONE_JOB, outcome: VERIFIED });
  const result = await callAs(driver(), fake);
  assert.equal(result.isError, true, `a driver registered a skill: ${result.content[0]?.text}`);
  assert.match(result.content[0].text, /admin only/);
  assert.equal(fake.batches.length, 0, "the refusal came after a write");
});

test("the admin making the same call registers the skill", async () => {
  const fake = fakeDb({ job: DONE_JOB, outcome: VERIFIED });
  const result = await callAs(adminAgent("DrDustinEdwards"), fake);
  assert.notEqual(result.isError, true, result.content[0]?.text);
  assert.equal(JSON.parse(result.content[0].text).skill.status, "candidate");
  assert.equal(fake.batches.length, 1);
});
