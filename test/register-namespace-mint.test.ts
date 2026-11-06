import assert from "node:assert/strict";
import { test } from "node:test";
import { driverMintInstruction } from "../src/agents-schema.ts";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildAdminServer } from "../src/server.ts";
import { adminAgentForEmail } from "../src/agents.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// capsid_admin_manage_namespaces action "register" returns the mint instruction and
// does not mint. Minting is gated on agent.admin so that an agent cannot widen itself;
// registering is admin-only because the mapping it edits is the authorization
// boundary, but it still must not mint.

test("capsid_admin_manage_namespaces register registers, mints nothing, and returns the mint instruction", async () => {
  const d1 = fakeD1({});
  const server = buildAdminServer(
    fakeEnv({ DB: d1.db, APP_KV: fakeKv({}).kv }),
    adminAgentForEmail("admin@example.com"),
  );
  const client = new Client({ name: "register-mint", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = (await client.callTool({
    name: "capsid_admin_manage_namespaces",
    arguments: { action: "register", namespace: "sample", repo: "owner/sample" },
  })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await client.close();
  assert.notEqual(result.isError, true, result.content[0]?.text);
  const body = JSON.parse(result.content[0].text) as { driver_agent: unknown; next: string };
  assert.equal(body.driver_agent, null, "the response no longer states that nothing was minted");
  assert.equal(
    body.next,
    driverMintInstruction("sample"),
    "register no longer returns the mint instruction",
  );
  const writes = d1.recorded.map((r) => r.sql);
  assert.ok(
    writes.some((sql) => /INSERT INTO namespaces/.test(sql)),
    "the namespace row was not written",
  );
  assert.deepEqual(
    writes.filter((sql) => /INTO agents\b/.test(sql)),
    [],
    "register wrote to the agents table",
  );
});
