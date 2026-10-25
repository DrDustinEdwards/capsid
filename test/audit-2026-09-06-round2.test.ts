import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server.ts";
import { SELF_REPO, ciDispatch, deleteBranch, deleteRepoFile, writeRepoFile } from "../src/github.ts";
import { mcpOriginProblem } from "../src/security-headers.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2, withFetch, type FakeD1Options } from "./fakes.ts";
import { sourceFiles } from "./source-files.ts";

// Audit fixes, one block per finding. Harnesses are the shared ones: fakes.ts for
// KV/D1/R2/fetch, source-files.ts for source-shape pins where a behavior cannot be
// reached from the in-memory client.

// ci_dispatch takes a workflow file name; repo writes refuse the self-repo

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

test("ci_dispatch refuses a numeric workflow id before any network call", async () => {
  await withFetch({}, async (calls) => {
    await assert.rejects(
      () => ciDispatch(repoEnv("owner/repo"), "ns", { workflow: "12345", ref: "main" }),
      /ci_dispatch refuses: '12345' is not a workflow file name/
    );
    assert.equal(calls.length, 0, "the refusal must not cost a GitHub round trip");
  });
});

// These three drive the self repo, so they take it from SELF_REPO rather than
// spelling it out: a hardcoded copy drifts from the real mapping on a rename and
// then tests nothing.
test("write_repo_file mode direct against the server's own repo is refused, with no network", async () => {
  await withFetch({}, async (calls) => {
    await assert.rejects(
      () => writeRepoFile(repoEnv(SELF_REPO), "capsid", "src/x.ts", "x", "m", "direct"),
      /own repo/
    );
    assert.equal(calls.length, 0);
  });
});

test("delete_repo_file mode direct against the server's own repo is refused", async () => {
  await withFetch({}, async (calls) => {
    await assert.rejects(
      () => deleteRepoFile(repoEnv(SELF_REPO), "capsid", "src/x.ts", "m", "direct"),
      /own repo/
    );
    assert.equal(calls.length, 0);
  });
});

test("write_repo_file pr mode with the default branch as the work branch is refused on the self-repo", async () => {
  await withFetch(
    { [`GET /repos/${SELF_REPO}`]: { body: { default_branch: "master" } } },
    async (calls) => {
      await assert.rejects(
        () => writeRepoFile(repoEnv(SELF_REPO), "capsid", "src/x.ts", "x", "m", "pr", "master"),
        /own repo/
      );
      assert.equal(calls.filter((c) => c.method !== "GET").length, 0, "nothing may be written");
    }
  );
});

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

// bounds: capsid_lint_namespace consumed, capsid_run_ci inputs, history

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

test("capsid_run_ci refuses more than 10 workflow inputs at the schema", async () => {
  const { call, close } = await serverClient();
  const inputs = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"]));
  const result = await call("capsid_run_ci", { namespace: "capsid", workflow: "ci.yml", ref: "main", inputs });
  await close();
  assert.equal(result.isError, true, "11 dispatch inputs were accepted (GitHub's own ceiling is 10)");
  assert.match(
    result.content[0].text,
    /at most 10 workflow inputs/,
    "the refusal must come from the inputs bound, not from a later check that happened to fail"
  );
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

// Origin allowlist on /mcp

test("a cross-origin browser request to /mcp is refused; same-origin, claude.ai and origin-less clients pass", () => {
  const at = (origin: string | null) =>
    mcpOriginProblem(
      new Request("https://capsid.dustin-edwards.workers.dev/mcp", {
        method: "POST",
        headers: origin === null ? {} : { Origin: origin },
      })
    );
  assert.equal(at(null), null, "a non-browser client sends no Origin and must pass");
  assert.equal(at("https://capsid.dustin-edwards.workers.dev"), null, "same-origin must pass");
  assert.equal(at("https://claude.ai"), null, "the one first-party browser client must pass");
  assert.match(String(at("https://evil.example")), /Origin/, "a foreign Origin was admitted to /mcp");
  assert.match(String(at("null")), /Origin/, "an opaque 'null' Origin was admitted to /mcp");
});

// The wiring into the fetch handler is driven through the whole Worker in
// test-integration/oauth.test.ts.
