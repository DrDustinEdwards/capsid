import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../src/auth.ts";
import { defaultScopes, serializeScopes } from "../src/agents-schema.ts";
import { resolveAgent, type Agent } from "../src/agents.ts";
import { checkScope, guardRegistrations } from "../src/scope.ts";
import { fakeD1, fakeEnv } from "./fakes.ts";

// capsid/research/design-seat-session-hardening.md, section 2b. A runner key is bound
// to one job: it resolves only while that job is live for it, and it may work that job
// and no other. A key that outlives its job is a credential nobody is using, and one
// that could claim a second job is a runner deciding its own work.

const KEY = "capsid_runner_" + "b".repeat(64);
const JOB = "job_0123456789ab";
const OTHER = "job_ba9876543210";
const NOW = new Date("2026-09-27T12:00:00.000Z");
const NAME = `runner-${JOB}-1`;

async function envWith(job: Record<string, unknown> | null, row: Record<string, unknown> = {}, env: Record<string, unknown> = {}) {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  const d1 = fakeD1({
    agents: [
      {
        id: "agent_aaaaaaaaaaaa",
        name: NAME,
        kind: "session",
        key_hash: await sha256Hex(KEY),
        scopes: serializeScopes(scopes),
        created_by: "github:dustin",
        created_at: "2026-09-27 11:55:00",
        revoked_at: null,
        last_seen: null,
        job_id: JOB,
        ...row,
      },
    ],
    jobs: job ? [{ id: JOB, namespace: "capsid", title: "t", body: "b", status: "claimed", claimed_by: `agent:${NAME}`, lease_expires: "2026-09-27T15:00:00.000Z", ...job }] : [],
  });
  return fakeEnv({ DB: d1.db, ...env });
}

const bearer = () => new Request("https://capsid.example/ops/mcp", { headers: { Authorization: `Bearer ${KEY}` } });

test("a bound key resolves while its job is claimed by it under a live lease, and carries the binding", async () => {
  const resolved = await resolveAgent(bearer(), await envWith({}), NOW);
  assert.ok(resolved, "a bound key on a live claim did not resolve");
  assert.equal(resolved.agent.job, JOB);
});

test("a bound key stops resolving when its job is no longer live for it", async () => {
  const dead: Array<[string, Record<string, unknown> | null]> = [
    ["lease expired", { lease_expires: "2026-09-27T11:59:59.000Z" }],
    ["claimed by another agent", { claimed_by: "agent:capsid-driver" }],
    ["blocked", { status: "blocked", lease_expires: null }],
    ["done", { status: "done", lease_expires: null }],
    ["failed", { status: "failed", lease_expires: null }],
    ["job missing", null],
  ];
  for (const [why, job] of dead) {
    assert.equal(await resolveAgent(bearer(), await envWith(job), NOW), null, `a bound key resolved with its job ${why}`);
  }
});

test("a bound key on a queued job resolves only within the pending-start window", async () => {
  const queued = { status: "queued", claimed_by: null, lease_expires: null };
  assert.ok(await resolveAgent(bearer(), await envWith(queued), NOW), "a fresh key on a queued job did not resolve");
  const stale = await envWith(queued, { created_at: "2026-09-27 11:30:00" });
  assert.equal(await resolveAgent(bearer(), stale, NOW), null, "a key minted 30 minutes ago still resolved on a queued job");
});

test("a dead bound key does not fall through to the operator tier", async () => {
  const env = await envWith({ status: "done", lease_expires: null }, {}, { OPERATOR_KEY_HASH: await sha256Hex(KEY) });
  assert.equal(await resolveAgent(bearer(), env, NOW), null);
});

function bound(job: string | null): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  return { id: "agent_aaaaaaaaaaaa", name: NAME, kind: "session", actor: `agent:${NAME}`, scopes, admin: false, row: null, job };
}

test("a bound key may work its own job and no other", () => {
  const agent = bound(JOB);
  for (const action of ["claim", "heartbeat", "complete", "fail", "block", "resume"]) {
    assert.equal(checkScope(agent, { tool: "jobs", action, jobId: JOB }), null, `${action} on its own job was refused`);
    assert.match(checkScope(agent, { tool: "jobs", action, jobId: OTHER }) ?? "", /bound to job/, `${action} on another job was allowed`);
  }
  assert.match(checkScope(agent, { tool: "jobs", action: "claim" }) ?? "", /bound to job/, "a claim naming no job was allowed");
});

test("a bound key cannot post, start, release or supersede, even on its own job", () => {
  const agent = bound(JOB);
  for (const action of ["post", "start", "release", "supersede"]) {
    assert.match(checkScope(agent, { tool: "jobs", action, jobId: JOB }) ?? "", /bound to job/, `${action} was allowed`);
  }
});

test("a bound key may list, but not name another job in the list", () => {
  const agent = bound(JOB);
  assert.equal(checkScope(agent, { tool: "jobs", action: "list" }), null);
  assert.equal(checkScope(agent, { tool: "jobs", action: "list", jobId: JOB }), null);
  assert.match(checkScope(agent, { tool: "jobs", action: "list", jobId: OTHER }) ?? "", /bound to job/);
});

test("an unbound key is not narrowed by the binding check", () => {
  assert.equal(checkScope(bound(null), { tool: "jobs", action: "claim", jobId: OTHER }), null);
  assert.equal(checkScope(bound(null), { tool: "jobs", action: "claim" }), null);
});

test("the registrar passes the job id, so the binding holds before the handler runs", async () => {
  let ran = 0;
  const server = { registerTool: (_n: string, _c: unknown, h: (...a: unknown[]) => unknown) => h };
  guardRegistrations(server as never, bound(JOB));
  const handler = (server.registerTool as unknown as (n: string, c: unknown, h: () => unknown) => (a: unknown) => unknown)(
    "jobs",
    { inputSchema: { action: {}, id: {}, namespace: {} } },
    () => {
      ran++;
      return { ok: true };
    }
  );
  const refused = (await handler({ action: "claim", namespace: "capsid", id: OTHER })) as { isError?: boolean; content?: Array<{ text: string }> };
  assert.equal(refused.isError, true, "a claim of another job reached the handler");
  assert.match(refused.content?.[0]?.text ?? "", /bound to job/);
  assert.equal(ran, 0);
  await handler({ action: "claim", namespace: "capsid", id: JOB });
  assert.equal(ran, 1, "a claim of its own job did not reach the handler");
});
