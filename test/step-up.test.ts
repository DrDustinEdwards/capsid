import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import { checkScope, guardRegistrations, needsStepUp, STEP_UP, STEP_UP_MAX_MS, STEP_UP_WINDOW_MS, TOOL_GRANTS } from "../src/scope.ts";
import { buildAdminServer } from "../src/server.ts";
import { readLastStepUp, recordStepUp } from "../src/step-up.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// The step-up (src/scope.ts STEP_UP): a risky Capsid Admin action needs an Access
// sign-in or a step-up action in the last 2 hours (each step-up action resets that clock),
// and never more than 12 hours after the sign-in, from an OAuth session. A key holder has no session and
// is not stepped up. The refusal comes from checkScope, before the handler runs.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const signedIn = (msAgo: number | null, lastActionMsAgo: number | null = null): Agent => ({
  ...adminAgentForEmail("admin@example.com", msAgo === null ? null : Date.now() - msAgo),
  lastStepUpAt: lastActionMsAgo === null ? null : Date.now() - lastActionMsAgo,
});

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
  const stale = signedIn(STEP_UP_WINDOW_MS + MINUTE);
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
  const stale = signedIn(STEP_UP_WINDOW_MS + MINUTE);
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
  assert.match(checkScope(signedIn(STEP_UP_WINDOW_MS + MINUTE), { tool: "capsid_admin_set_site_key", grant: "write", admin: true, stepUp: true }) ?? "", /step-up required/);
});

const need = { tool: "capsid_admin_run_controls", action: "perform", grant: "write" as const, admin: true, stepUp: true };

test("the window edge: allowed at 1h59 after sign-in, refused at 2h01 with no activity", () => {
  assert.equal(checkScope(signedIn(2 * HOUR - MINUTE), need), null);
  assert.match(checkScope(signedIn(2 * HOUR + MINUTE), need) ?? "", /step-up required/);
});

test("a step-up action slides the window: allowed at 3h when an action happened at 1h30", () => {
  assert.equal(checkScope(signedIn(3 * HOUR, 90 * MINUTE), need), null);
  // The action itself is stale: 1h30 ago is 3h after sign-in only if the action was at 1h30; at 2h01 since it, refused.
  assert.match(checkScope(signedIn(5 * HOUR, 2 * HOUR + MINUTE), need) ?? "", /step-up required/);
});

test("the cap: refused at 12h01 after sign-in even with activity a minute ago", () => {
  assert.equal(checkScope(signedIn(12 * HOUR - MINUTE, MINUTE), need), null);
  assert.match(checkScope(signedIn(STEP_UP_MAX_MS + MINUTE, MINUTE), need) ?? "", /step-up required/);
});

test("the refusal states the rule", () => {
  const text = checkScope(signedIn(STEP_UP_MAX_MS + MINUTE, MINUTE), need) ?? "";
  assert.match(text, /last 2 hours/);
  assert.match(text, /never more than 12 hours after the sign-in/);
});

test("a successful step-up action records the reset, a failed one does not", async () => {
  const { kv, puts } = fakeKv({});
  const agent = signedIn(MINUTE);
  const server = buildAdminServer(fakeEnv({ APP_KV: kv }), agent);
  const client = new Client({ name: "step-up", version: "1.0.0" });
  const [c, sv] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sv), client.connect(c)]);
  const r = (await client.callTool({ name: "capsid_admin_set_site_key", arguments: { namespace: "sample" } })) as { isError?: boolean };
  await client.close();
  // The handler refuses for want of CF_SECRETS_TOKEN, so no reset is recorded.
  assert.equal(r.isError, true);
  assert.equal(puts.some((p) => p.key.startsWith("step-up:last:")), false);
  await recordStepUp(kv, agent.actor, 1000, 123);
  assert.equal(await readLastStepUp(kv, agent.actor, 1000), 123);
  // Another session's reset (a different sign-in) does not count.
  assert.equal(await readLastStepUp(kv, agent.actor, 2000), null);
});

test("the registrar records a reset after a successful step-up action, not after an error, a read or a key holder", async () => {
  const run = async (agent: Agent, tool: string, args: Record<string, unknown>, result: { isError?: boolean }) => {
    let guarded: ((...a: unknown[]) => unknown) | undefined;
    const stub = { registerTool: (_n: string, _c: unknown, h: (...a: unknown[]) => unknown) => (guarded = h), server: { getClientVersion: () => null } };
    let resets = 0;
    guardRegistrations(stub as never, agent, undefined, async () => void resets++);
    (stub.registerTool as (n: string, c: unknown, h: unknown) => unknown)(tool, { inputSchema: { action: {} } }, async () => result);
    await guarded?.(args);
    return resets;
  };
  const mint = { action: "mint", name: "sample-driver", kind: "driver", namespaces: ["sample"] };
  assert.equal(await run(signedIn(MINUTE), "capsid_admin_manage_agents", mint, {}), 1);
  assert.equal(await run(signedIn(MINUTE), "capsid_admin_manage_agents", mint, { isError: true }), 0);
  assert.equal(await run(signedIn(MINUTE), "capsid_admin_manage_agents", { action: "list" }, {}), 0);
  assert.equal(await run(signedIn(STEP_UP_WINDOW_MS + MINUTE), "capsid_admin_manage_agents", mint, {}), 0);
});
