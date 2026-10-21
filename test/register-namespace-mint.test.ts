import assert from "node:assert/strict";
import { test } from "node:test";
import { driverAgentName, driverKeyPath, driverMintInstruction } from "../src/agents-schema.ts";
import { keyPath, parseArgs, selectAgents } from "../scripts/mint-agents.ts";
import { sep } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildAdminServer } from "../src/server.ts";
import { adminAgentForEmail } from "../src/agents.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// capsid_admin_manage_namespaces action "register" returns the mint command and does
// not mint. Minting is gated on agent.admin so that an agent cannot widen itself;
// registering is admin-only because the mapping it edits is the authorization
// boundary, but it still must not mint.

test("capsid_admin_manage_namespaces register registers, mints nothing, and returns the mint instruction", async () => {
  const d1 = fakeD1({});
  const server = buildAdminServer(fakeEnv({ DB: d1.db, APP_KV: fakeKv({}).kv }), adminAgentForEmail("admin@example.com"));
  const client = new Client({ name: "register-mint", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = (await client.callTool({ name: "capsid_admin_manage_namespaces", arguments: { action: "register", namespace: "sample", repo: "owner/sample" } })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await client.close();
  assert.notEqual(result.isError, true, result.content[0]?.text);
  const body = JSON.parse(result.content[0].text) as { driver_agent: unknown; next: string };
  assert.equal(body.driver_agent, null, "the response no longer states that nothing was minted");
  assert.equal(body.next, driverMintInstruction("sample"), "register no longer returns the mint instruction");
  const writes = d1.recorded.map((r) => r.sql);
  assert.ok(writes.some((sql) => /INSERT INTO namespaces/.test(sql)), "the namespace row was not written");
  assert.deepEqual(writes.filter((sql) => /INTO agents\b/.test(sql)), [], "register wrote to the agents table");
});

test("the instruction it prints is parseable by the script it names", () => {
  // The tool must not tell a human to run a flag the script does not have. Both
  // halves are derived rather than retyped.
  const instruction = driverMintInstruction("txasm");
  const match = instruction.match(/node scripts\/mint-agents\.ts ([^.]+)\./);
  assert.ok(match, `no runnable command found in: ${instruction}`);
  const argv = match[1].trim().split(/\s+/);
  const parsed = parseArgs(argv);
  assert.equal(parsed.apply, true, "the printed command would only dry run");
  assert.equal(parsed.namespace, "txasm");
});

test("the path it names is the path the script writes", () => {
  for (const ns of ["txasm", "foxing", "capsid"]) {
    const named = driverKeyPath(ns);
    assert.equal(named, `~/.capsid/agent-${ns}-driver.key`);
    // Same file, expressed absolutely by the script. Compare the tail, since one
    // side is tilde-relative by design (it goes in front of a human).
    const absolute = keyPath(driverAgentName(ns)).split(sep).join("/");
    assert.ok(absolute.endsWith(named.slice(1)), `${absolute} is not ${named}`);
  }
});

test("a roster namespace's instruction selects exactly that one agent", () => {
  // Ties the three together: the name register would use, the selector
  // the script parses, and the agent the script would actually mint.
  const found = driverMintInstruction("foxing").match(/mint-agents[.]ts ([^.]+)[.]/);
  assert.ok(found, "the instruction carries no runnable command");
  const parsed = parseArgs(found[1].trim().split(/\s+/));
  const picked = selectAgents(parsed.namespace);
  assert.deepEqual(picked.map((a) => a.name), [driverAgentName("foxing")]);
});
