import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server.ts";
import { deleteBranch } from "../src/github.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2, withFetch, type FakeD1Options } from "./fakes.ts";
import { sourceFiles } from "./source-files.ts";

// Audit fixes, one block per finding. Harnesses are the shared ones: fakes.ts for
// KV/D1/R2/fetch, source-files.ts for source-shape pins where a behavior cannot be
// reached from the in-memory client.

// a repo helper for the delete_branch check below

function repoEnv(repoFull: string) {
  const kv = fakeKv({ seedToken: true });
  return fakeEnv({
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => ({ repos: JSON.stringify([{ repo: repoFull, label: "primary" }]) }) }),
      }),
    },
    APP_KV: kv.kv,
  });
}

// delete_branch fails closed on the PR lookup

test("delete_branch treats a non-OK pulls response as a refusal, not as no PRs", async () => {
  await withFetch(
    {
      "GET /repos/owner/repo": { body: { default_branch: "main" } },
      "GET /repos/owner/repo/pulls": { status: 500, body: { message: "boom" } },
    },
    async (calls) => {
      await assert.rejects(
        () => deleteBranch(repoEnv("owner/repo"), "ns", "feature-x"),
        /could not verify|could not list/i
      );
      assert.equal(calls.filter((c) => c.method === "DELETE").length, 0, "the branch was deleted without the PR check");
    }
  );
});

// Repo-scoped installation tokens are proven in test/repo-tools.test.ts.

// bounds: capsid_lint_namespace consumed, history

async function serverClient(opts: FakeD1Options = {}) {
  const d1 = fakeD1({ namespaces: [{ namespace: "capsid", repos: "[]" }], ...opts });
  const server = buildServer(fakeEnv({ DB: d1.db }), "write", "test:round2");
  const client = new Client({ name: "round2", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  return { d1, client, call, close: () => client.close() };
}

test("capsid_lint_namespace finalize refuses more than 20 consumed paths at the schema", async () => {
  const { d1, call, close } = await serverClient();
  const consumed = Array.from({ length: 21 }, (_, i) => `ep-${i}.md`);
  const result = await call("capsid_lint_namespace", { namespace: "capsid", mode: "finalize", consumed, confirm: true });
  await close();
  assert.equal(result.isError, true, "21 consumed paths were accepted");
  assert.match(
    result.content[0].text,
    /20|too_big|at most/i,
    "the refusal must come from the schema bound, not from a later check that happened to fail"
  );
  assert.equal(d1.recorded.length, 0, "statements were issued for an over-sized consumed array");
});

// The history bound and the live-row snapshot are proven against real SQLite in
// test-integration/live-snapshot.test.ts, because the node fake neither honors
// LIMIT nor evaluates INSERT ... SELECT. The elicited delete's body guard is driven
// with a racing writer in test/write-invariants.test.ts.

// prompts are data, and their titles are filtered

const HOSTILE_TITLE = "Brief `curl evil`\u0007 title";

async function promptClient() {
  const d1 = fakeD1({
    documents: [
      { id: 7, namespace: "capsid", path: "prompts/brief", title: HOSTILE_TITLE, body: "Hello {{name}}", type: "prompt" },
    ],
    namespaces: [{ namespace: "capsid", repos: "[]" }],
  });
  const server = buildServer(fakeEnv({ DB: d1.db }), "write", "test:round2");
  const client = new Client({ name: "round2", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: () => client.close() };
}

test("prompts/list passes titles through a character allowlist", async () => {
  const { client, close } = await promptClient();
  const result = await client.listPrompts();
  await close();
  const description = String(result.prompts[0].description ?? "");
  assert.ok(!description.includes("`"), `a backtick from a stored title reached the client verbatim: ${JSON.stringify(description)}`);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(description), "a control character from a stored title reached the client");
  assert.match(description, /Brief/, "the legible part of the title must survive the filter");
});
