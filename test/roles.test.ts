import assert from "node:assert/strict";
import { test } from "node:test";
import { ROLES } from "../scripts/roles.ts";
import {
  SCOPE_FLAGS,
  allowsToolAction,
  defaultScopes,
  parseScopes,
  serializeScopes,
} from "../src/agents-schema.ts";
import { type Agent } from "../src/agents.ts";
import { checkScope } from "../src/scope.ts";
import { buildServer } from "../src/server.ts";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// "Write a document and nothing else" is an action inside one tool, so a tools entry may be
// qualified (`capsid_write_doc.write`) and the registrar checks the qualified name.

function scopedAgent(mutate: (scopes: ReturnType<typeof defaultScopes>) => void = () => {}): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  mutate(scopes);
  return {
    id: "agent_aaaaaaaaaaaa",
    name: "t",
    kind: "driver",
    actor: "agent:t",
    scopes,
    admin: false,
    row: null,
  };
}

test("a wildcard axis and an unqualified tool entry allow every action", () => {
  assert.equal(allowsToolAction("*", "capsid_write_doc", "write"), true);
  assert.equal(allowsToolAction("*", "capsid_write_doc", undefined), true);
  const list = ["capsid_write_doc", "capsid_read_doc"];
  assert.equal(allowsToolAction(list, "capsid_write_doc", "write"), true);
  assert.equal(allowsToolAction(list, "capsid_write_doc", "move"), true);
  assert.equal(allowsToolAction(list, "capsid_read_doc", undefined), true);
});

test("naming ONE action narrows the tool to the actions named, and the rest are refused", () => {
  const list = ["capsid_write_doc", "capsid_write_doc.write"];
  assert.equal(allowsToolAction(list, "capsid_write_doc", "write"), true);
  assert.equal(
    allowsToolAction(list, "capsid_write_doc", "move"),
    false,
    "a qualified entry that did not narrow would be decoration",
  );
  assert.equal(allowsToolAction(list, "capsid_write_doc", "restore"), false);
  assert.equal(allowsToolAction(list, "capsid_write_doc", "archive"), false);
});

test("a qualified entry narrows only its own tool, and a tool absent from the list is refused", () => {
  const list = ["capsid_write_doc", "capsid_write_doc.write", "capsid_lint_namespace"];
  assert.equal(allowsToolAction(list, "capsid_lint_namespace", "gather"), true);
  assert.equal(allowsToolAction(list, "capsid_lint_namespace", "finalize"), true);
  assert.equal(allowsToolAction(list, "capsid_close_pr", "close"), false);
  assert.equal(allowsToolAction(list, "capsid_close_pr", undefined), false);
  assert.equal(
    allowsToolAction([], "capsid_write_doc", "write"),
    false,
    "an empty list is the fail-closed value and must allow nothing",
  );
});

test("the qualified name is what a scopes column round-trips, so the narrowing survives storage", () => {
  const scopes = defaultScopes(["capsid"]);
  scopes.tools = ["capsid_write_doc", "capsid_write_doc.write"];
  const back = parseScopes(serializeScopes(scopes));
  assert.deepEqual(back.tools, ["capsid_write_doc", "capsid_write_doc.write"]);
});

test("checkScope refuses an action the tools axis narrowed away, and names the action", () => {
  const writer = scopedAgent((s) => {
    s.namespaces = "*";
    s.tools = ["capsid_write_doc", "capsid_write_doc.write"];
  });
  assert.equal(
    checkScope(writer, {
      tool: "capsid_write_doc",
      action: "write",
      namespace: "capsid",
      grant: "write",
    }),
    null,
  );

  const refusal = checkScope(writer, {
    tool: "capsid_write_doc",
    action: "move",
    namespace: "capsid",
    grant: "write",
  });
  assert.match(
    String(refusal),
    /capsid_write_doc\.move/,
    "a refusal that does not name the action leaves the caller guessing which half failed",
  );
  assert.match(
    String(refusal),
    /capsid_write_doc, capsid_write_doc\.write/,
    "a refusal that does not say what the scope IS costs a round trip",
  );
});

test("the lint tool asks the enforcement point about the qualified name", async () => {
  // The action must reach the check. An agent narrowed to capsid_lint_namespace.gather is
  // called through the real tool with two modes.
  const gatherer = scopedAgent((s) => {
    s.namespaces = "*";
    s.tools = ["capsid_lint_namespace", "capsid_lint_namespace.gather"];
  });
  const server = buildServer(fakeEnv({ DB: fakeD1({}).db, APP_KV: fakeKv({}).kv }), gatherer);
  const client = new Client({ name: "roles", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (mode: string) =>
    (
      (await client.callTool({
        name: "capsid_lint_namespace",
        arguments: { mode, namespace: "capsid" },
      })) as { content: Array<{ text: string }> }
    ).content[0]?.text ?? "";
  const reported = await call("report");
  const gathered = await call("gather");
  await client.close();
  assert.match(
    reported,
    /capsid_lint_namespace\.report/,
    "a report by an agent narrowed to capsid_lint_namespace.gather was not refused by the enforcement point",
  );
  assert.equal(
    JSON.parse(gathered).mode,
    "gather",
    `the narrowing refused the one mode it allows: ${gathered}`,
  );
});

test("DERIVED: every role names only flags this system has", () => {
  // A flag invented in a mint command does not survive parseScopes, so it would mint
  // an agent that silently holds nothing.
  for (const role of ROLES) {
    for (const flag of Object.keys(role.flags ?? {})) {
      assert.ok(
        (SCOPE_FLAGS as readonly string[]).includes(flag),
        `${role.name} names '${flag}', which is not a scope flag`,
      );
    }
  }
});
