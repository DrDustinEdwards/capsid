import assert from "node:assert/strict";
import { test } from "node:test";
import { ROLES, roleMintCommand, selectAgents } from "../scripts/mint-agents.ts";
import { SCOPE_FLAGS, allowsToolAction, defaultScopes, parseScopes, serializeScopes } from "../src/agents-schema.ts";
import { type Agent } from "../src/agents.ts";
import { checkScope, repoWriteFlags } from "../src/scope.ts";
import { buildServer } from "../src/server.ts";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// Named roles. "Post a job and nothing else" is an action inside one tool, so a tools
// entry may be qualified, `capsid_work_jobs.post`, and the registrar asks the enforcement
// point about the qualified name where the action is known, the shape the one enforcement
// point rule permits for `capsid_work_jobs` and `capsid_lint_namespace`.

function scopedAgent(mutate: (scopes: ReturnType<typeof defaultScopes>) => void = () => {}): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  mutate(scopes);
  return { id: "agent_aaaaaaaaaaaa", name: "t", kind: "driver", actor: "agent:t", scopes, admin: false, row: null };
}

// the qualified tool entry, as a pure rule

test("a wildcard tools axis allows every action, so no existing agent changes behavior", () => {
  // Agents with "*" must keep every action.
  assert.equal(allowsToolAction("*", "capsid_work_jobs", "post"), true);
  assert.equal(allowsToolAction("*", "capsid_work_jobs", "claim"), true);
  assert.equal(allowsToolAction("*", "capsid_work_jobs", undefined), true);
});

test("an UNQUALIFIED tool entry still allows every action of that tool", () => {
  // A bare tool name keeps its meaning; narrowing is opted into by naming actions.
  const list = ["capsid_work_jobs", "capsid_read_doc"];
  assert.equal(allowsToolAction(list, "capsid_work_jobs", "post"), true);
  assert.equal(allowsToolAction(list, "capsid_work_jobs", "claim"), true);
  assert.equal(allowsToolAction(list, "capsid_read_doc", undefined), true);
});

test("naming ONE action narrows the tool to the actions named, and the rest are refused", () => {
  const list = ["capsid_work_jobs", "capsid_work_jobs.post"];
  assert.equal(allowsToolAction(list, "capsid_work_jobs", "post"), true);
  assert.equal(allowsToolAction(list, "capsid_work_jobs", "claim"), false, "a qualified entry that did not narrow would be decoration");
  assert.equal(allowsToolAction(list, "capsid_work_jobs", "complete"), false);
  assert.equal(allowsToolAction(list, "capsid_work_jobs", "resume"), false);
});

test("a qualified entry narrows ONLY its own tool", () => {
  // A `capsid_work_jobs.post` entry that also narrowed `capsid_lint_namespace` would
  // refuse an action nobody restricted.
  const list = ["capsid_work_jobs", "capsid_work_jobs.post", "capsid_lint_namespace"];
  assert.equal(allowsToolAction(list, "capsid_lint_namespace", "gather"), true);
  assert.equal(allowsToolAction(list, "capsid_lint_namespace", "finalize"), true);
});

test("a tool absent from the list is refused whether or not an action is named", () => {
  const list = ["capsid_work_jobs", "capsid_work_jobs.post"];
  assert.equal(allowsToolAction(list, "capsid_write_doc", "post"), false);
  assert.equal(allowsToolAction(list, "capsid_write_doc", undefined), false);
  assert.equal(allowsToolAction([], "capsid_work_jobs", "post"), false, "an empty list is the fail-closed value and must allow nothing");
});

test("the qualified name is what a scopes column round-trips, so the narrowing survives storage", () => {
  const scopes = defaultScopes(["capsid"]);
  scopes.tools = ["capsid_work_jobs", "capsid_work_jobs.post"];
  const back = parseScopes(serializeScopes(scopes));
  assert.deepEqual(back.tools, ["capsid_work_jobs", "capsid_work_jobs.post"]);
});

// the same rule, at the one enforcement point

test("checkScope refuses an action the tools axis narrowed away, and names the action", () => {
  const watcher = scopedAgent((s) => {
    s.namespaces = "*";
    s.tools = ["capsid_work_jobs", "capsid_work_jobs.post"];
  });
  assert.equal(checkScope(watcher, { tool: "capsid_work_jobs", action: "post", namespace: "capsid", grant: "write" }), null);

  const refusal = checkScope(watcher, { tool: "capsid_work_jobs", action: "claim", namespace: "capsid", grant: "write" });
  assert.match(String(refusal), /capsid_work_jobs\.claim/, "a refusal that does not name the action leaves the caller guessing which half failed");
  assert.match(String(refusal), /capsid_work_jobs, capsid_work_jobs\.post/, "a refusal that does not say what the scope IS costs a round trip");
});

test("checkScope with no action is exactly what it was, so every other tool is untouched", () => {
  const agent = scopedAgent((s) => {
    s.tools = ["capsid_write_doc", "capsid_read_doc"];
  });
  assert.equal(checkScope(agent, { tool: "capsid_write_doc", namespace: "capsid", grant: "write" }), null);
  assert.match(String(checkScope(agent, { tool: "capsid_delete_doc", namespace: "capsid", grant: "write" })), /not scoped to the 'capsid_delete_doc' tool/);
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
    ((await client.callTool({ name: "capsid_work_jobs", arguments: { action, namespace: "capsid" } })) as { content: Array<{ text: string }> }).content[0]?.text ?? "";
  const claimed = await call("claim");
  const listed = await call("list");
  await client.close();
  assert.match(claimed, /capsid_work_jobs\.claim/, "a claim by an agent narrowed to capsid_work_jobs.list was not refused by the enforcement point");
  assert.equal(JSON.parse(listed).ok, true, `the narrowing refused the one action it allows: ${listed}`);
});

// the reviewer's flag

test("can_comment_pr is a real flag and a comment is what requires it", () => {
  assert.ok((SCOPE_FLAGS as readonly string[]).includes("can_comment_pr"));
  assert.deepEqual(repoWriteFlags("capsid_open_pr", "comment", {}), ["can_comment_pr"]);
});

test("commenting needs can_comment_pr and NOT can_merge, which is the whole point of the role", () => {
  assert.deepEqual(repoWriteFlags("capsid_close_pr", "merge", {}), ["can_merge"]);
  assert.ok(!repoWriteFlags("capsid_open_pr", "comment", {}).includes("can_merge"));
});

// the four roles

const byName = (name: string) => {
  const role = ROLES.find((r: (typeof ROLES)[number]) => r.name === name);
  assert.ok(role, `no role named ${name}`);
  return role;
};

test("the auditor reads everything and writes nothing", () => {
  const auditor = byName("auditor");
  assert.deepEqual(auditor.namespaces, ["*"]);
  assert.deepEqual(auditor.repos, ["*"]);
  assert.deepEqual(auditor.grants, ["read"], "an auditor holding the write grant is not an auditor");
  assert.equal(auditor.flags, undefined);
});

test("the reviewer reads everything and may comment, and holds nothing else", () => {
  const reviewer = byName("reviewer");
  assert.deepEqual(reviewer.grants, ["read", "write"], "commenting goes through a write tool, so the grant is needed");
  assert.deepEqual(reviewer.tools, ["capsid_open_pr", "capsid_open_pr.comment"], "an unqualified capsid_open_pr would let a reviewer open pull requests");
  assert.equal(allowsToolAction(reviewer.tools, "capsid_close_pr", "merge"), false, "merge and close are capsid_close_pr, which a reviewer must not reach");
  assert.equal(allowsToolAction(reviewer.tools, "capsid_close_pr", "close"), false);
  assert.deepEqual(reviewer.flags, { can_comment_pr: true });
});

test("the watcher may post a job and cannot claim, complete or resume one", () => {
  const watcher = byName("watcher");
  assert.deepEqual(watcher.namespaces, ["*"]);
  assert.equal(watcher.flags, undefined, "a watcher with a blast-radius flag is a watcher that can act");
  const tools = watcher.tools;
  assert.ok(tools, "a watcher with no tools axis is scoped to every tool its grant allows, which is the hole this role exists to close");
  assert.deepEqual(tools, ["capsid_work_jobs", "capsid_work_jobs.post"]);
  for (const action of ["claim", "complete", "fail", "block", "resume"]) {
    assert.equal(allowsToolAction(tools, "capsid_work_jobs", action), false, `a watcher must not be able to ${action} a job`);
  }
  assert.equal(allowsToolAction(tools, "capsid_work_jobs", "post"), true);
});

test("the site seat is one namespace and one repo, and merges nothing else", () => {
  const seat = byName("site-seat");
  assert.deepEqual(seat.namespaces, ["dustinedwards"]);
  assert.deepEqual(seat.repos, ["*"], "repos is scoped by the namespace mapping, which is the authorization boundary");
  assert.deepEqual(seat.flags, { can_merge: true });
  const held = Object.keys(seat.flags ?? {});
  for (const flag of ["can_direct_write", "can_write_workflows", "can_touch_protected", "money_paths"]) {
    assert.ok(!held.includes(flag), `the site seat must not hold ${flag}`);
  }
});

test("the live probe reads capsid with the read tool and holds nothing else", () => {
  const probe = byName("live-probe");
  assert.deepEqual(probe.namespaces, ["capsid"]);
  assert.deepEqual(probe.grants, ["read"], "the live gate's key is a CI secret, so it must not write");
  assert.deepEqual(probe.tools, ["capsid_read_doc"]);
  assert.deepEqual(probe.repos, [], "the probe reads documents, never a repo");
  assert.equal(probe.flags, undefined);
});

test("DERIVED: every role names only flags this system has", () => {
  // A flag invented in a mint command does not survive parseScopes, so it would mint
  // an agent that silently holds nothing.
  for (const role of ROLES) {
    for (const flag of Object.keys(role.flags ?? {})) {
      assert.ok((SCOPE_FLAGS as readonly string[]).includes(flag), `${role.name} names '${flag}', which is not a scope flag`);
    }
  }
});

test("DERIVED: no role is a driver in disguise", () => {
  // Roles are few and separated: one capability each, not a bundle of flags.
  for (const role of ROLES) {
    const flags = Object.keys(role.flags ?? {});
    assert.ok(flags.length <= 1, `${role.name} holds ${flags.length} flags; a role is one capability, not a bundle`);
  }
});

test("each role prints a mint command the script itself can parse", () => {
  for (const role of ROLES) {
    const command = roleMintCommand(role);
    assert.match(command, /node scripts\/mint-agents\.ts --role /);
    assert.match(command, new RegExp(`--role ${role.name}\\b`));
    assert.match(command, /--apply/);
    assert.ok(!command.includes("CAPSID_OPERATOR_KEY=<"), "a command with a placeholder key is one nobody can paste");
    assert.match(command, /^CAPSID_OPERATOR_KEY=\$CAPSID_OPERATOR_KEY /);
  }
});

test("--role selects exactly one agent, and an unknown role is refused rather than matching nothing", () => {
  assert.deepEqual(
    selectAgents(undefined, undefined, "auditor").map((a) => a.name),
    ["auditor"]
  );
  assert.throws(() => selectAgents(undefined, undefined, "nope"), /no role named 'nope'/);
});

test("a role is NOT reachable through --namespace, so the two selectors cannot collide", () => {
  // site-seat is scoped to dustinedwards. If --namespace dustinedwards picked it up,
  // a routine driver mint would quietly mint a credential holding can_merge.
  const picked = selectAgents("dustinedwards").map((a) => a.name);
  assert.deepEqual(picked, ["dustinedwards-driver"]);
  assert.ok(!picked.includes("site-seat"), "a namespace mint must never reach a role that holds can_merge");
});
