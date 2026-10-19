import assert from "node:assert/strict";
import { test } from "node:test";
import { capsidStatus } from "../src/status.ts";
import { sha256Hex } from "../src/auth.ts";
import { defaultScopes, serializeScopes } from "../src/agents-schema.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2 } from "./fakes.ts";

// The agent inventory is in capsid_run_improve action status, which a session calls at the start of a
// run and the console renders, so last_seen is seen by someone who can act on it.

async function statusEnv(agents: Array<Record<string, unknown>>) {
  const d1 = fakeD1({ agents });
  return fakeEnv({ DB: d1.db, APP_KV: fakeKv({}).kv, MEDIA: fakeR2().bucket, HOLDOUT: fakeR2().bucket });
}

async function row(name: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `agent_${name.slice(0, 12).padEnd(12, "0")}`,
    name,
    kind: "driver",
    key_hash: await sha256Hex(name),
    scopes: serializeScopes(defaultScopes([name.replace("-driver", "")])),
    created_by: "github:DrDustinEdwards",
    created_at: "2026-09-11 00:00:00",
    revoked_at: null,
    last_seen: null,
    ...overrides,
  };
}

test("capsid_run_improve action status carries the agent inventory, with last_seen", async () => {
  const env = await statusEnv([
    await row("capsid-driver", { last_seen: "2026-09-11 02:00:00" }),
    await row("foxing-driver"),
  ]);
  const status = await capsidStatus(env);
  assert.ok(Array.isArray(status.agents), "capsid_run_improve action status does not report the agents");
  const capsid = status.agents.find((a) => a.name === "capsid-driver");
  assert.ok(capsid, "the capsid driver is missing from the report");
  assert.equal(capsid.last_seen, "2026-09-11 02:00:00");
  assert.equal(capsid.kind, "driver");
  assert.deepEqual(capsid.namespaces, ["capsid"], "the report does not say what an agent may reach");
});

test("the report names the flags an agent HOLDS, not all six with a boolean beside each", async () => {
  // A row of six falses per agent hides the one agent holding can_merge.
  const scopes = defaultScopes(["*"]);
  scopes.grants = ["read", "write"];
  scopes.flags.can_merge = true;
  const env = await statusEnv([await row("seat", { kind: "seat", scopes: serializeScopes(scopes) })]);
  const status = await capsidStatus(env);
  const seat = (status.agents ?? []).find((a) => a.name === "seat");
  assert.ok(seat);
  assert.deepEqual(seat.flags, ["can_merge"]);
  const drivers = await capsidStatus(await statusEnv([await row("capsid-driver")]));
  assert.deepEqual((drivers.agents ?? [])[0].flags, [], "a driver holding nothing should report nothing rather than six falses");
});

test("a revoked agent is reported as revoked rather than dropped", async () => {
  // Dropping it makes "revoked" and "never existed" look the same.
  const env = await statusEnv([await row("old-laptop", { revoked_at: "2026-09-10 12:00:00" })]);
  const status = await capsidStatus(env);
  assert.equal((status.agents ?? []).length, 1);
  assert.equal((status.agents ?? [])[0].revoked_at, "2026-09-10 12:00:00");
});

test("the report never carries a key or the stored verifier", async () => {
  const env = await statusEnv([await row("capsid-driver")]);
  const status = await capsidStatus(env);
  const serialized = JSON.stringify(status.agents);
  assert.ok(!serialized.includes(await sha256Hex("capsid-driver")), "capsid_run_improve action status handed out the stored verifier");
  assert.ok(!/capsid_agent_/.test(serialized), "capsid_run_improve action status carries something shaped like a key");
});

test("a Worker with no agents yet reports an empty inventory rather than failing", async () => {
  // The state of a deployment until the mint commands are run by hand.
  const status = await capsidStatus(await statusEnv([]));
  assert.deepEqual(status.agents, []);
});

// The auto-merge safety meter (src/merge-safety.ts) rides on capsid_run_improve action status from the
// report the tick keeps, so asking costs one KV read.

test("capsid_run_improve action status carries the auto-merge safety meter, null before the first pass, and a scoped caller sees its own namespaces", async () => {
  const empty = await capsidStatus(await statusEnv([]));
  assert.equal(empty.merge_safety, null);
  const row = (namespace: string, paused: { since: string; reason: string } | null) => ({ namespace, auto_merged: 3, approved: 1, deploys_verified: 4, rolled_back: 1, rollback_failed: 0, reverts: 1, bad_auto_7d: 2, paused });
  const report = { generated: "2026-10-11T12:00:00.000Z", namespaces: [row("capsid", { since: "2026-10-11T11:00:00.000Z", reason: "2 rolled back" }), row("carrel", null)] };
  const kv = fakeKv({ seed: { "merge-safety:report": JSON.stringify(report) } });
  const env = fakeEnv({ DB: fakeD1({ agents: [] }).db, APP_KV: kv.kv, MEDIA: fakeR2().bucket, HOLDOUT: fakeR2().bucket });
  const status = await capsidStatus(env);
  assert.deepEqual(status.merge_safety, report);
  const scoped = await capsidStatus(env, undefined, { namespaces: ["carrel"], admin: false });
  assert.deepEqual(scoped.merge_safety?.namespaces.map((n) => n.namespace), ["carrel"]);
});
