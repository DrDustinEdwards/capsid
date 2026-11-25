import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server.ts";
import { defaultScopes, type AgentGrant } from "../src/agents-schema.ts";
import type { Agent } from "../src/agents.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// A list that was SELECT * returned every signed job body (an executable prompt) to any READ caller;
// the body now comes only from claim, or from list for one job named by id with write.

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
  result_ref: null,
  result_summary: null,
  gate_required: 1,
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
  return {
    id: "agent_x",
    name: "capsid-reader",
    kind: "session",
    actor: "agent:capsid-reader",
    scopes,
    admin: false,
    row: null,
  };
}

async function list(agent: Agent, args: Record<string, unknown>) {
  const d1 = fakeD1({ jobs: [JOB] });
  const server = buildServer(fakeEnv({ DB: d1.db, APP_KV: fakeKv().kv }), agent);
  const client = new Client({ name: "jobs-list", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  const result = (await client.callTool({
    name: "capsid_work_jobs",
    arguments: { action: "list", namespace: "capsid", ...args },
  })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await client.close();
  await server.close();
  assert.ok(!result.isError, result.content[0].text);
  return {
    out: JSON.parse(result.content[0].text) as { jobs: Array<Record<string, unknown>> },
    reads: d1.reads,
  };
}

test("PLANT: a list returns a job's body only when one job is named by id and the caller holds write", async () => {
  const cases: Array<[AgentGrant[], Record<string, unknown>, boolean]> = [
    [["read"], {}, false],
    [["read", "write"], {}, false],
    [["read"], { id: JOB.id }, false],
    [["read", "write"], { id: JOB.id }, true],
  ];
  for (const [grants, args, hasBody] of cases) {
    const { out } = await list(caller(grants), args);
    assert.equal(out.jobs.length, 1);
    assert.equal(out.jobs[0].id, JOB.id);
    assert.equal(
      "body" in out.jobs[0],
      hasBody,
      `grants ${grants.join("+")} with ${JSON.stringify(args)}: body ${hasBody ? "withheld" : "handed over"}`,
    );
    if (hasBody) assert.equal(out.jobs[0].body, BODY);
  }
});
