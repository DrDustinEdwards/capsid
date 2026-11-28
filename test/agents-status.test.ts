import assert from "node:assert/strict";
import { test } from "node:test";
import { capsidStatus } from "../src/status.ts";

import { defaultScopes, serializeScopes } from "../src/agents-schema.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2 } from "./fakes.ts";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";

async function statusEnv(agents: Array<Record<string, unknown>>) {
  const d1 = fakeD1({ agents });
  return fakeEnv({
    DB: d1.db,
    APP_KV: fakeKv({}).kv,
    MEDIA: fakeR2().bucket,
    HOLDOUT: fakeR2().bucket,
  });
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

test("capsid_read_status action status carries the agent inventory, never a key or the stored verifier", async () => {
  const env = await statusEnv([
    await row("capsid-driver", { last_seen: "2026-09-11 02:00:00" }),
    await row("sample-driver"),
  ]);
  const status = await capsidStatus(env);
  const capsid = status.agents?.find((a) => a.name === "capsid-driver");
  assert.ok(capsid, "the capsid driver is missing from the report");
  assert.equal(capsid.last_seen, "2026-09-11 02:00:00");
  assert.equal(capsid.kind, "driver");
  assert.deepEqual(capsid.namespaces, ["capsid"]);
  const serialized = JSON.stringify(status.agents);
  assert.ok(
    !serialized.includes(await sha256Hex("capsid-driver")),
    "the stored verifier was handed out",
  );
  assert.ok(!/capsid_agent_/.test(serialized), "something shaped like a key was handed out");
});
