import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildAdminServer } from "../src/server.ts";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import {
  OPS_SNAPSHOT_KEY,
  RING_SLOTS,
  ringReading,
  ringSlot,
  type OpsSnapshot,
  type SiteSnapshot,
} from "../src/ops-snapshot.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

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
  offaccount: null,
  ci: [],
  site_map: null,
  sites: [SITE],
};

test("slot 0 is the newest half hour, at picks the slot holding that time, and a slot past the history is outside-ring", () => {
  const values = [0, 1, 2, 3, 4].map((slot) => ringReading(SITE, { slot }));
  assert.deepEqual(
    values.map((v) => (typeof v === "string" ? v : v.value)),
    ["no-pass", "down", "up", "up", "outside-ring"],
  );
  const newest = values[0];
  assert.ok(typeof newest !== "string");
  assert.equal(newest.from, new Date(SLOT * HALF_HOUR).toISOString());
  assert.equal(newest.to, new Date((SLOT + 1) * HALF_HOUR).toISOString());
  assert.ok(Date.parse(newest.from) <= NOW.getTime() && NOW.getTime() < Date.parse(newest.to));
  const outside = values[4];
  assert.equal(typeof outside !== "string" && outside.mark, null);
  const at = ringReading(SITE, { at: new Date(NOW.getTime() - HALF_HOUR) });
  assert.ok(typeof at !== "string");
  assert.deepEqual([at.slot, at.value], [1, "down"]);
});

test("REFUSES a slot or time outside the ring, a time after its newest slot, and a non-time", () => {
  assert.match(String(ringReading(SITE, { slot: RING_SLOTS })), /outside it/);
  assert.match(
    String(ringReading(SITE, { at: new Date(NOW.getTime() - RING_SLOTS * HALF_HOUR) })),
    /outside it/,
  );
  assert.match(
    String(ringReading(SITE, { at: new Date(NOW.getTime() + 2 * HALF_HOUR) })),
    /after the newest slot/,
  );
  assert.match(String(ringReading(SITE, { at: new Date("not a time") })), /not a time/);
});

interface ToolResult {
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function connect(
  caller: Agent,
  seed: Record<string, string> = { [OPS_SNAPSHOT_KEY]: JSON.stringify(SNAPSHOT) },
) {
  const server = buildAdminServer(fakeEnv({ APP_KV: fakeKv({ seed }).kv }), caller);
  const client = new Client({ name: "ops-snapshot-tool", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    call: (args: Record<string, unknown>) =>
      client.callTool({
        name: "capsid_admin_read_ops",
        arguments: { action: "snapshot", ...args },
      }) as Promise<ToolResult>,
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

    assert.equal(parse(await call({ site: "sample", slot: 1 })).value, "down");
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
      assert.equal(
        result.isError,
        true,
        `${JSON.stringify(args)} answered: ${result.content[0].text}`,
      );
      assert.match(result.content[0].text, why);
    }
  } finally {
    await close();
  }
});

test("an absent or unreadable snapshot is a named error, not an empty result", async () => {
  const seeds: Record<string, string>[] = [
    {},
    { [OPS_SNAPSHOT_KEY]: JSON.stringify({ ...SNAPSHOT, version: 2 }) },
    { [OPS_SNAPSHOT_KEY]: "{not json" },
  ];
  for (const seed of seeds) {
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
