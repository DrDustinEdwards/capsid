import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { adminAgent } from "../src/agents.ts";
import { operatorIdentity, sha256Hex } from "../src/auth.ts";
import { improveControl } from "../src/improve-run.ts";
import { buildServer } from "../src/server.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// improve_run's mint_operator_key action. Moved here from test/public-docs.test.ts,
// which now holds only the docs/ hygiene guards.

function mintEnv(existing?: string) {
  return fakeEnv({
    DB: fakeD1({}).db,
    APP_KV: fakeKv({}).kv,
    ...(existing === undefined ? {} : { OPERATOR_KEY_HASH: existing }),
  });
}

test("PLANT: mint_operator_key returns a READ-ONLY key, and the prefix is what makes it one", async () => {
  const result = await improveControl(mintEnv(""), "mint_operator_key", {});
  assert.equal(result.action, "mint_operator_key");
  if (result.action !== "mint_operator_key") return;
  assert.match(result.key, /^capsid_[0-9a-f]{64}$/, "32 bytes of entropy, and recognisable as one of ours");
  assert.equal(result.grant, "read-only");
  assert.equal(result.entry, `ro:${result.hash}`, "the tier lives on the LIST ENTRY, not on the key");

  // THE ASSERTION THAT MATTERS. The label on this response is a claim; resolving
  // the minted key through the real verifier is the check. Getting the prefix
  // backwards (onto the key instead of the entry) mints a WRITE key from a helper
  // whose whole purpose is the read-only tier, and every assertion above would
  // still pass.
  const request = new Request("https://capsid.test/ops/mcp", { headers: { Authorization: `Bearer ${result.key}` } });
  const identity = await operatorIdentity(request, { OPERATOR_KEY_HASH: result.entry });
  assert.equal(identity.grant, "read", "the minted key must resolve to the read-only tier through the real verifier");

  // And the negative: the same key listed WITHOUT the prefix is a write key, so the
  // prefix alone decides the tier.
  const asWrite = await operatorIdentity(request, { OPERATOR_KEY_HASH: result.hash });
  assert.equal(asWrite.grant, "write", "a bare hash entry is the write tier; that is the thing the prefix opts out of");
});

test("PLANT: the mint does not install the key, and says why", async () => {
  const before = "aa".repeat(32);
  const env = mintEnv(before);
  const result = await improveControl(env, "mint_operator_key", {});
  if (result.action !== "mint_operator_key") throw new Error("wrong action");

  // The secret is untouched. A Worker that can widen its own authorization list
  // does not have one, and every guard downstream of it inherits that.
  assert.equal(
    (env as unknown as { OPERATOR_KEY_HASH: string }).OPERATOR_KEY_HASH,
    before,
    "the mint must not modify OPERATOR_KEY_HASH itself"
  );
  assert.match(result.next_step, /does NOTHING until its hash is in OPERATOR_KEY_HASH/);
  assert.match(result.next_step, /widen its own authorization list/);
  assert.match(result.command, /wrangler secret put OPERATOR_KEY_HASH/);
  // The printed command carries the EXISTING hashes plus the new one, so pasting
  // it does not revoke every other key.
  assert.ok(result.command.includes(before), "the printed list must preserve the hashes already installed");
  assert.ok(result.command.includes(result.entry), "and add the new one, with its read-only prefix");
  assert.equal(result.already_listed, false);
});

test("PLANT: the key is returned once and never written anywhere the key could read", async () => {
  const { db, recorded } = fakeD1({});
  const env = fakeEnv({ DB: db, APP_KV: fakeKv({}).kv, OPERATOR_KEY_HASH: "" });
  const result = await improveControl(env, "mint_operator_key", {});
  if (result.action !== "mint_operator_key") throw new Error("wrong action");

  const written = recorded.map((r) => JSON.stringify(r.params)).join("\n");
  assert.ok(!written.includes(result.key), "the KEY reached a database row");
  // And not the hash either. OPERATOR_KEY_HASH is the verifier, so a hash in
  // audit_log would copy the verifier into a table this very key can read.
  assert.ok(!written.includes(result.hash), "the HASH reached a database row; that is the verifier");
  assert.ok(written.includes("operator-key-minted"), "the mint must still leave an audit row saying it happened");
  assert.ok(written.includes(result.hash.slice(0, 8)), "with a fingerprint, so two mints are distinguishable");
});

test("two mints are different keys", async () => {
  const a = await improveControl(mintEnv(""), "mint_operator_key", {});
  const b = await improveControl(mintEnv(""), "mint_operator_key", {});
  if (a.action !== "mint_operator_key" || b.action !== "mint_operator_key") throw new Error("wrong action");
  assert.notEqual(a.key, b.key);
  assert.equal(await sha256Hex(a.key), a.hash, "the reported hash is really the hash of the reported key");
});

test("the mint is a control action on the existing tool, not a new tool", async () => {
  // CLAUDE.md, tool surface rule: the surface stays small. The tool count is asserted against the
  // served tools in test/counts.test.ts; this checks the mint is an action of
  // improve_run rather than a tool of its own.
  const server = buildServer(fakeEnv({ APP_KV: fakeKv({}).kv }), adminAgent("DrDustinEdwards"));
  const client = new Client({ name: "improve-run-mint", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  assert.equal(tools.some((tool) => tool.name.includes("mint")), false, "the mint became a tool of its own");
  const action = tools.find((tool) => tool.name === "improve_run")?.inputSchema.properties?.action as { enum?: string[] } | undefined;
  assert.ok(action?.enum?.includes("mint_operator_key"), "improve_run does not serve the mint_operator_key action");
});
