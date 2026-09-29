import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { defaultScopes } from "../src/agents-schema.ts";
import type { Agent } from "../src/agents.ts";
import { CLAIMS_EXPORT_MAX, CLAIMS_EXPORT_TABLES, CLAIMS_JOB_ROWS, claimsFilterFrom, exportClaimsPage, median, readClaimsAggregate, readJobClaims } from "../src/job-claims-read.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// The read side of claims apart from verified outcomes (src/job-claims-read.ts). These
// are the statement-shape and folding tests; the rows a real job_claims returns, the
// export's paging over a real table and the tool's refusals through a real D1 are in
// test-integration/claims-tool.test.ts.

interface Call {
  sql: string;
  params: unknown[];
}

// A D1 that records every statement and answers from `answer`, so the folding in
// TypeScript is tested against rows chosen here and the SQL's shape is read directly.
function stubDb(answer: (sql: string, params: unknown[]) => Record<string, unknown>[] = () => []) {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      const flat = sql.replace(/\s+/g, " ").trim();
      return {
        bind(...params: unknown[]) {
          calls.push({ sql: flat, params });
          return {
            all: async () => ({ results: answer(flat, params) }),
            first: async () => answer(flat, params)[0] ?? null,
          };
        },
      };
    },
  };
  return { db: db as never, calls };
}

// The value bound to a statement's LIMIT, read by the index the LIMIT names.
function limitOf(call: Call): unknown {
  const m = /LIMIT \?(\d+)/.exec(call.sql);
  assert.ok(m, `no LIMIT in: ${call.sql}`);
  return call.params[Number(m[1]) - 1];
}

// the filter

test("the filter trims its values, and an empty value is no filter", () => {
  const parsed = claimsFilterFrom({ namespace: " sample ", agent: "", since: "  ", until: undefined });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.filter, { namespace: "sample", agent: null, since: null, until: null });
});

test("since and until are normalized to the stored ISO shape, so a text comparison orders them", () => {
  const parsed = claimsFilterFrom({ since: "2026-09-01", until: "2026-09-02T12:00:00Z" });
  assert.ok(parsed.ok);
  assert.equal(parsed.filter.since, "2026-09-01T00:00:00.000Z");
  assert.equal(parsed.filter.until, "2026-09-02T12:00:00.000Z");
});

test("a time that is not ISO is refused, not guessed at", () => {
  for (const since of ["yesterday", "09/01/2026", "2026-9-1", "2026-13-45"]) {
    const parsed = claimsFilterFrom({ since });
    assert.equal(parsed.ok, false, `${since} was accepted`);
    if (!parsed.ok) assert.match(parsed.refusal, /since must be an ISO 8601 time/);
  }
});

test("since at or after until is refused, since it can match nothing", () => {
  const parsed = claimsFilterFrom({ since: "2026-09-02", until: "2026-09-01" });
  assert.equal(parsed.ok, false);
});

test("median: the middle value, the rounded mean of the middle two, and null for nothing", () => {
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([1, 2, 3, 4]), 3);
  assert.equal(median([5]), 5);
  // No wait measured is not a wait of zero.
  assert.equal(median([]), null);
});

// the aggregate

test("every aggregate filter value is BOUND, never interpolated, and every read is bounded", async () => {
  const { db, calls } = stubDb();
  const hostile = "sample'; DROP TABLE job_claims; --";
  await readClaimsAggregate(db, { namespace: hostile, agent: "agent:x", since: "2026-09-01T00:00:00.000Z", until: null });
  assert.equal(calls.length, 3, `expected the claims, evaluations and touches reads, got ${calls.length}`);
  for (const call of calls) {
    assert.doesNotMatch(call.sql, /DROP TABLE/, "a filter value reached the SQL text");
    assert.ok(call.params.includes(hostile), `the namespace was not bound: ${call.sql}`);
    assert.ok(call.params.includes("agent:x"));
    assert.ok(call.params.includes(null), "an absent until must be bound as null, not dropped");
    assert.equal(typeof limitOf(call), "number", `unbounded: ${call.sql}`);
    assert.doesNotMatch(call.sql, /\b(INSERT|UPDATE|DELETE)\b/i, "a reader wrote");
  }
});

test("the aggregate folds claims, evaluations and touches into one group per agent and namespace", async () => {
  const { db } = stubDb((sql) => {
    if (sql.includes("COUNT(DISTINCT job_id)")) {
      return [{ agent: "agent:sample-driver", namespace: "sample", jobs: 2, claims: 3 }];
    }
    if (sql.includes("FROM job_evaluations")) {
      return [
        { agent: "agent:sample-driver", namespace: "sample", name: "commits", agreement: "agree", n: 1 },
        { agent: "agent:sample-driver", namespace: "sample", name: "commits", agreement: "disagree", n: 2 },
        { agent: "agent:sample-driver", namespace: "sample", name: "ci_green", agreement: "unclaimed", n: 3 },
      ];
    }
    if (sql.includes("FROM job_touches")) {
      return [
        { agent: "agent:sample-driver", namespace: "sample", kind: "gate", actor_kind: "driver", waited_ms: null },
        { agent: "agent:sample-driver", namespace: "sample", kind: "approval", actor_kind: "human", waited_ms: 1000 },
        { agent: "agent:sample-driver", namespace: "sample", kind: "resume", actor_kind: "seat", waited_ms: 3000 },
        { agent: null, namespace: "sample-b", kind: "release", actor_kind: "seat", waited_ms: null },
      ];
    }
    return [];
  });
  const out = await readClaimsAggregate(db, { namespace: null, agent: null, since: null, until: null });
  assert.deepEqual(out.truncated, []);
  assert.equal(out.groups.length, 2);
  const driver = out.groups.find((g) => g.agent === "agent:sample-driver")!;
  assert.equal(driver.jobs, 2);
  assert.equal(driver.claims, 3);
  assert.deepEqual(driver.evaluations.commits, { agree: 1, disagree: 2, unclaimed: 0, unchecked: 0 });
  assert.deepEqual(driver.evaluations.ci_green, { agree: 0, disagree: 0, unclaimed: 3, unchecked: 0 });
  assert.equal(driver.touches.count, 3);
  assert.deepEqual(driver.touches.by_kind, { gate: 1, approval: 1, resume: 1 });
  assert.deepEqual(driver.touches.by_actor_kind, { driver: 1, human: 1, seat: 1 });
  // The gate carries no wait, so two waits, not three.
  assert.equal(driver.touches.waits, 2);
  assert.equal(driver.touches.waited_ms_total, 4000);
  assert.equal(driver.touches.waited_ms_median, 2000);
  // A touch on a job nobody claimed keeps its own group, with no wait rather than a zero one.
  const unclaimed = out.groups.find((g) => g.agent === null)!;
  assert.equal(unclaimed.namespace, "sample-b");
  assert.equal(unclaimed.claims, 0);
  assert.equal(unclaimed.touches.waited_ms_total, null);
  assert.equal(unclaimed.touches.waited_ms_median, null);
});

test("PLANT: a read that hits its bound says so by name instead of passing as whole", async () => {
  // The stub answers every read with as many rows as its LIMIT asks for, which is one
  // past the bound, so each read must report the cut.
  const { db } = stubDb((sql, params) => {
    const limit = Number(params[Number(/LIMIT \?(\d+)/.exec(sql)![1]) - 1]);
    return Array.from({ length: limit }, (_, i) =>
      sql.includes("FROM job_touches")
        ? { agent: `agent:a${i}`, namespace: "sample", kind: "gate", actor_kind: "driver", waited_ms: null }
        : sql.includes("FROM job_evaluations")
          ? { agent: `agent:a${i}`, namespace: "sample", name: "commits", agreement: "agree", n: 1 }
          : { agent: `agent:a${i}`, namespace: "sample", jobs: 1, claims: 1 }
    );
  });
  const out = await readClaimsAggregate(db, { namespace: null, agent: null, since: null, until: null });
  assert.deepEqual([...out.truncated].sort(), ["evaluations", "groups", "touches"]);
});

test("an agreement outside the table's vocabulary is an error, never a silent drop", async () => {
  const { db } = stubDb((sql) =>
    sql.includes("FROM job_evaluations") ? [{ agent: "agent:x", namespace: "sample", name: "commits", agreement: "maybe", n: 1 }] : []
  );
  await assert.rejects(readClaimsAggregate(db, { namespace: null, agent: null, since: null, until: null }), /agreement 'maybe'/);
});

// one job

test("a job that does not exist reads as null", async () => {
  const { db } = stubDb();
  assert.equal(await readJobClaims(db, "job_000000000000"), null);
});

test("one job's rows are bound to its id, bounded, and cut at CLAIMS_JOB_ROWS with the cut named", async () => {
  const { db, calls } = stubDb((sql, params) => {
    if (sql.startsWith("SELECT id, namespace, title, status, claimed_by FROM jobs")) {
      return [{ id: params[0], namespace: "sample", title: "a job", status: "done", claimed_by: "agent:sample-driver" }];
    }
    if (sql.includes("FROM job_outcomes")) return [];
    if (sql.includes("FROM job_touches")) return Array.from({ length: CLAIMS_JOB_ROWS + 1 }, (_, i) => ({ id: i + 1 }));
    return [{ id: 1 }];
  });
  const out = await readJobClaims(db, "job_0123456789ab");
  assert.ok(out);
  assert.equal(out.job.id, "job_0123456789ab");
  assert.equal(out.outcome, null, "a job with no outcome row must say null, not an empty object");
  assert.equal(out.claims.length, 1);
  assert.equal(out.touches.length, CLAIMS_JOB_ROWS);
  assert.deepEqual(out.truncated, ["touches"]);
  for (const call of calls) {
    assert.equal(call.params[0], "job_0123456789ab", `not bound to the job id: ${call.sql}`);
    if (/job_(claims|evaluations|touches)/.test(call.sql)) assert.equal(limitOf(call), CLAIMS_JOB_ROWS + 1);
  }
});

// export

test("export reads each table through its own statement, and never names a table from input", async () => {
  const { db, calls } = stubDb();
  for (const table of CLAIMS_EXPORT_TABLES) await exportClaimsPage(db, table, 0, 10);
  assert.equal(calls.length, CLAIMS_EXPORT_TABLES.length);
  for (const [i, table] of CLAIMS_EXPORT_TABLES.entries()) {
    assert.match(calls[i].sql, new RegExp(`FROM ${table} WHERE ${table === "job_outcomes" ? "rowid" : "id"} > \\?1`));
    assert.deepEqual(calls[i].params, [0, 11], "the page asks one row past its limit, to know whether there is a next");
  }
  await assert.rejects(exportClaimsPage(db, "documents" as never, 0, 10), /not an exportable table/);
  await assert.rejects(exportClaimsPage(db, "job_claims", 0, CLAIMS_EXPORT_MAX + 1), /limit must be/);
  await assert.rejects(exportClaimsPage(db, "job_claims", -1, 10), /after must be/);
  assert.equal(calls.length, CLAIMS_EXPORT_TABLES.length, "a refused export reached the store");
});

test("export's cursor is the last row handed out, and null when the page reached the end", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
  const { db } = stubDb((_sql, params) => rows.filter((r) => r.id > Number(params[0])).slice(0, Number(params[1])));
  const first = await exportClaimsPage(db, "job_claims", 0, 2);
  assert.deepEqual(first.rows.map((r) => r.id), [1, 2]);
  assert.equal(first.next_after, 2);
  const last = await exportClaimsPage(db, "job_claims", 4, 2);
  assert.deepEqual(last.rows.map((r) => r.id), [5]);
  assert.equal(last.next_after, null);
  // Exactly a full last page: the extra row asked for is absent, so there is no next.
  const exact = await exportClaimsPage(db, "job_claims", 3, 2);
  assert.deepEqual(exact.rows.map((r) => r.id), [4, 5]);
  assert.equal(exact.next_after, null);
});

// the tool

function driver(): Agent {
  const scopes = defaultScopes(["sample"]);
  scopes.grants = ["read", "write"];
  return { id: "agent_driver00001", name: "sample-driver", kind: "driver", actor: "agent:sample-driver", scopes, admin: false, row: null };
}

test("the claims tool refuses a write-grant driver as admin only, before its handler reads anything", async () => {
  let prepared = 0;
  const d1 = fakeD1();
  const db = {
    prepare: (sql: string) => {
      prepared += 1;
      return d1.db.prepare(sql);
    },
    batch: (statements: unknown[]) => d1.db.batch(statements as never),
  };
  const server = buildServer(fakeEnv({ DB: db, APP_KV: fakeKv({}).kv }), driver());
  const client = new Client({ name: "claims-unit", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    for (const args of [{}, { action: "job", id: "job_0123456789ab" }, { action: "export", table: "job_claims" }]) {
      const result = (await client.callTool({ name: "claims", arguments: { namespace: "sample", ...args } })) as { isError?: boolean; content: Array<{ text: string }> };
      assert.equal(result.isError, true, `a driver read claims: ${result.content[0].text}`);
      assert.match(result.content[0].text, /'claims(\.[a-z]+)?' is admin only/);
    }
    assert.equal(prepared, 0, "the handler reached D1 for a caller it should never have run for");
  } finally {
    await client.close();
  }
});
