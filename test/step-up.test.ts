import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import { checkScope, needsStepUp, readLastStepUp, STEP_UP, TOOL_GRANTS } from "../src/scope.ts";
import { buildAdminServer } from "../src/server.ts";
import { fakeD1, fakeEnv, fakeKv, type FakeKv } from "./fakes.ts";

// The step-up (src/scope.ts STEP_UP): a risky Capsid Admin action needs an Access
// sign-in or a successful step-up action in the last 2 hours, and never more than 12
// hours after the sign-in, from an OAuth session. A key holder has no session and is not
// stepped up. The refusal comes from checkScope, before the handler runs.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const STALE = 3 * HOUR;
const signedIn = (msAgo: number | null, lastStepUpMsAgo?: number) => {
  const agent = adminAgentForEmail("admin@example.com", msAgo === null ? null : Date.now() - msAgo);
  if (lastStepUpMsAgo !== undefined) agent.lastStepUpAt = Date.now() - lastStepUpMsAgo;
  return agent;
};
const performNeed = { tool: "capsid_admin_run_controls", action: "perform", grant: "write" as const, admin: true, stepUp: true };

async function call(agent: Agent, name: string, args: Record<string, unknown>) {
  const server = buildAdminServer(fakeEnv({ APP_KV: fakeKv({}).kv }), agent);
  const client = new Client({ name: "step-up", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
  } finally {
    await client.close();
  }
}

async function actionsOf(name: string): Promise<string[] | null> {
  const server = buildAdminServer(fakeEnv({ APP_KV: fakeKv({}).kv }), adminAgentForEmail("admin@example.com"));
  const client = new Client({ name: "step-up", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `${name} is not served on Capsid Admin`);
  const action = tool.inputSchema.properties?.action as { enum?: string[] } | undefined;
  return action?.enum ?? null;
}

test("every STEP_UP entry is a served admin tool, and every action it lists is one that tool serves", async () => {
  assert.ok(Object.keys(STEP_UP).length >= 5, "STEP_UP shrank; check it before trusting this test");
  for (const [tool, actions] of Object.entries(STEP_UP)) {
    assert.equal(TOOL_GRANTS[tool], "admin", `${tool} is stepped up and is not an admin tool`);
    const served = await actionsOf(tool);
    if (actions === "*") continue;
    assert.ok(served, `${tool} lists step-up actions and serves no action argument`);
    for (const action of actions) assert.ok(served.includes(action), `${tool}.${action} is stepped up and not served`);
  }
});

test("PLANT: a stale sign-in is refused a risky admin action, naming the reconnect, before its handler runs", async () => {
  const stale = signedIn(STALE);
  const r = await call(stale, "capsid_admin_manage_agents", { action: "mint", name: "sample-driver", kind: "driver", namespaces: ["sample"] });
  assert.equal(r.isError, true);
  assert.match(r.text, /step-up required: 'capsid_admin_manage_agents\.mint'/);
  assert.match(r.text, /Reconnect the Capsid Admin connector/);
  assert.match(r.text, /Nothing was done\./);
});

test("PLANT: a session with no recorded sign-in time is refused, never treated as fresh", async () => {
  const r = await call(signedIn(null), "capsid_admin_set_site_key", { namespace: "sample" });
  assert.equal(r.isError, true);
  assert.match(r.text, /step-up required: 'capsid_admin_set_site_key'/);
  assert.match(r.text, /before sign-in times were recorded/);
});

test("THE INNOCENT DIRECTION: a fresh sign-in passes the step-up", async () => {
  const r = await call(signedIn(MINUTE), "capsid_admin_set_site_key", { namespace: "sample" });
  // The call goes on to its handler, which refuses for want of CF_SECRETS_TOKEN.
  assert.doesNotMatch(r.text, /step-up required/);
  assert.match(r.text, /CF_SECRETS_TOKEN is not set/);
});

test("THE INNOCENT DIRECTION: a stale sign-in still reads; only the risky actions are stepped up", async () => {
  const stale = signedIn(STALE);
  const r = await call(stale, "capsid_admin_manage_agents", { action: "list" });
  assert.doesNotMatch(r.text, /step-up required/);
  assert.equal(needsStepUp("capsid_admin_manage_agents", "list"), false);
  assert.equal(needsStepUp("capsid_admin_read_claims", undefined), false);
  assert.equal(needsStepUp("capsid_admin_whats_next", undefined), false);
});

test("a key holder (no session) is not stepped up: its key is the credential", () => {
  const keyHolder = adminAgentForEmail("admin@example.com");
  assert.equal(keyHolder.signedInAt, undefined);
  assert.equal(checkScope(keyHolder, { tool: "capsid_admin_set_site_key", grant: "write", admin: true, stepUp: true }), null);
  // The same need from a stale session is refused, so the exemption is the key, not the need.
  assert.match(checkScope(signedIn(STALE), { tool: "capsid_admin_set_site_key", grant: "write", admin: true, stepUp: true }) ?? "", /step-up required/);
});

test("PLANT: allowed at 1h59 after sign-in with no other activity", () => {
  assert.equal(checkScope(signedIn(HOUR + 59 * MINUTE), performNeed), null);
});

test("PLANT: refused at 2h01 after sign-in with no activity, naming the rule", () => {
  const refusal = checkScope(signedIn(2 * HOUR + MINUTE), performNeed) ?? "";
  assert.match(refusal, /step-up required: 'capsid_admin_run_controls\.perform'/);
  assert.match(refusal, /within the last 2 hours, and never more than 12 hours after the sign-in/);
  assert.match(refusal, /Nothing was done\./);
});

test("PLANT: allowed at 3h after sign-in when a step-up action succeeded at 1h30", () => {
  assert.equal(checkScope(signedIn(3 * HOUR, 90 * MINUTE), performNeed), null);
});

test("PLANT: refused at 3h when the last step-up action was 2h01 ago", () => {
  assert.match(checkScope(signedIn(3 * HOUR, 2 * HOUR + MINUTE), performNeed) ?? "", /step-up required/);
});

test("PLANT: refused at 12h01 after sign-in even with a step-up action a minute ago", () => {
  const refusal = checkScope(signedIn(12 * HOUR + MINUTE, MINUTE), performNeed) ?? "";
  assert.match(refusal, /step-up required/);
  assert.match(refusal, /past the 12 hour cap/);
  assert.equal(checkScope(signedIn(12 * HOUR - MINUTE, MINUTE), performNeed), null);
});

async function mintAs(agent: Agent, kv: FakeKv, args: Record<string, unknown> = { action: "mint", name: "capsid-driver", kind: "driver", namespaces: ["capsid"] }) {
  const server = buildAdminServer(fakeEnv({ APP_KV: kv.kv, DB: fakeD1({ agents: [] }).db }), agent);
  const client = new Client({ name: "step-up", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name: "capsid_admin_manage_agents", arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
  } finally {
    await client.close();
  }
}

const ACTOR = "access:admin@example.com";
const keyFor = (signedInAt: number) => `step-up:last:${ACTOR}:${signedInAt}`;

test("PLANT: a successful step-up action records its time for this session, with a TTL past the 12 hour cap", async () => {
  const kv = fakeKv();
  const before = Date.now();
  const agent = signedIn(MINUTE);
  const r = await mintAs(agent, kv);
  assert.equal(r.isError, false);
  assert.equal(kv.puts.length, 1);
  assert.equal(kv.puts[0].key, keyFor(agent.signedInAt as number));
  assert.ok(Number(kv.puts[0].value) >= before);
  assert.ok((kv.puts[0].ttl ?? 0) >= 12 * 3600);
  assert.ok((await readLastStepUp(kv.kv, ACTOR, agent.signedInAt as number)) !== undefined);
});

test("PLANT: one session's step-up activity does not keep another session's window open", async () => {
  const kv = fakeKv();
  const active = signedIn(MINUTE);
  assert.equal((await mintAs(active, kv)).isError, false);
  // The same admin's other session, signed in 3 hours ago and idle since.
  const idleSignedInAt = Date.now() - 3 * HOUR;
  assert.equal(await readLastStepUp(kv.kv, ACTOR, idleSignedInAt), undefined);
});

test("PLANT: a refused step-up action and a non-step-up action record nothing", async () => {
  const kv = fakeKv();
  assert.equal((await mintAs(signedIn(STALE), kv)).isError, true);
  assert.equal((await mintAs(signedIn(MINUTE), kv, { action: "list" })).isError, false);
  assert.deepEqual(kv.puts, []);
});

test("PLANT: a step-up action that failed in its handler records nothing", async () => {
  const kv = fakeKv();
  const r = await mintAs(signedIn(MINUTE), kv, { action: "revoke", name: "no-such-agent" });
  assert.doesNotMatch(r.text, /step-up required/);
  assert.deepEqual(kv.puts, []);
});

test("PLANT: a KV write failure is logged and does not fail the action that succeeded", async () => {
  const kv = fakeKv({ failPut: true });
  const r = await mintAs(signedIn(MINUTE), kv);
  assert.equal(r.isError, false);
});

test("PLANT: an unreadable or future last step-up time is treated as absent, never as fresh", async () => {
  const at = 1000;
  assert.equal(await readLastStepUp(fakeKv({ failGet: true }).kv, ACTOR, at), undefined);
  assert.equal(await readLastStepUp(fakeKv({ corrupt: "not a number" }).kv, ACTOR, at), undefined);
  assert.equal(await readLastStepUp(fakeKv().kv, ACTOR, at), undefined);
  assert.equal(await readLastStepUp(fakeKv({ seed: { [keyFor(at)]: "1234" } }).kv, ACTOR, at, 5000), 1234);
  assert.equal(await readLastStepUp(fakeKv({ seed: { [keyFor(at)]: "9999" } }).kv, ACTOR, at, 5000), undefined, "a time after now widened the window");
});
