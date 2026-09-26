import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { SELF_REPO, ciDispatch, deleteBranch, deleteRepoFile, writeRepoFile } from "../src/github.ts";
import { checkHoldout, type ScoreReport } from "../src/improve-scorer.ts";
import { mcpOriginProblem } from "../src/headers.ts";
import { tickRuns } from "../src/improve-run.ts";
import { anchorChecksum, parseScoresDoc, seedScoresDoc } from "../src/improve-scores.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2, withFetch, type FakeD1Options } from "./fakes.ts";
import { sseChange } from "./improve-fakes.ts";
import { sourceFiles } from "./source-files.ts";

// Audit fixes, one block per finding. Harnesses are the shared ones: fakes.ts for
// KV/D1/R2/fetch, source-files.ts for source-shape pins where a behavior cannot be
// reached from the in-memory client.

const workflowText = () =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "improve-score.yml"), "utf8");

// ci_dispatch refuses the scorer; repo writes refuse the self-repo

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

test("ci_dispatch refuses improve-score.yml before any network call", async () => {
  await withFetch({}, async (calls) => {
    await assert.rejects(
      () => ciDispatch(repoEnv("owner/repo"), "ns", { workflow: "improve-score.yml", ref: "main" }),
      /ci_dispatch refuses.*improve-score\.yml/s
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

// the run machine claims before it calls out

const SCORES = seedScoresDoc("capsid");
// One minute after the improve fake's pinned datetime('now') ("2026-09-01
// 08:05:00", improve-fakes.ts), so a row the claim CAS just stamped reads as
// seconds old, the way it would in production, rather than as three days stale.
const NOW = new Date("2026-09-01T08:06:00Z");

async function runHarness(runs: Array<Record<string, unknown>>) {
  const pin = await anchorChecksum(parseScoresDoc("capsid", SCORES));
  const d1 = fakeD1({
    documents: [{ namespace: "capsid", path: "improve/scores.md", title: "scores", body: SCORES, type: "reference" }],
    namespaces: [{ namespace: "capsid", repos: JSON.stringify([{ repo: "owner/capsid-mcp", label: "primary" }]) }],
    improveRuns: runs,
  });
  const kv = fakeKv({ seed: { "improve:anchor:capsid": pin }, seedToken: true });
  const env = fakeEnv({
    DB: d1.db,
    APP_KV: kv.kv,
    HOLDOUT: fakeR2({}).bucket,
    MEDIA: fakeR2({}).bucket,
    ANTHROPIC_API_KEY: "sk-test",
    GITHUB_APP_CLIENT_ID: "x",
    GITHUB_APP_PRIVATE_KEY: "x",
  });
  return { d1, env };
}

test("two concurrent ticks on an 'opening' run dispatch the baseline ONCE", async () => {
  await withFetch(
    {
      "POST /repos/owner/capsid-mcp/git/refs": { status: 201, body: {} },
      "GET /repos/owner/capsid-mcp": { body: { default_branch: "main" } },
      "POST /repos/owner/capsid-mcp/actions/workflows/improve-score.yml/dispatches": { status: 204 },
    },
    async (calls) => {
      const { d1, env } = await runHarness([
        { id: "capsid-r9", namespace: "capsid", mode: "api", started: "2026-09-01 08:00:00", status: "opening", base_sha: "base000", advanced_at: "2026-09-01 08:04:00" },
      ]);
      await Promise.all([tickRuns(env, NOW), tickRuns(env, NOW)]);
      const dispatches = calls.filter((c) => /\/dispatches$/.test(c.path));
      assert.equal(dispatches.length, 1, "the loser tick dispatched the baseline a second time");
      assert.equal(d1.rows.improve_runs[0].status, "awaiting-score");
    }
  );
});

test("two concurrent ticks on an 'attempting' run reach the model ONCE", async () => {
  // No GitHub routes on purpose: the winner's push fails after the model call. Only
  // one tick may spend the Anthropic call; the loser must stop at the claim.
  await withFetch(
    {
      "POST /v1/messages": { contentType: "text/event-stream", text: sseChange([{ path: "src/x.ts", content: "y" }]) },
    },
    async (calls) => {
      const { env } = await runHarness([
        { id: "capsid-r9", namespace: "capsid", mode: "api", started: "2026-09-01 08:00:00", status: "attempting", attempts: 0, base_sha: "base000", advanced_at: "2026-09-01 08:04:00" },
      ]);
      await Promise.all([tickRuns(env, NOW), tickRuns(env, NOW)]);
      const model = calls.filter((c) => c.path === "/v1/messages");
      assert.equal(model.length, 1, "both ticks paid for an Anthropic call");
    }
  );
});

test("a tick leaves a FRESH 'judging' run alone; only a stale one is returned to awaiting-score", async () => {
  await withFetch({}, async () => {
    const base = { id: "capsid-r9", namespace: "capsid", mode: "api", started: "2026-09-01 08:00:00", current_attempt: "capsid-r9-a01", attempts: 1 };
    const fresh = await runHarness([{ ...base, status: "judging", advanced_at: "2026-09-01 08:04:00" }]);
    const freshOut = await tickRuns(fresh.env, NOW);
    assert.equal(fresh.d1.rows.improve_runs[0].status, "judging", "a live ingest's run was yanked back mid-decision");
    assert.equal(freshOut[0].to, "judging");

    const stale = await runHarness([{ ...base, status: "judging", advanced_at: "2026-09-01 07:00:00" }]);
    const staleOut = await tickRuns(stale.env, NOW);
    assert.equal(stale.d1.rows.improve_runs[0].status, "awaiting-score", "a dead ingest's run stayed stranded in judging");
    assert.equal(staleOut[0].to, "awaiting-score");
  });
});

// scanner-rule: CLAUDE.md, path mutation rule: every run transition is a CAS whose result is read. It
// covers every call site in ingestScore, including ones added later, which no single
// lost-CAS test can.
test("every advanceRun inside ingestScore checks its result", () => {
  const owner = sourceFiles().find((f) => f.text.includes("export async function ingestScore"));
  assert.ok(owner, "could not locate ingestScore under src/");
  const start = owner.text.indexOf("export async function ingestScore");
  const end = owner.text.indexOf("async function maybeAbstract");
  assert.ok(start >= 0 && end > start, `could not bound ingestScore in src/${owner.name}`);
  const body = owner.text.slice(start, end);
  const all = body.match(/await advanceRun\(/g) ?? [];
  const checked = body.match(/=\s*await advanceRun\(/g) ?? [];
  assert.ok(all.length >= 3, `ingestScore has ${all.length} advanceRun calls; the transitions moved?`);
  assert.equal(all.length, checked.length, "an advanceRun in ingestScore discards its result: a lost CAS would go unnoticed");
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

// bounds: lint consumed, ci_dispatch inputs, history

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

test("lint finalize refuses more than 20 consumed paths at the schema", async () => {
  const { d1, call, close } = await serverClient();
  const consumed = Array.from({ length: 21 }, (_, i) => `ep-${i}.md`);
  const result = await call("lint", { namespace: "capsid", mode: "finalize", consumed, confirm: true });
  await close();
  assert.equal(result.isError, true, "21 consumed paths were accepted");
  assert.match(
    result.content[0].text,
    /20|too_big|at most/i,
    "the refusal must come from the schema bound, not from a later check that happened to fail"
  );
  assert.equal(d1.recorded.length, 0, "statements were issued for an over-sized consumed array");
});

test("ci_dispatch refuses more than 10 workflow inputs at the schema", async () => {
  const { call, close } = await serverClient();
  const inputs = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"]));
  const result = await call("ci_dispatch", { namespace: "capsid", workflow: "ci.yml", ref: "main", inputs });
  await close();
  assert.equal(result.isError, true, "11 dispatch inputs were accepted (GitHub's own ceiling is 10)");
  assert.match(
    result.content[0].text,
    /at most 10 workflow inputs/,
    "the refusal must come from the inputs bound, not from a later check that happened to fail"
  );
});

// The history bound and the live-row snapshot are proven against real SQLite in
// test-integration/live-snapshot.test.ts, because the node fake neither honours
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

// an empty holdout manifest is a refusal

test("a manifest declaring zero holdout tests is refused, not scored as a pass", () => {
  const report: ScoreReport = {
    namespace: "capsid",
    run_id: "r",
    attempt_id: "a",
    head_sha: "h",
    jti: "j",
    anchors: { build_passes: 1 },
    secondary: { test_pass_rate: null, lint_count: null, error_count: null, p95_latency_ms: null, bundle_size_bytes: null },
    holdout: { total: 0, passed: 0 },
    ci_minutes: 0,
  };
  const verdict = checkHoldout({ namespace: "capsid", total: 0, updated_at: "2026-09-01T00:00:00Z" }, report);
  assert.equal(verdict.ok, false, "an empty hidden suite scored exactly like a passing one");
  assert.match(String(verdict.refusal), /zero|empty/i);
  assert.equal(verdict.passRate, null);
});

// the scorer's ids come from the Post step's own env

test("RUN_ID and ATTEMPT_ID are read only from the Post step's own env", () => {
  const yml = workflowText();
  const post = yml.slice(yml.indexOf("- name: Post the score report"));
  assert.ok(post.length > 100, "could not locate the Post step");
  const env = post.slice(post.indexOf("env:"), post.indexOf("run: |"));
  assert.match(env, /RUN_ID: \$\{\{ inputs\.run_id \}\}/, "RUN_ID is not bound in the Post step's own env");
  assert.match(env, /ATTEMPT_ID: \$\{\{ inputs\.attempt_id \}\}/, "ATTEMPT_ID is not bound in the Post step's own env");
  // And nothing anywhere in the workflow writes either id into GITHUB_ENV, which
  // is the cross-step injection the env placement exists to defeat.
  assert.ok(!/RUN_ID[^\n]*GITHUB_ENV/.test(yml), "a step writes RUN_ID into GITHUB_ENV");
  assert.ok(!/ATTEMPT_ID[^\n]*GITHUB_ENV/.test(yml), "a step writes ATTEMPT_ID into GITHUB_ENV");
});
