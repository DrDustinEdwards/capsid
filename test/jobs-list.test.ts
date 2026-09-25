import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { defaultScopes, type AgentGrant } from "../src/agents-schema.ts";
import type { Agent } from "../src/agents.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// JOBS.LIST RETURNED EVERY SIGNED BODY (AUDIT-2026-09-16.md).
//
// A job body is the executable prompt a driver runs with shell and repo credentials.
// list was SELECT * and returned rows whole, so any caller holding READ on a namespace
// read every prompt queued in it. The body now comes back from claim, and from list
// only when one job is named by id and the caller holds write.

const BODY = "---\ncapsid-task-signature: abc\n---\nthe executable prompt";

const JOB = {
  id: "job_0123456789ab",
  namespace: "capsid",
  title: "a queued job",
  body: BODY,
  priority: 3,
  status: "queued",
  posted_by: "github:someone",
  claimed_by: null,
  claimed_at: null,
  lease_expires: null,
  result_ref: null,
  result_summary: null,
  gate_required: 1,
  review_required: 0,
  required_scopes: null,
  min_record: null,
  blocked_count: 0,
  resumed_count: 0,
  corrections_count: 0,
  created_at: "2026-09-17T00:00:00.000Z",
  updated_at: "2026-09-17T00:00:00.000Z",
};

function caller(grants: AgentGrant[]): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = grants;
  return { id: "agent_x", name: "capsid-reader", kind: "session", actor: "agent:capsid-reader", scopes, admin: false, row: null };
}

async function list(agent: Agent, args: Record<string, unknown>) {
  const d1 = fakeD1({ jobs: [JOB] });
  const server = buildServer(fakeEnv({ DB: d1.db, APP_KV: fakeKv().kv }), agent);
  const client = new Client({ name: "jobs-list", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  const result = (await client.callTool({ name: "jobs", arguments: { action: "list", namespace: "capsid", ...args } })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await client.close();
  await server.close();
  assert.ok(!result.isError, result.content[0].text);
  return { out: JSON.parse(result.content[0].text) as { jobs: Array<Record<string, unknown>> }, reads: d1.reads };
}

test("PLANT: a read-grant caller listing a namespace gets no job body", async () => {
  const { out } = await list(caller(["read"]), {});
  assert.equal(out.jobs.length, 1);
  assert.equal("body" in out.jobs[0], false, "jobs.list handed a read-only caller the signed prompt");
  assert.equal(out.jobs[0].id, JOB.id);
  assert.equal(out.jobs[0].title, JOB.title);
});

test("a write-grant caller listing a whole namespace gets no body either", async () => {
  const { out } = await list(caller(["read", "write"]), {});
  assert.equal("body" in out.jobs[0], false);
});

test("naming one job by id returns its body to a write-grant caller", async () => {
  const { out } = await list(caller(["read", "write"]), { id: JOB.id });
  assert.equal(out.jobs.length, 1);
  assert.equal(out.jobs[0].body, BODY);
});

test("naming one job by id does not return its body to a read-only caller", async () => {
  const { out } = await list(caller(["read"]), { id: JOB.id });
  assert.equal(out.jobs.length, 1);
  assert.equal("body" in out.jobs[0], false);
});
