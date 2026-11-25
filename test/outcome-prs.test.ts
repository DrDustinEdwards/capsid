import assert from "node:assert/strict";
import { test } from "node:test";
import { outcomePrStatements, prUrlsFromJob } from "../src/outcome-prs.ts";
import { parseEvidence } from "../src/job-outcomes.ts";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server.ts";
import { adminAgentForEmail } from "../src/agents.ts";
import { fakeD1, fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// Outcome rows are immutable except merge state: a driver never merges, so every row is written "opened, not merged";
// these cover the one path that corrects it.

function recorder() {
  const recorded: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => {
        recorded.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
        return {} as D1PreparedStatement;
      },
    }),
  } as unknown as D1Database;
  return { recorded, db };
}

test("one row per pull request the evidence named", () => {
  const { recorded, db } = recorder();
  const statements = outcomePrStatements(db, "job_1", [
    "https://github.com/o/r/pull/1",
    "https://github.com/o/r/pull/2",
  ]);
  assert.equal(statements.length, 2);
  assert.equal(recorded.length, 2);
  assert.match(recorded[0].sql, /INSERT INTO job_outcome_prs/);
  // With no merge state read, merged and merge_verified_at bind NULL: nobody counted, never 0, and no identity is pinned
  // (the sweep pins it on its first read).
  assert.deepEqual(recorded[0].params, [
    "job_1",
    "https://github.com/o/r/pull/1",
    null,
    null,
    null,
    null,
  ]);
});

test("a pull request complete read is pinned to the one GitHub answered with", () => {
  const { recorded, db } = recorder();
  const url = "https://github.com/o/r/pull/1";
  const now = new Date("2026-09-30T00:00:00.000Z");
  outcomePrStatements(db, "job_1", [url], { [url]: true }, now, {
    [url]: { node_id: "PR_one", created_at: "2026-09-29T00:00:00Z" },
  });
  assert.deepEqual(recorded[0].params, [
    "job_1",
    url,
    1,
    now.toISOString(),
    "PR_one",
    "2026-09-29T00:00:00Z",
  ]);
});

test("a repeated pull request is written once, because a batch conflict would abort the outcome write", () => {
  const { recorded, db } = recorder();
  outcomePrStatements(db, "job_1", [
    "https://github.com/o/r/pull/1",
    "https://github.com/o/r/pull/1",
    " ",
  ]);
  assert.equal(recorded.length, 1, "the duplicate and the blank are dropped before the batch");
  assert.deepEqual(outcomePrStatements(db, "job_1", []), [], "no pull requests, no rows");
});

test("pull request URLs are found in both result_ref and the summary prose", () => {
  const urls = prUrlsFromJob({
    result_ref: "https://github.com/DrDustinEdwards/capsid-mcp/pull/25",
    result_summary:
      "merged at cec9285, see https://github.com/DrDustinEdwards/capsid-mcp/pull/24 as well",
  });
  assert.deepEqual(urls.sort(), [
    "https://github.com/DrDustinEdwards/capsid-mcp/pull/24",
    "https://github.com/DrDustinEdwards/capsid-mcp/pull/25",
  ]);
  const same = "https://github.com/o/r/pull/7";
  assert.deepEqual(prUrlsFromJob({ result_ref: same, result_summary: `landed in ${same}` }), [
    same,
  ]);
});

test("a job with no pull request anywhere seeds nothing", () => {
  assert.deepEqual(
    prUrlsFromJob({
      result_ref: "capsid/some-doc.md",
      result_summary: "wrote a document",
    }),
    [],
  );
  assert.deepEqual(prUrlsFromJob({ result_ref: null, result_summary: null }), []);
});

test("a near-miss URL is not mistaken for a pull request", () => {
  const urls = prUrlsFromJob({
    result_ref: null,
    result_summary: "see https://github.com/o/r/issues/25 and https://github.com/o/r/pull/abc",
  });
  assert.deepEqual(urls, [], "an issue and a non-numeric pull path are neither of them evidence");
});

async function connectAdmin(db: unknown) {
  const server = buildServer(
    fakeEnv({ DB: db, APP_KV: fakeKv({ seedToken: true }).kv }),
    adminAgentForEmail("admin@example.com"),
  );
  const client = new Client({ name: "outcome-prs", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("a merge that fails to update an outcome does not fail the merge", async () => {
  // The merge already happened on GitHub, so an outcome bookkeeping failure must not
  // report it as failed.
  const statement = (sql: string) => {
    const stmt = {
      bind: () => stmt,
      first: async () => {
        if (/job_outcome_prs/.test(sql)) throw new Error("planted outcome failure");
        if (/FROM namespaces/.test(sql))
          return {
            repos: JSON.stringify([{ repo: "owner/repo", label: "primary" }]),
          };
        return null;
      },
      all: async () => {
        if (/job_outcome_prs/.test(sql)) throw new Error("planted outcome failure");
        return { results: [] };
      },
      run: async () => ({ meta: {} }),
    };
    return stmt;
  };
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  try {
    await withFetch(
      {
        "GET /repos/owner/repo": { body: { default_branch: "main" } },
        "GET /repos/owner/repo/pulls/7": {
          body: {
            number: 7,
            state: "open",
            merged: false,
            head: { ref: "feat/x", sha: "abc" },
            base: { ref: "main" },
          },
        },
        "PUT /repos/owner/repo/pulls/7/merge": {
          body: { merged: true, sha: "m1" },
        },
        "DELETE /repos/owner/repo/git/refs/heads/feat/x": { status: 204 },
      },
      async () => {
        const client = await connectAdmin({
          prepare: statement,
          batch: async () => [],
        });
        const result = (await client.callTool({
          name: "capsid_close_pr",
          arguments: { namespace: "capsid", number: 7, action: "merge" },
        })) as { isError?: boolean; content: Array<{ text: string }> };
        await client.close();
        assert.notEqual(result.isError, true, result.content[0]?.text);
        assert.equal(JSON.parse(result.content[0].text).merged, true);
      },
    );
  } finally {
    console.error = original;
  }
  assert.ok(
    errors.some((e) => JSON.parse(e).message.startsWith("OUTCOME_REVERIFY_FAILED pr 7")),
    "the planted failure did not reach the re-verification",
  );
});

test("the same evidence as a JSON string parses to the same thing", () => {
  // A session whose cached tool schema predates the object form can still attach
  // evidence.
  const evidence = {
    prs: ["https://github.com/o/r/pull/1"],
    commits: 6,
    files_changed: 19,
    tests_added: 75,
  };
  const fromString = parseEvidence(JSON.stringify(evidence));
  assert.ok("evidence" in fromString);
  assert.deepEqual(fromString.evidence, evidence);
});

test("JSON that is not an object is refused", () => {
  for (const bad of ["[1,2,3]", '"a string"', "42", "null"]) {
    assert.ok("error" in parseEvidence(bad), `${bad} must be refused`);
  }
});

test("a count that is not a non-negative integer is dropped rather than coerced to zero", () => {
  // A stored 0 reads as "somebody counted and the answer was none", which is a
  // different fact from "nobody counted".
  const parsed = parseEvidence(
    JSON.stringify({ commits: -3, files_changed: "many", tests_added: 1.5 }),
  );
  assert.ok("evidence" in parsed);
  assert.deepEqual(parsed.evidence, {});
});

test("a non-string entry in prs is dropped and the rest survive", () => {
  const parsed = parseEvidence(JSON.stringify({ prs: ["https://github.com/o/r/pull/1", 7, null] }));
  assert.ok("evidence" in parsed);
  assert.deepEqual(parsed.evidence?.prs, ["https://github.com/o/r/pull/1"]);
});

test("the tool refuses an unparseable evidence string and writes nothing", async () => {
  const d1 = fakeD1({});
  const client = await connectAdmin(d1.db);
  const result = (await client.callTool({
    name: "capsid_work_jobs",
    arguments: {
      action: "complete",
      namespace: "capsid",
      id: "job_000000000001",
      result_summary: "done",
      evidence: "6 commits, 19 files",
    },
  })) as { isError?: boolean; content: Array<{ text: string }> };
  await client.close();
  assert.equal(result.isError, true);
  assert.match(
    result.content[0]?.text ?? "",
    /not JSON/,
    "an unparseable evidence string was not refused",
  );
  assert.deepEqual(d1.batches, [], "a refused complete still wrote");
});
