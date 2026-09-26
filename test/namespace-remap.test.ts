import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { checkScope } from "../src/scope.ts";
import { adminAgent, type Agent } from "../src/agents.ts";
import { allowsScope, defaultScopes, noFlags, type AgentScopes } from "../src/agents-schema.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";
import { parseNamespaceRepos, reposForNamespace } from "../scripts/mint-agents.mjs";

// The namespace-remap escalation, closed in both directions. A namespace-scoped
// driver with the write grant must not be able to call update_namespace on its own
// namespace, add any repo the GitHub App reaches, and then read and write it.
//
// Both halves are tested, because either alone leaves a hole: admin-gating the
// mapping without narrowing the repos axis means one forgotten admin call re-opens it,
// and narrowing the axis without gating the mapping leaves the boundary editable by
// the party it binds.

function agentWith(scopes: Partial<AgentScopes>, admin = false): Agent {
  return {
    id: "ag_test",
    name: "test",
    kind: "driver",
    actor: "agent:test",
    scopes: {
      namespaces: ["capsid"],
      repos: ["DrDustinEdwards/capsid"],
      tools: "*",
      grants: ["read", "write"],
      flags: noFlags(),
      ...scopes,
    },
    admin,
    row: null,
  } as Agent;
}

// half one: the mapping is admin work

for (const tool of ["update_namespace", "register_namespace"] as const) {
  test(`${tool} refuses a minted agent and names why`, () => {
    // The driver is scoped to the namespace it is asking about and holds write, so
    // every other axis passes. Only the admin check can refuse this call.
    const refusal = checkScope(agentWith({}), {
      tool,
      namespace: "capsid",
      grant: "write",
      admin: true,
    });
    assert.ok(refusal, `${tool} admitted a minted agent`);
    assert.match(refusal, /admin only/, "the refusal does not say it is an admin tool");
    assert.match(refusal, /authorization boundary/, "the refusal does not say why");
  });

  test(`${tool} admits the admin`, () => {
    assert.equal(
      checkScope(agentWith({ namespaces: "*", repos: "*" }, true), {
        tool,
        namespace: "capsid",
        grant: "write",
        admin: true,
      }),
      null
    );
  });
}

test("the admin refusal comes BEFORE the namespace refusal", () => {
  // A driver asking about someone else's namespace must still be told the tool is
  // admin only. Reporting the namespace first would send it to ask for a namespace
  // it does not need, and it would leak which namespaces exist.
  const refusal = checkScope(agentWith({}), {
    tool: "update_namespace",
    namespace: "foxhound",
    grant: "write",
    admin: true,
  });
  assert.ok(refusal);
  assert.match(refusal, /admin only/);
  assert.doesNotMatch(refusal, /not scoped to the 'foxhound' namespace/);
});

// The registrar applies it, over a real connection. The assertions above call
// checkScope directly with `admin: true`; this proves the registrar turns a
// TOOL_GRANTS entry of "admin" into that need.

interface ToolResult {
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function callAs(caller: Agent, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const server = buildServer(fakeEnv({ DB: fakeD1().db, APP_KV: fakeKv().kv }), caller);
  const client = new Client({ name: "namespace-remap", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
  await client.close();
  await server.close();
  return result;
}

function realDriver(namespace = "capsid"): Agent {
  const scopes = defaultScopes([namespace]);
  scopes.grants = ["read", "write"];
  return { id: "agent_0123456789ab", name: `${namespace}-driver`, kind: "driver", actor: `agent:${namespace}-driver`, scopes, admin: false, row: null };
}

test("END TO END: a driver is refused update_namespace through a real connection", async () => {
  const result = await callAs(realDriver(), "update_namespace", {
    namespace: "capsid",
    repos: JSON.stringify([
      { repo: "DrDustinEdwards/capsid", label: "primary" },
      { repo: "DrDustinEdwards/capsid-backups", label: "backups" },
    ]),
  });
  assert.equal(result.isError, true, "a driver remapped its own namespace");
  const text = result.content.map((c) => c.text).join("");
  assert.match(text, /admin only/);
  // The refusal names the escalation, so a log shows what was attempted.
  assert.match(text, /widen itself/);
});

test("END TO END: a driver is refused register_namespace through a real connection", async () => {
  const result = await callAs(realDriver(), "register_namespace", {
    namespace: "brand-new",
    repos: JSON.stringify([{ repo: "DrDustinEdwards/anything", label: "primary" }]),
  });
  assert.equal(result.isError, true, "a driver registered a namespace onto a repo of its choosing");
  assert.match(result.content.map((c) => c.text).join(""), /admin only/);
});

test("END TO END: the admin still maps namespaces", async () => {
  // The admin is not locked out of the tool.
  const result = await callAs(adminAgent("DrDustinEdwards"), "update_namespace", {
    namespace: "capsid",
    repos: JSON.stringify([{ repo: "DrDustinEdwards/capsid", label: "primary" }]),
  });
  const text = result.content.map((c) => c.text).join("");
  assert.doesNotMatch(text, /admin only/, `the admin was refused its own tool: ${text}`);
  assert.notEqual(result.isError, true, `the admin's update failed: ${text}`);
  const out = JSON.parse(text) as { namespace: string; action: string; repos: Array<{ repo: string; label: string }> };
  assert.equal(out.namespace, "capsid");
  assert.equal(out.action, "updated");
  assert.deepEqual(out.repos, [{ repo: "DrDustinEdwards/capsid", label: "primary" }]);
});

// half two: the repos axis refuses independently of the mapping

test("PLANT: a driver narrowed to its own repos is refused on another, remap or not", () => {
  // Even if the mapping named capsid-backups, a driver whose axis lists only its own
  // repo is refused here, whatever the mapping says.
  const driver = agentWith({ repos: ["DrDustinEdwards/capsid"] });
  assert.equal(checkScope(driver, { tool: "read_repo_file", namespace: "capsid", repo: "DrDustinEdwards/capsid", grant: "read" }), null);
  const refusal = checkScope(driver, {
    tool: "read_repo_file",
    namespace: "capsid",
    repo: "DrDustinEdwards/capsid-backups",
    grant: "read",
  });
  assert.ok(refusal, "a narrowed driver reached a repo outside its axis");
  assert.match(refusal, /not scoped to the 'DrDustinEdwards\/capsid-backups' repo/);
});

test("the wildcard still means everything for an agent legitimately scoped to it", () => {
  // The seat, the auditor and the reviewer are not narrowed, so "*" must keep working.
  assert.equal(allowsScope("*", "DrDustinEdwards/anything"), true);
  const seat = agentWith({ namespaces: "*", repos: "*" });
  assert.equal(checkScope(seat, { tool: "read_repo_file", namespace: "foxhound", repo: "DrDustinEdwards/recova", grant: "read" }), null);
});

test("a list containing the literal star is NOT a wildcard on the read path", () => {
  // The stored-column direction, which is what a hand-edited or corrupted scopes
  // row would carry. parseList keeps it a list of one odd name; only the mint path
  // turns a single-entry ["*"] into the wildcard, and that asymmetry is deliberate.
  assert.equal(allowsScope(["*"], "DrDustinEdwards/capsid"), false);
});

// the mint script derives the axis rather than copying the mapping

const NAMESPACES_RESPONSE = JSON.stringify([
  { namespace: "capsid", repos: JSON.stringify([{ repo: "DrDustinEdwards/capsid", label: "primary" }]) },
  {
    namespace: "foxhound",
    repos: JSON.stringify([
      { repo: "DrDustinEdwards/foxhound", label: "primary" },
      { repo: "DrDustinEdwards/recova", label: "legacy" },
    ]),
  },
  { namespace: "orphan", repos: JSON.stringify([]) },
]);

test("the repos axis is parsed out of the real namespaces response shape", () => {
  const map = parseNamespaceRepos(NAMESPACES_RESPONSE);
  assert.deepEqual(reposForNamespace(map, "capsid"), ["DrDustinEdwards/capsid"]);
  // Every mapped repo, not just the primary: a foxhound driver works the legacy
  // repos too, and an axis that named only the primary would refuse its own work.
  assert.deepEqual(reposForNamespace(map, "foxhound"), ["DrDustinEdwards/foxhound", "DrDustinEdwards/recova"]);
});

test("a namespace that maps to nothing REFUSES rather than minting wide", () => {
  const map = parseNamespaceRepos(NAMESPACES_RESPONSE);
  assert.throws(() => reposForNamespace(map, "orphan"), /maps to no repos/);
  assert.throws(() => reposForNamespace(map, "never-registered"), /maps to no repos/);
});

test("vacuity: a response that parses to nothing is an error, not an empty mapping", () => {
  // Without this, a shape change would make every driver mint with no repos and
  // every repo call refuse, which reads as a scope bug rather than a parse bug.
  assert.throws(() => parseNamespaceRepos("[]"), /returned no namespaces/);
  assert.throws(() => parseNamespaceRepos("not json"), /did not answer with JSON/);
  assert.throws(() => parseNamespaceRepos('{"namespace":"capsid"}'), /not an array/);
});
