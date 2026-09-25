import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { adminAgent } from "../src/agents.ts";
import { fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// manage_pr merge with `sha`: the caller names the head it reviewed, GitHub merges only
// that commit, and a moved head comes back as a refusal. Driven through the tool handler.

function db() {
  const statement = (sql: string) => {
    const stmt = {
      bind: () => stmt,
      first: async () => (/FROM namespaces/.test(sql) ? { repos: JSON.stringify([{ repo: "owner/repo", label: "primary" }]) } : null),
      all: async () => ({ results: [] }),
      run: async () => ({ meta: {} }),
    };
    return stmt;
  };
  return { prepare: statement, batch: async () => [] };
}

async function callManagePr(args: Record<string, unknown>) {
  const server = buildServer(fakeEnv({ DB: db(), APP_KV: fakeKv({ seedToken: true }).kv }), adminAgent("DrDustinEdwards"));
  const client = new Client({ name: "manage-pr-sha", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = (await client.callTool({ name: "manage_pr", arguments: { namespace: "capsid", number: 7, ...args } })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await client.close();
  return result;
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const PR_ROUTES = {
  "GET /repos/owner/repo": { body: { default_branch: "main" } },
  "GET /repos/owner/repo/pulls/7": {
    body: { number: 7, state: "open", merged: false, head: { ref: "feat/x", sha: SHA }, base: { ref: "main" } },
  },
  "DELETE /repos/owner/repo/git/refs/heads/feat/x": { status: 204 },
};

test("manage_pr merge with sha sends that sha on the merge PUT", async () => {
  await withFetch({ ...PR_ROUTES, "PUT /repos/owner/repo/pulls/7/merge": { body: { merged: true, sha: "m1" } } }, async (calls) => {
    const result = await callManagePr({ action: "merge", sha: SHA });
    assert.notEqual(result.isError, true, result.content[0]?.text);
    assert.equal(JSON.parse(result.content[0].text).merged, true);
    const put = calls.find((c) => c.method === "PUT" && c.path === "/repos/owner/repo/pulls/7/merge");
    assert.ok(put, "no merge PUT was sent");
    assert.deepEqual(put.body, { merge_method: "squash", sha: SHA });
  });
});

test("manage_pr merge with sha returns a refusal, not success, when GitHub answers 409", async () => {
  await withFetch(
    { ...PR_ROUTES, "PUT /repos/owner/repo/pulls/7/merge": { status: 409, body: { message: "Head branch was modified. Review and try the merge again." } } },
    async (calls) => {
      const result = await callManagePr({ action: "merge", sha: SHA });
      assert.equal(result.isError, true, `a moved head was reported as success: ${result.content[0]?.text}`);
      assert.match(result.content[0].text, /merge refused, nothing was merged: the head of pull request 7 moved/);
      assert.ok(result.content[0].text.includes(SHA));
      assert.ok(!calls.some((c) => c.method === "DELETE"), "the head branch was deleted after a refused merge");
    }
  );
});

test("manage_pr refuses a sha on an action other than merge, before any GitHub write", async () => {
  await withFetch(PR_ROUTES, async (calls) => {
    const result = await callManagePr({ action: "close", sha: SHA });
    assert.equal(result.isError, true, result.content[0]?.text);
    assert.match(result.content[0].text, /takes no sha/);
    assert.ok(!calls.some((c) => c.method !== "GET"), "a write reached GitHub");
  });
});
