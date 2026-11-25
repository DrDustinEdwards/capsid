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

// "Post a job and nothing else" is an action inside one tool, so a tools entry may be qualified
// (`capsid_work_jobs.post`) and the registrar checks the qualified name.

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
  assert.equal(allowsToolAction("*", "capsid_work_jobs", "post"), true);
  assert.equal(allowsToolAction("*", "capsid_work_jobs", undefined), true);
  const list = ["capsid_work_jobs", "capsid_read_doc"];
  assert.equal(allowsToolAction(list, "capsid_work_jobs", "post"), true);
  assert.equal(allowsToolAction(list, "capsid_work_jobs", "claim"), true);
  assert.equal(allowsToolAction(list, "capsid_read_doc", undefined), true);
});

test("naming ONE action narrows the tool to the actions named, and the rest are refused", () => {
  const list = ["capsid_work_jobs", "capsid_work_jobs.post"];
  assert.equal(allowsToolAction(list, "capsid_work_jobs", "post"), true);
  assert.equal(
    allowsToolAction(list, "capsid_work_jobs", "claim"),
    false,
    "a qualified entry that did not narrow would be decoration",
  );
  assert.equal(allowsToolAction(list, "capsid_work_jobs", "complete"), false);
  assert.equal(allowsToolAction(list, "capsid_work_jobs", "resume"), false);
});

test("a qualified entry narrows only its own tool, and a tool absent from the list is refused", () => {
  const list = ["capsid_work_jobs", "capsid_work_jobs.post", "capsid_lint_namespace"];
  assert.equal(allowsToolAction(list, "capsid_lint_namespace", "gather"), true);
  assert.equal(allowsToolAction(list, "capsid_lint_namespace", "finalize"), true);
  assert.equal(allowsToolAction(list, "capsid_write_doc", "post"), false);
  assert.equal(allowsToolAction(list, "capsid_write_doc", undefined), false);
  assert.equal(
    allowsToolAction([], "capsid_work_jobs", "post"),
    false,
    "an empty list is the fail-closed value and must allow nothing",
  );
});

test("the qualified name is what a scopes column round-trips, so the narrowing survives storage", () => {
  const scopes = defaultScopes(["capsid"]);
  scopes.tools = ["capsid_work_jobs", "capsid_work_jobs.post"];
  const back = parseScopes(serializeScopes(scopes));
  assert.deepEqual(back.tools, ["capsid_work_jobs", "capsid_work_jobs.post"]);
});

test("checkScope refuses an action the tools axis narrowed away, and names the action", () => {
  const watcher = scopedAgent((s) => {
    s.namespaces = "*";
    s.tools = ["capsid_work_jobs", "capsid_work_jobs.post"];
  });
  assert.equal(
    checkScope(watcher, {
      tool: "capsid_work_jobs",
      action: "post",
      namespace: "capsid",
      grant: "write",
    }),
    null,
  );

  const refusal = checkScope(watcher, {
    tool: "capsid_work_jobs",
    action: "claim",
    namespace: "capsid",
    grant: "write",
  });
  assert.match(
    String(refusal),
    /capsid_work_jobs\.claim/,
    "a refusal that does not name the action leaves the caller guessing which half failed",
  );
  assert.match(
    String(refusal),
    /capsid_work_jobs, capsid_work_jobs\.post/,
    "a refusal that does not say what the scope IS costs a round trip",
  );
});

test("the jobs tool asks the enforcement point about the qualified name", async () => {
  // The action must reach the check. An agent narrowed to capsid_work_jobs.list is
  // called through the real tool with two actions.
  const lister = scopedAgent((s) => {
    s.namespaces = "*";
    s.tools = ["capsid_work_jobs", "capsid_work_jobs.list"];
  });
  const server = buildServer(fakeEnv({ DB: fakeD1({}).db, APP_KV: fakeKv({}).kv }), lister);
  const client = new Client({ name: "roles", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (action: string) =>
    (
      (await client.callTool({
        name: "capsid_work_jobs",
        arguments: { action, namespace: "capsid" },
      })) as { content: Array<{ text: string }> }
    ).content[0]?.text ?? "";
  const claimed = await call("claim");
  const listed = await call("list");
  await client.close();
  assert.match(
    claimed,
    /capsid_work_jobs\.claim/,
    "a claim by an agent narrowed to capsid_work_jobs.list was not refused by the enforcement point",
  );
  assert.equal(
    JSON.parse(listed).ok,
    true,
    `the narrowing refused the one action it allows: ${listed}`,
  );
});

const byName = (name: string) => {
  const role = ROLES.find((r: (typeof ROLES)[number]) => r.name === name);
  assert.ok(role, `no role named ${name}`);
  return role;
};

test("the watcher may post a job and cannot claim, complete or resume one", () => {
  const watcher = byName("watcher");
  assert.deepEqual(watcher.namespaces, ["*"]);
  assert.equal(
    watcher.flags,
    undefined,
    "a watcher with a blast-radius flag is a watcher that can act",
  );
  const tools = watcher.tools;
  assert.ok(
    tools,
    "a watcher with no tools axis is scoped to every tool its grant allows, which is the hole this role exists to close",
  );
  assert.deepEqual(tools, ["capsid_work_jobs", "capsid_work_jobs.post"]);
  for (const action of ["claim", "complete", "fail", "block", "resume"]) {
    assert.equal(
      allowsToolAction(tools, "capsid_work_jobs", action),
      false,
      `a watcher must not be able to ${action} a job`,
    );
  }
  assert.equal(allowsToolAction(tools, "capsid_work_jobs", "post"), true);
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
