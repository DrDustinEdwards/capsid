import assert from "node:assert/strict";
import { test } from "node:test";

import { SCOPE_FLAGS, defaultScopes, serializeScopes } from "../src/agents-schema.ts";
import { adminAgentForEmail, grantAgent, resolveAgent } from "../src/agents.ts";
import { fakeD1, fakeEnv } from "./fakes.ts";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";

// A bearer resolves to a caller, not to a tier, so the audit log can say whose
// credential did a write: a minted agent carries exactly the scopes its row says.

const KEY = "capsid_agent_" + "a".repeat(64);

async function envWithAgent(
  overrides: Record<string, unknown> = {},
  rowOverrides: Record<string, unknown> = {},
) {
  const key_hash = await sha256Hex(KEY);
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  const d1 = fakeD1({
    agents: [
      {
        id: "agent_0123456789ab",
        name: "capsid-driver",
        kind: "driver",
        key_hash,
        scopes: serializeScopes(scopes),
        created_by: "github:dustin",
        created_at: "2026-09-11 00:00:00",
        revoked_at: null,
        last_seen: null,
        ...rowOverrides,
      },
    ],
  });
  return { d1, env: fakeEnv({ DB: d1.db, ...overrides }) };
}

const bearer = (key: string) =>
  new Request("https://capsid.example/ops/mcp", { headers: { Authorization: `Bearer ${key}` } });

test("a minted key resolves to its agent row, with that row's scopes and audit identity", async () => {
  const { env } = await envWithAgent();
  const resolved = await resolveAgent(bearer(KEY), env);
  assert.ok(resolved, "the minted key did not resolve");
  assert.equal(resolved.agent.name, "capsid-driver");
  assert.equal(resolved.agent.kind, "driver");
  assert.equal(resolved.agent.id, "agent_0123456789ab");
  assert.equal(resolved.agent.actor, "agent:capsid-driver", "the audit actor is the agent name");
  assert.deepEqual(resolved.agent.scopes.namespaces, ["capsid"]);
  assert.equal(
    resolved.agent.admin,
    false,
    "a minted agent is never admin: it cannot mint another",
  );
  for (const flag of SCOPE_FLAGS) assert.equal(resolved.agent.scopes.flags[flag], false);
});

test("a revoked agent does not resolve", async () => {
  const { env } = await envWithAgent({}, { revoked_at: "2026-09-11 01:00:00" });
  assert.equal(await resolveAgent(bearer(KEY), env), null);
});

test("no bearer, or a bearer nothing knows, resolves to nothing at all", async () => {
  const { env } = await envWithAgent();
  assert.equal(await resolveAgent(new Request("https://capsid.example/ops/mcp"), env), null);
  assert.equal(await resolveAgent(bearer("not-a-key"), env), null);
});

test("an OAuth admin session is the synthetic agent named admin, holding every scope", () => {
  const agent = adminAgentForEmail("admin@example.com");
  assert.equal(agent.name, "admin");
  assert.equal(
    agent.actor,
    "access:admin@example.com",
    "the email is more specific than the synthetic name, so the audit row keeps it",
  );
  assert.equal(agent.scopes.namespaces, "*");
  assert.equal(agent.scopes.tools, "*");
  assert.deepEqual(agent.scopes.grants, ["read", "write"]);
  for (const flag of SCOPE_FLAGS) assert.equal(agent.scopes.flags[flag], true);
  assert.equal(agent.admin, true);
});

test("resolving touches last_seen, and does it off the answer rather than inside it", async () => {
  const { d1, env } = await envWithAgent();
  const resolved = await resolveAgent(bearer(KEY), env);
  assert.ok(resolved);
  assert.equal(d1.recorded.length, 0, "resolution must not commit anything on its own");
  await resolved.touch();
  const update = d1.recorded.find((r) => /UPDATE agents SET last_seen/i.test(r.sql));
  assert.ok(update, "touch() did not update last_seen");
  assert.equal(
    update.params[0],
    "agent_0123456789ab",
    "last_seen was written against the wrong row",
  );
});

test("the legacy grant vocabulary still builds a caller, which is what keeps the tests and the fallback honest", () => {
  const write = grantAgent("write", "test:guard");
  assert.deepEqual(write.scopes.grants, ["read", "write"]);
  assert.equal(write.actor, "test:guard");
  const read = grantAgent("read", "test:ro");
  assert.deepEqual(read.scopes.grants, ["read"]);
  for (const flag of SCOPE_FLAGS) assert.equal(read.scopes.flags[flag], false);
});
