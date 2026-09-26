import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_KINDS,
  SCOPE_FLAGS,
  agentActor,
  allowsScope,
  defaultScopes,
  isAgentKind,
  mintAgentId,
  mintAgentKey,
  parseScopes,
  serializeScopes,
  type AgentScopes,
} from "../src/agents-schema.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The vocabulary of a scoped credential: the table, the tool and the enforcement point
// all read one module, and this file asserts that module against the migration that
// stores it.
//
// Parsing fails closed. A scopes column that is empty, truncated, malformed, or of an
// unexpected type resolves to the least privilege there is, not to "no restrictions
// found, allow everything".

const MIGRATION = readFileSync(join(import.meta.dirname, "..", "migrations", "0008_agents.sql"), "utf8");

test("the migration and the module agree about the kinds a credential can have", () => {
  for (const kind of AGENT_KINDS) {
    assert.ok(MIGRATION.includes(kind), `migrations/0008_agents.sql never mentions the '${kind}' kind`);
  }
  assert.deepEqual([...AGENT_KINDS], ["session", "driver", "seat", "cron"]);
  assert.ok(isAgentKind("driver"));
  assert.ok(!isAgentKind("admin"), "'admin' is a synthetic identity, not a storable kind");
  assert.ok(!isAgentKind("constructor"), "the kind check must not answer for Object.prototype");
});

test("the default for a new agent is read on the named namespaces and nothing else", () => {
  const scopes = defaultScopes(["capsid"]);
  assert.deepEqual(scopes.namespaces, ["capsid"]);
  assert.deepEqual(scopes.grants, ["read"]);
  for (const flag of SCOPE_FLAGS) {
    assert.equal(scopes.flags[flag], false, `a new agent must not be born holding ${flag}`);
  }
});

test("a scopes column that cannot be read grants the least there is, never the most", () => {
  const leastPrivilege = (scopes: AgentScopes, why: string) => {
    assert.deepEqual(scopes.namespaces, [], why);
    assert.deepEqual(scopes.tools, [], why);
    assert.deepEqual(scopes.repos, [], why);
    assert.deepEqual(scopes.grants, [], why);
    for (const flag of SCOPE_FLAGS) assert.equal(scopes.flags[flag], false, `${why}: ${flag}`);
  };
  leastPrivilege(parseScopes(null), "a null scopes column");
  leastPrivilege(parseScopes(""), "an empty scopes column");
  leastPrivilege(parseScopes("{"), "a truncated scopes column");
  leastPrivilege(parseScopes("null"), "the JSON literal null");
  leastPrivilege(parseScopes("[]"), "an array where an object belongs");
  leastPrivilege(parseScopes('"*"'), "a bare string, which a loose parse could read as allow-all");
  leastPrivilege(parseScopes("{}"), "an object with no keys");
});

test("an unrecognised grant, flag or list entry is dropped rather than carried", () => {
  const scopes = parseScopes(
    JSON.stringify({
      namespaces: ["capsid", 7, null],
      repos: "*",
      tools: "*",
      grants: ["read", "admin", "write"],
      flags: { can_merge: true, can_fly: true, can_dispatch: "yes" },
    })
  );
  assert.deepEqual(scopes.namespaces, ["capsid"], "non-string entries are not namespaces");
  assert.deepEqual(scopes.grants, ["read", "write"], "'admin' is not a grant this system has");
  assert.equal(scopes.flags.can_merge, true);
  assert.equal(scopes.flags.can_dispatch, false, "a flag is true only when it is the boolean true");
  assert.ok(!Object.hasOwn(scopes.flags, "can_fly"), "an invented flag must not survive the parse");
});

test("serialize and parse round-trip without widening", () => {
  const scopes = defaultScopes(["capsid", "foxing"]);
  scopes.flags.can_merge = true;
  const back = parseScopes(serializeScopes(scopes));
  assert.deepEqual(back, scopes);
});

test("allowsScope is the one list comparison, and '*' is the only wildcard", () => {
  assert.equal(allowsScope("*", "anything"), true);
  assert.equal(allowsScope(["capsid"], "capsid"), true);
  assert.equal(allowsScope(["capsid"], "foxing"), false);
  assert.equal(allowsScope([], "capsid"), false, "an empty list allows nothing, which is what makes the fail-closed parse work");
  assert.equal(allowsScope(["*"], "capsid"), false, "a list containing the string '*' is a list of one odd name, not a wildcard");
});

test("ids and keys are minted, not sequential, and a key is not its own hash", () => {
  const id = mintAgentId();
  assert.match(id, /^agent_[0-9a-f]{12}$/);
  assert.notEqual(id, mintAgentId());
  const key = mintAgentKey();
  assert.match(key, /^capsid_agent_[0-9a-f]{64}$/, "32 bytes of entropy, prefixed so a leaked key is greppable");
  assert.notEqual(key, mintAgentKey());
});

test("the audit identity of an agent is its name, in the actor vocabulary the queue already speaks", () => {
  assert.equal(agentActor("capsid-driver"), "agent:capsid-driver");
});
