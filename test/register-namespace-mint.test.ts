import assert from "node:assert/strict";
import { test } from "node:test";
import { driverAgentName, driverKeyPath, driverMintInstruction } from "../src/agents-schema.ts";
import { keyPath, parseArgs, selectAgents } from "../scripts/mint-agents.mjs";
import { TOOL_GRANTS } from "../src/scope.ts";
import { sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { adminAgent } from "../src/agents.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// register_namespace RETURNS THE MINT COMMAND AND DOES NOT MINT (2026-09-11).
//
// The seam this closed: register_namespace took a plain "write" grant, which every
// driver agent holds, while minting is gated on agent.admin so that an agent cannot
// widen itself. Minting inside register would have handed any driver a fresh write
// credential for a namespace of its choosing.
//
// THE PREMISE CHANGED ON 2026-09-13, and this test is how that was noticed. The
// tripwire below used to assert register_namespace was "write", with a comment
// saying whoever changed it should be told by a test rather than discover it in a
// review. It worked exactly that way.
//
// What changed: register_namespace and update_namespace are now admin-only, because
// the mapping they edit IS the authorization boundary. A driver could remap its own
// namespace onto any repo the App reaches and, with a repos axis of "*", read and
// write it. So the 2026-09-11 reasoning is narrower than it looked: keeping the mint
// out of register was necessary and not sufficient, since register could still point
// a namespace at a repo of the caller's choosing without minting anything.
//
// The rest of this file is unchanged and still necessary: register_namespace
// must still not mint, because admin-gating the tool does not make minting inside it
// a good idea.

test("the premise MOVED: register_namespace is admin, and still does not mint", () => {
  assert.equal(TOOL_GRANTS.register_namespace, "admin");
  assert.equal(TOOL_GRANTS.update_namespace, "admin");
  // `agents` was gated in its handler, with "write" here, until 2026-09-16. The admin
  // gate on minting now lives in the table like these two, and the handler no longer
  // repeats it. Named exactly via sourceFile(): a find() over the walk matches
  // top-level src/agents.ts first, which is a different file.
  assert.equal(TOOL_GRANTS.agents, "admin", "the admin gate on minting is gone from the table");
  // That no handler decides admin for itself is asserted once, for every handler, in
  // test/route-gates.test.ts.
});

test("register_namespace registers, mints nothing, and returns the mint instruction", async () => {
  const d1 = fakeD1({});
  const server = buildServer(fakeEnv({ DB: d1.db, APP_KV: fakeKv({}).kv }), adminAgent("DrDustinEdwards"));
  const client = new Client({ name: "register-mint", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = (await client.callTool({ name: "register_namespace", arguments: { namespace: "sample", repo: "owner/sample" } })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await client.close();
  assert.notEqual(result.isError, true, result.content[0]?.text);
  const body = JSON.parse(result.content[0].text) as { driver_agent: unknown; next: string };
  assert.equal(body.driver_agent, null, "the response no longer states that nothing was minted");
  assert.equal(body.next, driverMintInstruction("sample"), "register_namespace no longer returns the mint instruction");
  const writes = d1.recorded.map((r) => r.sql);
  assert.ok(writes.some((sql) => /INSERT INTO namespaces/.test(sql)), "the namespace row was not written");
  assert.deepEqual(writes.filter((sql) => /agents/.test(sql)), [], "register_namespace wrote to the agents table");
});

test("the instruction it prints is parseable by the script it names", () => {
  // The failure this prevents: the tool tells a human to run a flag the script
  // does not have. Both halves are derived rather than retyped.
  const instruction = driverMintInstruction("txasm");
  const match = instruction.match(/node scripts\/mint-agents\.mjs ([^.]+)\./);
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
  // Ties the three together: the name register_namespace would use, the selector
  // the script parses, and the agent the script would actually mint.
  const found = driverMintInstruction("foxing").match(/mint-agents[.]mjs ([^.]+)[.]/);
  assert.ok(found, "the instruction carries no runnable command");
  const parsed = parseArgs(found[1].trim().split(/\s+/));
  const picked = selectAgents(parsed.namespace);
  assert.deepEqual(picked.map((a) => a.name), [driverAgentName("foxing")]);
});
