import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { defaultScopes } from "../src/agents-schema.ts";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import { OPS_SNAPSHOT_KEY, RING_SLOTS, ringReading, ringSlot, type OpsSnapshot, type SiteSnapshot } from "../src/ops-snapshot.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// ops_snapshot: the watcher's last pass over MCP, admin only (TOOL_GRANTS), and one
// site's uptime ring read by slot or by time (ringReading in src/ops-snapshot.ts).

const NOW = new Date("2026-09-28T12:10:00.000Z");
const SLOT = ringSlot(NOW);
const HALF_HOUR = 30 * 60_000;

// Oldest first: up, up, down, no pass. The newest slot (0) is the last character.
const SITE: SiteSnapshot = {
  namespace: "sample",
  name: "Sample",
  origin: "https://sample.example.com",
  health_path: "/health",
  platform: "cloudflare",
  state: "ok",
  http_status: 200,
  latency_ms: 40,
  sha: null,
  error: null,
  checked_at: NOW.toISOString(),
  ring: "110-",
  ring_slot: SLOT,
};

const SNAPSHOT: OpsSnapshot = {
  version: 1,
  pass_at: NOW.toISOString(),
  pass_ms: 900,
  cadence_min: 30,
  checks: [{ id: "health", state: "clear", findings: [] }],
  health: null,
  mirror: null,
  ci: [],
  site_map: null,
  sites: [SITE],
};

// The ring

test("slot 0 is the newest slot, and each slot names the half hour it covers", () => {
  const values = [0, 1, 2, 3].map((slot) => ringReading(SITE, { slot }));
  assert.deepEqual(
    values.map((v) => (typeof v === "string" ? v : v.value)),
    ["no-pass", "down", "up", "up"]
  );
  const newest = values[0];
  assert.ok(typeof newest !== "string");
  assert.equal(newest.from, new Date(SLOT * HALF_HOUR).toISOString());
  assert.equal(newest.to, new Date((SLOT + 1) * HALF_HOUR).toISOString());
  assert.ok(Date.parse(newest.from) <= NOW.getTime() && NOW.getTime() < Date.parse(newest.to), "slot 0 does not cover the pass");
});

test("a slot older than the ring's history reads outside-ring, never up", () => {
  const reading = ringReading(SITE, { slot: 4 });
  assert.ok(typeof reading !== "string");
  assert.equal(reading.value, "outside-ring");
  assert.equal(reading.mark, null);
});

test("at reads the slot whose half hour holds that time", () => {
  const reading = ringReading(SITE, { at: new Date(NOW.getTime() - HALF_HOUR) });
  assert.ok(typeof reading !== "string");
  assert.equal(reading.slot, 1);
  assert.equal(reading.value, "down");
});

test("REFUSES a slot or time outside the ring, a time after its newest slot, and a non-time", () => {
  assert.match(String(ringReading(SITE, { slot: RING_SLOTS })), /outside it/);
  assert.match(String(ringReading(SITE, { at: new Date(NOW.getTime() - RING_SLOTS * HALF_HOUR) })), /outside it/);
  assert.match(String(ringReading(SITE, { at: new Date(NOW.getTime() + 2 * HALF_HOUR) })), /after the newest slot/);
  assert.match(String(ringReading(SITE, { at: new Date("not a time") })), /not a time/);
});

// The tool

interface ToolResult {
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function connect(caller: Agent, seed: Record<string, string> = { [OPS_SNAPSHOT_KEY]: JSON.stringify(SNAPSHOT) }) {
  const server = buildServer(fakeEnv({ APP_KV: fakeKv({ seed }).kv }), caller);
  const client = new Client({ name: "ops-snapshot-tool", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    call: (args: Record<string, unknown>) => client.callTool({ name: "ops_snapshot", arguments: args }) as Promise<ToolResult>,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const admin = () => adminAgentForEmail("admin@example.com");
const parse = (result: ToolResult) => JSON.parse(result.content[0].text) as Record<string, unknown>;

test("the admin reads the whole snapshot, one site, and one ring slot", async () => {
  const { call, close } = await connect(admin());
  try {
    const whole = await call({});
    assert.equal(whole.isError, undefined, whole.content[0].text);
    assert.deepEqual(parse(whole), SNAPSHOT as unknown as Record<string, unknown>);

    const one = parse(await call({ site: "sample" }));
    assert.equal(one.pass_at, SNAPSHOT.pass_at);
    assert.equal((one.site as SiteSnapshot).ring, "110-");

    const slot = parse(await call({ site: "sample", slot: 1 }));
    assert.equal(slot.value, "down");
    assert.equal(slot.slot, 1);
    assert.equal(slot.pass_at, SNAPSHOT.pass_at);

    const at = parse(await call({ site: "sample", at: new Date(NOW.getTime() - 2 * HALF_HOUR).toISOString() }));
    assert.equal(at.value, "up");
  } finally {
    await close();
  }
});

test("REFUSES slot or at without site, slot with at, and a site the snapshot does not hold", async () => {
  const { call, close } = await connect(admin());
  try {
    for (const [args, why] of [
      [{ slot: 0 }, /need site/],
      [{ at: NOW.toISOString() }, /need site/],
      [{ site: "sample", slot: 0, at: NOW.toISOString() }, /not both/],
      [{ site: "missing" }, /holds no site 'missing'. It holds: sample/],
    ] as Array<[Record<string, unknown>, RegExp]>) {
      const result = await call(args);
      assert.equal(result.isError, true, `${JSON.stringify(args)} answered: ${result.content[0].text}`);
      assert.match(result.content[0].text, why);
    }
  } finally {
    await close();
  }
});

test("an absent or unreadable snapshot is a named error, not an empty result", async () => {
  for (const seed of <Record<string, string>[]>[{}, { [OPS_SNAPSHOT_KEY]: JSON.stringify({ ...SNAPSHOT, version: 2 }) }, { [OPS_SNAPSHOT_KEY]: "{not json" }]) {
    const { call, close } = await connect(admin(), seed);
    try {
      const result = await call({});
      assert.equal(result.isError, true, result.content[0].text);
      assert.match(result.content[0].text, /no readable snapshot at ops:snapshot/);
    } finally {
      await close();
    }
  }
});

test("PLANT: a write-grant driver is refused ops_snapshot by the registrar, naming admin", async () => {
  const scopes = defaultScopes(["sample"]);
  scopes.grants = ["read", "write"];
  const driver: Agent = {
    id: "agent_0123456789ab",
    name: "sample-driver",
    kind: "driver",
    actor: "agent:sample-driver",
    scopes,
    admin: false,
    row: null,
  };
  const { call, close } = await connect(driver);
  try {
    for (const args of [{}, { site: "sample" }, { site: "sample", slot: 0 }]) {
      const result = await call(args);
      assert.equal(result.isError, true, `a driver read the snapshot: ${result.content[0].text}`);
      assert.match(result.content[0].text, /admin/i);
      assert.equal(result.content[0].text.includes("110-"), false, "the refusal carried snapshot data");
    }
  } finally {
    await close();
  }
});
