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

test("a wildcard or unqualified entry allows every action; a qualified one narrows only its tool; an absent tool and an empty list allow nothing", () => {
  const plain = ["capsid_write_doc", "capsid_read_doc"];
  const narrowed = ["capsid_write_doc", "capsid_write_doc.write", "capsid_lint_namespace"];
  for (const [tools, tool, action, allowed] of [
    ["*", "capsid_write_doc", "write", true],
    ["*", "capsid_write_doc", undefined, true],
    [plain, "capsid_write_doc", "write", true],
    [plain, "capsid_write_doc", "move", true],
    [plain, "capsid_read_doc", undefined, true],
    [narrowed, "capsid_write_doc", "write", true],
    [narrowed, "capsid_write_doc", "move", false],
    [narrowed, "capsid_write_doc", "restore", false],
    // A call path that forgets to pass the action is refused on a narrowed tool.
    [narrowed, "capsid_write_doc", undefined, false],
    [narrowed, "capsid_lint_namespace", "gather", true],
    [narrowed, "capsid_lint_namespace", "finalize", true],
    [narrowed, "capsid_close_pr", "close", false],
    [narrowed, "capsid_close_pr", undefined, false],
    [[], "capsid_write_doc", "write", false],
  ] as const)
    assert.equal(
      allowsToolAction(tools as never, tool, action),
      allowed,
      `${String(tools)} ${tool}.${action}`,
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
