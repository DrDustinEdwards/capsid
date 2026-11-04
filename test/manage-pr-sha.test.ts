import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server.ts";
import { adminAgentForEmail } from "../src/agents.ts";
import { fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// capsid_close_pr merge with `sha`: the caller names the head it reviewed, GitHub merges
// only that commit, and a moved head comes back as a refusal. Driven through the tool
// handler.

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

async function callClosePr(args: Record<string, unknown>) {
  const server = buildServer(fakeEnv({ DB: db(), APP_KV: fakeKv({ seedToken: true }).kv }), adminAgentForEmail("admin@example.com"));
  const client = new Client({ name: "manage-pr-sha", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = (await client.callTool({ name: "capsid_close_pr", arguments: { namespace: "capsid", number: 7, ...args } })) as {
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

test("capsid_close_pr merge with sha sends that sha on the merge PUT", async () => {
  await withFetch({ ...PR_ROUTES, "PUT /repos/owner/repo/pulls/7/merge": { body: { merged: true, sha: "m1" } } }, async (calls) => {
    const result = await callClosePr({ action: "merge", sha: SHA });
    assert.notEqual(result.isError, true, result.content[0]?.text);
    assert.equal(JSON.parse(result.content[0].text).merged, true);
    const put = calls.find((c) => c.method === "PUT" && c.path === "/repos/owner/repo/pulls/7/merge");
    assert.ok(put, "no merge PUT was sent");
    assert.deepEqual(put.body, { merge_method: "squash", sha: SHA });
  });
});

test("capsid_close_pr merge with sha returns a refusal, not success, when GitHub answers 409", async () => {
  await withFetch(
    { ...PR_ROUTES, "PUT /repos/owner/repo/pulls/7/merge": { status: 409, body: { message: "Head branch was modified. Review and try the merge again." } } },
    async (calls) => {
      const result = await callClosePr({ action: "merge", sha: SHA });
      assert.equal(result.isError, true, `a moved head was reported as success: ${result.content[0]?.text}`);
      assert.match(result.content[0].text, /merge refused, nothing was merged: the head of pull request 7 moved/);
      assert.ok(result.content[0].text.includes(SHA));
      assert.ok(!calls.some((c) => c.method === "DELETE"), "the head branch was deleted after a refused merge");
    }
  );
});

test("a sha on an action other than merge is refused, before any GitHub write", async () => {
  // close takes no sha, so the dispatcher refuses it rather than dropping it.
  await withFetch(PR_ROUTES, async (calls) => {
    const closed = await callClosePr({ action: "close", sha: SHA });
    assert.equal(closed.isError, true, closed.content[0]?.text);
    assert.match(closed.content[0].text, /capsid_close_pr action 'close' does not take sha/);
    assert.ok(!calls.some((c) => c.method !== "GET"), "a write reached GitHub");
  });
});

// A chat approval (src/chat-approval.ts): Dustin's "yes" in a Claude chat, linked by
// approved_in, is written to pr_approvals after the merge, so the approval record and the
// merge units see it.
test("capsid_close_pr merge with approved_in records the chat approval after the merge, and needs sha", async () => {
  const batches: string[][] = [];
  const recording = { ...db(), batch: async (stmts: Array<{ sql?: string }>) => (batches.push(stmts.map((s) => s.sql ?? "")), []) };
  const prepare = recording.prepare;
  recording.prepare = (sql: string) => Object.assign(prepare(sql), { sql });
  const call = async (args: Record<string, unknown>) => {
    const server = buildServer(fakeEnv({ DB: recording, APP_KV: fakeKv({ seedToken: true }).kv }), adminAgentForEmail("admin@example.com"));
    const client = new Client({ name: "chat-approval", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = (await client.callTool({ name: "capsid_close_pr", arguments: { namespace: "capsid", number: 7, ...args } })) as { isError?: boolean; content: Array<{ text: string }> };
    await client.close();
    return result;
  };
  const link = "https://claude.ai/code/project/chan_sample?thread=cmsg_sample";
  await withFetch(
    {
      ...PR_ROUTES,
      "PUT /repos/owner/repo/pulls/7/merge": { body: { merged: true, sha: "f".repeat(40) } },
      "GET /repos/owner/repo/pulls/7/files": { body: [{ filename: "docs/readme.md", status: "modified", additions: 1, deletions: 0 }] },
    },
    async (calls) => {
      const noSha = await call({ action: "merge", approved_in: link });
      assert.equal(noSha.isError, true, noSha.content[0]?.text);
      assert.ok(!calls.some((c) => c.method === "PUT"), "a merge ran without the approved sha");

      const result = await call({ action: "merge", sha: SHA, approved_in: link });
      assert.notEqual(result.isError, true, result.content[0]?.text);
      assert.deepEqual(JSON.parse(result.content[0].text).approval, { recorded: true, path_class: "docs" });
      assert.ok(batches.some((b) => b.some((sql) => /INSERT INTO pr_approvals/.test(sql) && /'chat', 'merged'/.test(sql))), "no chat approval row was written");
    }
  );
});
