import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import { defaultScopes } from "../src/agents-schema.ts";
import { CONTROLS, PORTAL_ACTIONS, performControl, previewControl } from "../src/controls.ts";
import { MODE_KEY } from "../src/improve-schema.ts";
import { buildServer } from "../src/server.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// The controls tool (src/tools/controls.ts) and the registry behind it (src/controls.ts):
// the Portal's buttons as one admin tool, with one confirmation shared by both surfaces.
// The Portal's own routes are test/portal-actions.test.ts and test-integration/.

const EMAIL = "admin@example.com";
const ACTOR = `access:${EMAIL}`;

interface ToolResult {
  isError?: boolean;
  content: Array<{ text: string }>;
}

function world() {
  const d1 = fakeD1({});
  const kv = fakeKv({});
  const env = fakeEnv({ DB: d1.db, APP_KV: kv.kv, COOKIE_ENCRYPTION_KEY: "test-cookie-key", IMPROVE_SCORE_SECRET: "s" });
  return { d1, kv, env };
}

async function connect(env: never, caller: Agent) {
  const server = buildServer(env, caller);
  const client = new Client({ name: "controls-tool", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    call: (args: Record<string, unknown>) => client.callTool({ name: "controls", arguments: args }) as Promise<ToolResult>,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const parse = (r: ToolResult) => JSON.parse(r.content[0].text) as Record<string, unknown>;
const admin = (email = EMAIL) => adminAgentForEmail(email);
const auditRows = (d1: ReturnType<typeof fakeD1>) =>
  d1.recorded.filter((r) => /INSERT INTO audit_log/.test(r.sql)).map((r) => ({ actor: r.params[0] as string, action: r.params[1] as string, params: JSON.parse(String(r.params[4])) as Record<string, unknown> }));

const MODE = { control: "mode", params: { value: "subscription", reason: "run it on the subscription tonight" } };

test("the registry, the Portal's action list and the tool's list name the same controls, in both directions", async () => {
  const { env } = world();
  const { call, close } = await connect(env, admin());
  try {
    const listed = parse(await call({ action: "list" })).controls as Array<{ control: string; params: string[]; reason_required: boolean }>;
    assert.ok(listed.length >= 16, `the list held ${listed.length} controls, so this compared nothing`);
    assert.deepEqual(listed.map((c) => c.control).sort(), [...PORTAL_ACTIONS].sort());
    assert.deepEqual(CONTROLS.map((c) => c.name).sort(), [...PORTAL_ACTIONS].sort());
    const mode = listed.find((c) => c.control === "mode");
    assert.deepEqual([mode?.params, mode?.reason_required], [["value", "reason", "undo"], true]);
    assert.equal(listed.find((c) => c.control === "revoke_agent")?.reason_required, false);
  } finally {
    await close();
  }
});

test("a merge and a mint are not controls, and the tool says so", async () => {
  const { env } = world();
  const { call, close } = await connect(env, admin());
  try {
    for (const control of ["merge", "manage_pr", "mint", "mint_operator_key"]) {
      const res = await call({ action: "preview", control });
      assert.equal(res.isError, true, `${control} was previewed`);
    }
    assert.match((await call({ action: "list" })).content[0].text, /controls/);
  } finally {
    await close();
  }
});

test("preview writes nothing and describes the change; perform runs exactly it, once, and names the admin and the surface", async () => {
  const { env, d1, kv } = world();
  const { call, close } = await connect(env, admin());
  try {
    const previewed = await call({ action: "preview", ...MODE });
    assert.equal(previewed.isError, undefined, previewed.content[0].text);
    const plan = parse(previewed) as { token: string; changes: string[]; audit: string[]; expires_at: string };
    assert.ok(plan.token.length > 40 && plan.changes.length > 0);
    assert.ok(plan.audit.some((line) => line.startsWith("control-mode by ")), `the plan names ${plan.audit.join(" | ")}, not the chat row`);
    assert.deepEqual(d1.recorded, [], "a preview wrote to D1");
    assert.deepEqual(kv.puts, [], "a preview wrote to KV");

    const done = await call({ action: "perform", token: plan.token });
    assert.equal(done.isError, undefined, done.content[0].text);
    assert.equal(parse(done).action, "mode");
    assert.equal(kv.store.get(MODE_KEY), "subscription");

    const rows = auditRows(d1);
    // The mutator's own row names the caller, not the loop, and the click row names the surface.
    assert.ok(rows.some((r) => r.action === "improve-mode-set" && r.actor === ACTOR), JSON.stringify(rows.map((r) => [r.action, r.actor])));
    const click = rows.find((r) => r.action === "control-mode");
    assert.equal(click?.actor, ACTOR);
    assert.equal(click?.params.surface, "chat");
  } finally {
    await close();
  }
});

test("PLANT: a confirmation is spent by its first perform, whichever surface runs it, and a second is refused and writes nothing", async () => {
  const { env, d1, kv } = world();
  const { call, close } = await connect(env, admin());
  try {
    const { token } = parse(await call({ action: "preview", ...MODE })) as { token: string };
    assert.equal((await call({ action: "perform", token })).isError, undefined);
    const rowsAfterFirst = d1.recorded.length;
    const again = await call({ action: "perform", token });
    assert.equal(again.isError, true);
    assert.match(again.content[0].text, /already used/);
    assert.equal(d1.recorded.length, rowsAfterFirst, "a replayed confirmation wrote a row");

    // A token the Portal's door previewed is spent by chat's perform, and then by nobody.
    const portal = await previewControl(env, EMAIL, "mode", MODE.params, new Date(), "portal");
    assert.equal(portal.ok, true);
    if (!portal.ok) return;
    const viaChat = await call({ action: "perform", token: portal.preview.token });
    assert.equal(viaChat.isError, undefined, viaChat.content[0].text);
    const viaPortal = await performControl(env, EMAIL, portal.preview.token, "203.0.113.9", new Date(), "portal");
    assert.deepEqual([viaPortal.ok, viaPortal.ok ? 0 : viaPortal.status], [false, 409]);
    assert.ok(kv.puts.filter((p) => p.key.startsWith("control-nonce:")).length >= 2, "no nonce was kept");
  } finally {
    await close();
  }
});

test("a token is for the administrator it was issued to, and expires", async () => {
  const { env } = world();
  const a = await connect(env, admin(EMAIL));
  const b = await connect(env, admin("other-admin@example.com"));
  try {
    const { token } = parse(await a.call({ action: "preview", ...MODE })) as { token: string };
    const other = await b.call({ action: "perform", token });
    assert.equal(other.isError, true);
    assert.match(other.content[0].text, /issued to another session/);

    const stale = await performControl(env, EMAIL, token, null, new Date(Date.now() + 6 * 60_000 + 1000), "chat");
    assert.deepEqual([stale.ok, stale.ok ? 0 : stale.status], [false, 410]);
  } finally {
    await a.close();
    await b.close();
  }
});

test("a switch without a reason is refused at preview, with the reason it needs", async () => {
  const { env, d1, kv } = world();
  const { call, close } = await connect(env, admin());
  try {
    const res = await call({ action: "preview", control: "mode", params: { value: "off" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /needs a reason/);
    assert.deepEqual([d1.recorded, kv.puts], [[], []]);
    const stray = await call({ action: "preview", control: "mode", params: { value: "off", reason: "x", site: "y" } });
    assert.equal(stray.isError, true, "a param the control does not take was carried");
  } finally {
    await close();
  }
});

test("PLANT: only the administrator signed in through Access holds a control: a driver, a minted admin-shaped agent and an operator key are refused", async () => {
  const { env, d1, kv } = world();
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  const driver: Agent = { id: "agent_0123456789ab", name: "capsid-driver", kind: "driver", actor: "agent:capsid-driver", scopes, admin: false, row: null };
  const operatorKey: Agent = { ...admin(), actor: "opkey:0123456789ab" };
  for (const [who, caller] of [["a driver", driver], ["an operator key", operatorKey]] as const) {
    const { call, close } = await connect(env, caller);
    try {
      for (const args of [{ action: "list" }, { action: "preview", ...MODE }, { action: "perform", token: "x.y" }]) {
        const res = await call(args);
        assert.equal(res.isError, true, `${who} ran ${args.action}: ${res.content[0].text}`);
      }
    } finally {
      await close();
    }
  }
  assert.deepEqual([d1.recorded, kv.puts], [[], []], "a refused caller changed something");
});
