import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server.ts";
import { defaultScopes, type ScopeFlag } from "../src/agents-schema.ts";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import { deleteBranch } from "../src/github/refs.ts";
import { fakeD1, fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// One plant per flag, through a real MCP connection against a scoped caller, in both directions: a refusal test alone passes against a broken tool.
// Every refusing plant also asserts zero GitHub calls: a repo write that refuses after committing has already happened.

const REPOS = [{ repo: "o/r", label: "primary" }];

function env() {
  return fakeEnv({
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => ({ repos: JSON.stringify(REPOS) }) }) }),
    },
    APP_KV: fakeKv({ seedToken: true }).kv,
  });
}

// A project driver as docs/bootstrap.md mints one: write on its own namespace, no flag.
function driver(namespace = "capsid", grant: ScopeFlag[] = []): Agent {
  const scopes = defaultScopes([namespace]);
  scopes.grants = ["read", "write"];
  for (const flag of grant) scopes.flags[flag] = true;
  return {
    id: "agent_0123456789ab",
    name: `${namespace}-driver`,
    kind: "driver",
    actor: `agent:${namespace}-driver`,
    scopes,
    admin: false,
    row: null,
  };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function callAs(
  caller: Agent,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const server = buildServer(env(), caller);
  const client = new Client({ name: "blast-radius", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
  await client.close();
  await server.close();
  return result;
}

const PLANTS: Array<{
  flag: ScopeFlag;
  tool: string;
  args: Record<string, unknown>;
  what: string;
}> = [
  {
    flag: "can_merge",
    tool: "capsid_close_pr",
    args: { action: "merge", namespace: "capsid", number: 7 },
    what: "a merge, which can trigger a deploy on a repo that deploys on push",
  },
  {
    flag: "can_merge",
    tool: "capsid_close_pr",
    args: { action: "close", namespace: "capsid", number: 7 },
    what: "a pull request close, which deletes the head branch the way a merge does",
  },
  {
    flag: "can_merge",
    tool: "capsid_close_pr",
    args: { action: "tag", namespace: "capsid", tag: "v1.0.0" },
    what: "a tag, which can start a deploy the way a merge does",
  },
  {
    flag: "can_merge",
    tool: "capsid_close_pr",
    args: { action: "release", namespace: "capsid", tag: "v1.0.0" },
    what: "a published release, which can start a deploy the way a merge does",
  },
  {
    flag: "can_merge",
    tool: "capsid_close_pr",
    args: {
      action: "delete_branch",
      namespace: "capsid",
      branch: "feature/other-agent",
      force: true,
    },
    what: "a forced branch delete, which lifts the open-PR refusal and so can delete another agent's PR head",
  },
];

for (const plant of PLANTS) {
  test(`PLANT: ${plant.flag} gates ${plant.what}: refused for a driver without it, not refused for a holder`, async () => {
    await withFetch({}, async (calls) => {
      // The driver is scoped to the namespace the call names, so the refusal is about
      // the flag and not about the namespace.
      const caller = driver(String(plant.args.namespace));
      const result = await callAs(caller, plant.tool, plant.args);
      assert.equal(result.isError, true, `${plant.tool} was not refused without ${plant.flag}`);
      assert.match(
        result.content[0].text,
        new RegExp(`needs the ${plant.flag} flag`),
        `the refusal does not name ${plant.flag}: ${result.content[0].text}`,
      );
      assert.equal(
        calls.length,
        0,
        `${plant.tool} reached GitHub before refusing, so the refusal describes something that already happened`,
      );
    });
    // The holder may fail afterwards for its own reasons (the fetch harness has no
    // routes), so this asserts that the scope refusal is absent and GitHub was asked.
    await withFetch({}, async (calls) => {
      const result = await callAs(adminAgentForEmail("admin@example.com"), plant.tool, plant.args);
      const text = result.content[0]?.text ?? "";
      assert.ok(text.length > 0, "the call returned no text, so an absent refusal proves nothing");
      assert.doesNotMatch(text, /needs the .* flag/, `the holder was refused: ${text}`);
      assert.doesNotMatch(text, /unauthorized:/, `the holder was refused: ${text}`);
      assert.ok(calls.length > 0, `${plant.tool} never reached GitHub for a holder: ${text}`);
    });
  });
}

test("PLANT: a driver IS allowed a branch delete without force, which still refuses an open PR's head", async () => {
  // The unforced delete keeps its own open-PR refusal in src/github/refs.ts and needs no flag; holding it to can_merge would take
  // branch cleanup from every driver.
  await withFetch({}, async (calls) => {
    const result = await callAs(driver(), "capsid_close_pr", {
      action: "delete_branch",
      namespace: "capsid",
      branch: "feature/mine",
    });
    const text = result.content[0]?.text ?? "";
    assert.doesNotMatch(
      text,
      /needs the .* flag/,
      `an unforced capsid_close_pr delete_branch was refused a flag for a driver: ${text}`,
    );
    assert.doesNotMatch(
      text,
      /unauthorized:/,
      `an unforced capsid_close_pr delete_branch was refused for a driver: ${text}`,
    );
    assert.ok(
      calls.length > 0,
      "the call never reached GitHub, so this asserts nothing about the guard",
    );
  });
});

test("delete_branch treats a non-OK pulls response as a refusal, not as no PRs", async () => {
  await withFetch(
    {
      "GET /repos/o/r": { body: { default_branch: "main" } },
      "GET /repos/o/r/pulls": { status: 500, body: { message: "boom" } },
    },
    async (calls) => {
      await assert.rejects(
        () => deleteBranch(env(), "capsid", "feature-x"),
        /could not verify|could not list/i,
      );
      assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
    },
  );
});

test("PLANT: a driver cannot reach a namespace it was not minted for", async () => {
  await withFetch({}, async (calls) => {
    const result = await callAs(driver("capsid"), "capsid_close_pr", {
      action: "delete_branch",
      namespace: "sample",
      branch: "feature/x",
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not scoped to the 'sample' namespace/);
    assert.equal(calls.length, 0, "the refused call still reached GitHub");
  });
});

test("PLANT: a namespace-scoped caller that omits the namespace is refused, not silently given all of them", async () => {
  // capsid_find_docs (list, search) treats an omitted namespace as every namespace, so a narrowed
  // caller that left it out would read the whole store.
  const result = await callAs(driver(), "capsid_find_docs", {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /must name a namespace/);

  // Naming one it holds still works. This needs a store that can answer a multi-row
  // read, so it uses the shared fake rather than the one-row repo stub.
  const d1 = fakeD1({ documents: [{ namespace: "capsid", path: "core.md", title: "core" }] });
  const server = buildServer(fakeEnv({ DB: d1.db }), driver());
  const client = new Client({ name: "blast-radius", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const allowed = (await client.callTool({
    name: "capsid_find_docs",
    arguments: { namespace: "capsid" },
  })) as ToolResult;
  await client.close();
  await server.close();
  assert.notEqual(allowed.isError, true, allowed.content[0]?.text);
  assert.match(
    allowed.content[0].text,
    /core\.md/,
    "the allowed read came back empty, so it proves nothing about the guard",
  );
});
