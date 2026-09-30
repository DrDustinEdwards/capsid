import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { adminAgentForEmail, legacyAgent, type Agent } from "../src/agents";
import { defaultScopes } from "../src/agents-schema";
import { buildServer } from "../src/server";
import type { ClaimsAggregate, ClaimsJob } from "../src/ops-types";
import type { ClaimsExportPage } from "../src/job-claims-read";

// The `claims` tool against a real D1 with migrations/0023 applied: what the admin
// reads back from rows planted here, what a driver and a read-only caller are refused,
// and the export's paging. The three tables are append-only (their triggers refuse
// DELETE on a row), so nothing here cleans up: each test plants rows under its own
// namespace and job ids, and filters by them.

const ADMIN = adminAgentForEmail("admin@example.com");
const READ_ONLY = legacyAgent("read", "opkey:readonly0000");
const AGENT = "agent:sample-driver";

function driver(): Agent {
  const scopes = defaultScopes(["sample"]);
  scopes.grants = ["read", "write"];
  return { id: "agent_driver00001", name: "sample-driver", kind: "driver", actor: AGENT, scopes, admin: false, row: null };
}

let seq = 0;
// A fresh namespace and job id per call, so tests sharing this file's storage never
// read each other's rows.
function fresh(prefix: string): { ns: string; job: string } {
  seq += 1;
  const n = `${Date.now().toString(16)}${seq.toString(16)}`.slice(-12).padStart(12, "0");
  return { ns: `${prefix}-${n}`, job: `job_${n}` };
}

interface Result {
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function callAs(caller: Agent, args: Record<string, unknown>): Promise<Result> {
  const server = buildServer(env as never, caller);
  const client = new Client({ name: "claims-tool", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.callTool({ name: "claims", arguments: args })) as Result;
  } finally {
    await client.close();
  }
}

async function adminRead<T>(args: Record<string, unknown>): Promise<T> {
  const result = await callAs(ADMIN, args);
  expect(result.isError, result.content[0].text).not.toBe(true);
  return JSON.parse(result.content[0].text) as T;
}

// One job that blocked once, was approved after a second, and completed: two claims,
// three checks on the completion, and three touches.
async function plantJob(ns: string, job: string): Promise<void> {
  const claimId = `(SELECT MAX(id) FROM job_claims WHERE job_id = ?1)`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO jobs (id, namespace, title, body, status, posted_by, claimed_by)
       VALUES (?1, ?2, 'a sample job', 'body', 'done', 'github:sample', ?3)`
    ).bind(job, ns, AGENT),
    env.DB.prepare(
      `INSERT INTO job_claims (job_id, action, agent, namespace, raw, recorded_at)
       VALUES (?1, 'block', ?2, ?3, '{"reason":"needs a push"}', '2026-09-01T10:00:00.000Z')`
    ).bind(job, AGENT, ns),
    env.DB.prepare(
      `INSERT INTO job_touches (job_id, namespace, kind, actor, actor_kind, waited_ms, detail, at)
       VALUES (?1, ?2, 'gate', ?3, 'driver', NULL, '{"reason":"needs a push"}', '2026-09-01T10:00:00.000Z')`
    ).bind(job, ns, AGENT),
    env.DB.prepare(
      `INSERT INTO job_touches (job_id, namespace, kind, actor, actor_kind, waited_ms, at)
       VALUES (?1, ?2, 'approval', 'access:admin@example.com', 'human', 1000, '2026-09-01T10:00:01.000Z')`
    ).bind(job, ns),
    env.DB.prepare(
      `INSERT INTO job_touches (job_id, namespace, kind, actor, actor_kind, waited_ms, at)
       VALUES (?1, ?2, 'note', 'access:admin@example.com', 'human', 3000, '2026-09-01T10:00:03.000Z')`
    ).bind(job, ns),
    env.DB.prepare(
      `INSERT INTO job_claims (job_id, action, agent, namespace, raw, prs_opened_urls, prs_opened, commits, recorded_at)
       VALUES (?1, 'complete', ?2, ?3, '{"evidence":{"commits":3}}', '["https://github.com/example/sample/pull/1"]', 1, 3, '2026-09-01T11:00:00.000Z')`
    ).bind(job, AGENT, ns),
    env.DB.prepare(
      `INSERT INTO job_evaluations (job_id, claim_id, name, score_value, score_label, claimed, verified, agreement, evaluator, evaluator_id, recorded_at)
       VALUES (?1, ${claimId}, 'commits', 2, 'pass', '3', '2', 'disagree', 'worker', 'capsid@unknown', '2026-09-01T11:00:00.000Z')`
    ).bind(job),
    env.DB.prepare(
      `INSERT INTO job_evaluations (job_id, claim_id, name, score_value, score_label, claimed, verified, agreement, evaluator, evaluator_id, recorded_at)
       VALUES (?1, ${claimId}, 'prs_opened', 1, 'pass', '1', '1', 'agree', 'worker', 'capsid@unknown', '2026-09-01T11:00:00.000Z')`
    ).bind(job),
    env.DB.prepare(
      `INSERT INTO job_evaluations (job_id, claim_id, name, score_value, score_label, claimed, verified, agreement, evaluator, evaluator_id, recorded_at)
       VALUES (?1, ${claimId}, 'ci_green', NULL, 'unknown', NULL, NULL, 'unclaimed', 'worker', 'capsid@unknown', '2026-09-01T11:00:00.000Z')`
    ).bind(job),
    env.DB.prepare(
      `INSERT INTO job_outcomes (job_id, agent, namespace, prs_opened, prs_merged, commits, blocked_count, resumed_count, result_kind, verified, recorded_at)
       VALUES (?1, ?2, ?3, 1, 1, 2, 1, 1, 'pr', '{}', '2026-09-01 11:00:00')`
    ).bind(job, AGENT, ns),
  ]);
}

describe("the claims tool, as the admin", () => {
  it("aggregate: per agent and namespace, the claims, each check's agreement, and the touches with their waits", async () => {
    const { ns, job } = fresh("claims-agg");
    await plantJob(ns, job);
    const out = await adminRead<ClaimsAggregate>({ namespace: ns });
    expect(out.filter).toEqual({ namespace: ns, agent: null, since: null, until: null });
    expect(out.truncated).toEqual([]);
    expect(out.groups).toHaveLength(1);
    const [group] = out.groups;
    expect(group.agent).toBe(AGENT);
    expect(group.namespace).toBe(ns);
    expect(group.jobs).toBe(1);
    expect(group.claims).toBe(2);
    expect(group.evaluations).toEqual({
      ci_green: { agree: 0, disagree: 0, unclaimed: 1, unchecked: 0 },
      commits: { agree: 0, disagree: 1, unclaimed: 0, unchecked: 0 },
      prs_opened: { agree: 1, disagree: 0, unclaimed: 0, unchecked: 0 },
    });
    expect(group.touches.count).toBe(3);
    expect(group.touches.by_kind).toEqual({ gate: 1, approval: 1, note: 1 });
    expect(group.touches.by_actor_kind).toEqual({ driver: 1, human: 2 });
    // The gate carries no wait: two waits, 1s and 3s.
    expect(group.touches.waits).toBe(2);
    expect(group.touches.waited_ms_total).toBe(4000);
    expect(group.touches.waited_ms_median).toBe(2000);
  });

  it("aggregate: since and until bound each table on its own time, and the agent filter is exact", async () => {
    const { ns, job } = fresh("claims-time");
    await plantJob(ns, job);
    // After the block and its touches, before nothing: only the completion and its checks.
    const late = await adminRead<ClaimsAggregate>({ namespace: ns, since: "2026-09-01T10:30:00Z" });
    expect(late.filter.since).toBe("2026-09-01T10:30:00.000Z");
    expect(late.groups).toHaveLength(1);
    expect(late.groups[0].claims).toBe(1);
    expect(late.groups[0].touches.count).toBe(0);
    expect(late.groups[0].touches.waited_ms_median).toBeNull();
    expect(late.groups[0].evaluations.commits.disagree).toBe(1);
    const early = await adminRead<ClaimsAggregate>({ namespace: ns, until: "2026-09-01T10:30:00Z" });
    expect(early.groups[0].claims).toBe(1);
    expect(early.groups[0].evaluations).toEqual({});
    expect(early.groups[0].touches.count).toBe(3);
    const nobody = await adminRead<ClaimsAggregate>({ namespace: ns, agent: "agent:someone-else" });
    expect(nobody.groups).toEqual([]);
    const refused = await callAs(ADMIN, { namespace: ns, since: "last tuesday" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/since must be an ISO 8601 time/);
  });

  it("job: the job, its outcome, and its claims, checks and touches oldest first, with NULL kept as null", async () => {
    const { ns, job } = fresh("claims-job");
    await plantJob(ns, job);
    const out = await adminRead<ClaimsJob>({ action: "job", id: job });
    expect(out.job).toEqual({ id: job, namespace: ns, title: "a sample job", status: "done", claimed_by: AGENT });
    expect(out.outcome?.job_id).toBe(job);
    expect(out.claims.map((c) => c.action)).toEqual(["block", "complete"]);
    const complete = out.claims[1];
    expect(complete.commits).toBe(3);
    expect(complete.prs_opened).toBe(1);
    // Not stated is null, never 0.
    expect(complete.files_changed).toBeNull();
    expect(complete.tests_run).toBeNull();
    expect(out.evaluations.map((e) => e.name)).toEqual(["commits", "prs_opened", "ci_green"]);
    for (const e of out.evaluations) expect(e.claim_id).toBe(complete.id);
    const commits = out.evaluations[0];
    expect([commits.claimed, commits.verified, commits.agreement]).toEqual(["3", "2", "disagree"]);
    expect(out.touches.map((t) => t.kind)).toEqual(["gate", "approval", "note"]);
    expect(out.limit).toBeGreaterThan(0);
    expect(out.truncated).toEqual([]);

    const missing = await callAs(ADMIN, { action: "job", id: "job_ffffffffffff" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/no job job_ffffffffffff/);
  });

  it("export: rows as stored with a cursor, the id for the three new tables and the rowid for job_outcomes", async () => {
    const { ns, job } = fresh("claims-exp");
    await plantJob(ns, job);
    const claims = await adminRead<ClaimsExportPage>({ action: "export", table: "job_claims", after: 0, limit: 1 });
    expect(claims.rows).toHaveLength(1);
    expect(claims.next_after).toBe(claims.rows[0].id);
    const outcomes = await adminRead<ClaimsExportPage>({ action: "export", table: "job_outcomes", limit: 500 });
    const row = outcomes.rows.find((r) => r.job_id === job);
    expect(row, "the planted outcome is not in the export").toBeTruthy();
    expect(typeof row!.rowid).toBe("number");
  });
});

describe("the claims tool, refused", () => {
  // scanner-rule: CLAUDE.md, one enforcement point rule. claims is admin only in
  // TOOL_GRANTS; the refusal must be checkScope's, before the handler reads anything.
  it("PLANT: a non-admin caller is refused claims", async () => {
    const { ns, job } = fresh("claims-refuse");
    await plantJob(ns, job);
    const calls: Array<Record<string, unknown>> = [
      { namespace: "sample" },
      { namespace: "sample", action: "job", id: job },
      { namespace: "sample", action: "export", table: "job_claims" },
    ];
    for (const args of calls) {
      const byDriver = await callAs(driver(), args);
      expect(byDriver.isError, `a write-grant driver read claims: ${byDriver.content[0].text}`).toBe(true);
      expect(byDriver.content[0].text).toMatch(/'claims\.[a-z]+' is admin only and agent:sample-driver is not the admin/);
      expect(byDriver.content[0].text).not.toContain(job);

      const byReader = await callAs(READ_ONLY, args);
      expect(byReader.isError, `a read-only caller read claims: ${byReader.content[0].text}`).toBe(true);
      expect(byReader.content[0].text).toMatch(/'claims' requires the write grant/);
      expect(byReader.content[0].text).not.toContain(job);
    }
    // The admin reads the same job, so the refusals above were about the caller.
    const out = await adminRead<ClaimsJob>({ action: "job", id: job });
    expect(out.job.id).toBe(job);
  });
});

describe("the export's paging", () => {
  it("PLANT: export pages never skip or repeat a row", async () => {
    // Enough rows, over several jobs, that a small page size takes many pages.
    for (let i = 0; i < 4; i++) {
      const { ns, job } = fresh("claims-page");
      await plantJob(ns, job);
    }
    for (const table of ["job_claims", "job_evaluations", "job_touches", "job_outcomes"] as const) {
      const cursor = table === "job_outcomes" ? "rowid" : "id";
      const { results } = await env.DB.prepare(`SELECT ${cursor} AS k FROM ${table} ORDER BY ${cursor}`).all<{ k: number }>();
      const expected = results.map((r) => r.k);
      expect(expected.length, `${table} has too few rows for paging to prove anything`).toBeGreaterThan(3);

      const seen: number[] = [];
      let after = 0;
      let pages = 0;
      for (;;) {
        const page = await adminRead<ClaimsExportPage>({ action: "export", table, after, limit: 3 });
        pages += 1;
        expect(page.rows.length).toBeLessThanOrEqual(3);
        seen.push(...page.rows.map((r) => r[cursor] as number));
        if (page.next_after === null) break;
        expect(page.next_after, `${table}: the cursor did not advance`).toBeGreaterThan(after);
        after = page.next_after;
        expect(pages, `${table}: paging did not end`).toBeLessThan(1000);
      }
      expect(new Set(seen).size, `${table}: a row was handed out twice`).toBe(seen.length);
      expect(seen, `${table}: the pages skipped or reordered a row`).toEqual(expected);
      expect(pages).toBeGreaterThan(1);
    }
  });
});
