import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { blockJob, claimJob, completeJob, failJob, postJob, resumeJob } from "../src/jobs";
import { improveStatus } from "../src/improve-run";
import { reverifyStatements } from "../src/outcome-prs";
import { outcomeStatement } from "../src/job-outcomes";
import { legacyAgent } from "../src/agents";
import { buildServer } from "../src/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// JOBS AS EVIDENCE, AGAINST A REAL D1 (migrations/0011).
//
// Here rather than beside the unit tests for the reason test-integration/jobs.test.ts
// already states about the queue: every property below is a property of the DATABASE.
// "Exactly one outcome row per job" is a PRIMARY KEY, and a bar checked at the claim
// is a refusal a real UPDATE either did or did not perform. A fake answering on SQL
// shape would agree with whatever it was asked.

const SECRET = "test-root-secret";
const SEAT = "github:DrDustinEdwards";
const DRIVER_ACTOR = "opkey:aaaabbbbcccc";
const DRIVER = legacyAgent("write", DRIVER_ACTOR);

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

const at = (iso: string) => new Date(iso);
const NOW = at("2026-09-10T12:00:00.000Z");

async function post(over: Record<string, unknown> = {}) {
  return postJob(jobsEnv(), legacyAgent("write", SEAT), NOW, {
    namespace: "capsid",
    title: "a job",
    body: "do the thing",
    ...over,
  } as Parameters<typeof postJob>[3]);
}

async function jobRow(id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<Record<string, unknown>>();
}

async function outcomeRow(id: string) {
  return env.DB.prepare("SELECT * FROM job_outcomes WHERE job_id = ?1").bind(id).first<Record<string, unknown>>();
}

async function outcomeCount(id: string) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM job_outcomes WHERE job_id = ?1")
    .bind(id)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

const UNVERIFIED = JSON.stringify({
  prs_opened: false,
  prs_merged: false,
  commits: false,
  files_changed: false,
  ci_green: false,
});

const FULLY_VERIFIED = JSON.stringify({
  prs_opened: true,
  prs_merged: true,
  commits: true,
  files_changed: true,
  ci_green: false,
});

// A record planted directly, which is how a driver acquires a history without this
// suite having to drive GitHub. The verified column is the argument of each test.
async function plantOutcome(jobId: string, opened: number, merged: number, verified: string) {
  await env.DB.prepare(
    `INSERT INTO job_outcomes (job_id, agent, namespace, prs_opened, prs_merged, blocked_count, resumed_count,
       result_kind, verified, recorded_at)
     VALUES (?1, ?2, 'capsid', ?3, ?4, 0, 0, 'pr', ?5, '2026-09-01')`
  )
    .bind(jobId, DRIVER_ACTOR, opened, merged, verified)
    .run();
}

// A MINTED AGENT ROW, because agentSummaries reads the agents TABLE and the fixture
// never wrote to it. Everything else here drives the queue as a legacy operator key,
// which resolves to a caller without ever inserting a row, so `status.agents` was []
// on every run and the per-credential assertions below iterated nothing. Added
// 2026-09-13 when a count check turned that vacuous pass into a failure.
async function seedAgent(name: string) {
  await env.DB
    .prepare(
      `INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at)
       VALUES (?1, ?2, 'driver', ?3, ?4, 'github:DrDustinEdwards', '2026-09-10 00:00:00')`
    )
    .bind(
      `agent_${name.slice(0, 12).padEnd(12, "0")}`,
      name,
      `hash-${name}`,
      JSON.stringify({ namespaces: ["capsid"], repos: ["DrDustinEdwards/capsid"], tools: "*", grants: ["read", "write"], flags: {} })
    )
    .run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM job_outcomes").run();
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("DELETE FROM audit_log").run();
  await env.DB.prepare("DELETE FROM agents").run();
  await env.DB.prepare("DELETE FROM job_outcome_prs").run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
  // jobs post requires a registered namespace (audit 2026-09-25, F2-8).
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)").bind("capsid", JSON.stringify([{ repo: "example/capsid", label: "primary" }])).run();
});

describe("job outcomes", () => {
  it("a completed job gets EXACTLY ONE outcome row, attributed to its holder", async () => {
    const posted = await post({ title: "completes" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    const done = await completeJob(jobsEnv(), DRIVER, at("2026-09-10T13:30:00.000Z"), id, {
      result_summary: "landed",
      result_ref: "capsid/decisions.md",
    });
    expect(done.ok, done.refusal).toBe(true);

    expect(await outcomeCount(id)).toBe(1);
    const row = await outcomeRow(id);
    expect(row?.agent).toBe(DRIVER_ACTOR);
    expect(row?.namespace).toBe("capsid");
    expect(row?.result_kind).toBe("doc");
    expect(row?.duration_minutes).toBe(90);
    // NULL, NOT ZERO. Nothing was reported and nothing was checked, and those are
    // different from a count that came back empty.
    expect(row?.prs_opened).toBeNull();
    expect(row?.tests_added).toBeNull();
    expect(row?.ci_green).toBeNull();
    expect(JSON.parse(String(row?.verified))).toEqual(JSON.parse(UNVERIFIED));
  });

  it("a reported zero is stored as zero, beside a null nobody reported", async () => {
    const posted = await post({ title: "counts zero" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    await completeJob(jobsEnv(), DRIVER, NOW, id, {
      result_summary: "no tests needed",
      evidence: { tests_added: 0 },
    });
    const row = await outcomeRow(id);
    expect(row?.tests_added).toBe(0);
    expect(row?.commits).toBeNull();
  });

  it("the jobs tool takes evidence as an object and as a JSON string, and both land in the row", async () => {
    // Some MCP clients send an object argument as a JSON string. Both forms are
    // accepted at the tool's schema; this proves each one reaches the outcome row
    // rather than only that neither was refused.
    const server = buildServer(jobsEnv() as never, DRIVER);
    const client = new Client({ name: "evidence-forms", version: "1.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      const evidence = { tests_added: 3 };
      for (const [form, sent] of [["object", evidence], ["string", JSON.stringify(evidence)]] as const) {
        const id = (await post({ title: `evidence as ${form}` })).job!.id;
        expect((await claimJob(jobsEnv(), DRIVER, NOW, { id })).ok).toBe(true);
        const result = (await client.callTool({
          name: "jobs",
          arguments: { action: "complete", namespace: "capsid", id, result_summary: "done", evidence: sent },
        })) as { isError?: boolean; content: Array<{ text: string }> };
        expect(result.isError, `${form}: ${result.content[0]?.text}`).toBeFalsy();
        expect((await jobRow(id))?.status, form).toBe("done");
        expect((await outcomeRow(id))?.tests_added, `evidence as a JSON ${form} did not reach the outcome row`).toBe(3);
      }
    } finally {
      await client.close();
    }
  });

  it("A FAILED JOB IS RECORDED TOO, because a record of successes only is not a record", async () => {
    const posted = await post({ title: "fails" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    await failJob(jobsEnv(), DRIVER, NOW, id, "the approach did not work");
    expect(await outcomeCount(id)).toBe(1);
    expect((await outcomeRow(id))?.result_kind).toBe("none");
  });

  it("a gated job carries its gate counts, and its duration runs from the FIRST claim", async () => {
    const posted = await post({ title: "gated" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    await blockJob(jobsEnv(), DRIVER, at("2026-09-10T12:30:00.000Z"), id, {
      reason: "needs a push",
      command: "git push origin feat/x",
    });
    // A day passes while a human runs the command. Ruled 2026-09-16: the duration still
    // measures from the first claim, because measuring from the resume reported
    // job_6bbd77bc4827's working life as its last few seconds.
    await resumeJob(jobsEnv(), DRIVER, at("2026-09-11T12:00:00.000Z"), id, "Dustin ran it");
    await completeJob(jobsEnv(), DRIVER, at("2026-09-11T12:20:00.000Z"), id, { result_summary: "done" });

    const row = await outcomeRow(id);
    expect(row?.duration_minutes).toBe(1460);
    expect(row?.blocked_count).toBe(1);
    expect(row?.resumed_count).toBe(1);
  });

  it("PLANT: a second insert for the same job cannot overwrite the first record", async () => {
    // Planted rather than read off the DDL. An outcome that could be rewritten after
    // the fact is not evidence, so the guarantee is exercised against a real insert.
    const posted = await post({ title: "cannot be rewritten" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "first" });
    const before = await outcomeRow(id);

    await env.DB.prepare(
      `INSERT INTO job_outcomes (job_id, agent, namespace, prs_merged, blocked_count, resumed_count,
         result_kind, verified, recorded_at)
       VALUES (?1, 'agent:impostor', 'capsid', 999, 0, 0, 'pr', '{}', '2030-01-01')
       ON CONFLICT(job_id) DO NOTHING`
    )
      .bind(id)
      .run();

    expect(await outcomeCount(id)).toBe(1);
    const after = await outcomeRow(id);
    expect(after?.agent).toBe(before?.agent);
    expect(after?.prs_merged).toBeNull();
  });

  it("PLANT: the writer's own statement defers to the first record, and a second batch still commits", async () => {
    // The test above plants its own SQL. This one sends outcomeStatement twice: without
    // ON CONFLICT DO NOTHING the second batch would abort on the primary key, taking the
    // transition that carries it with it.
    const row = (agent: string, merged: number | null) => ({
      job_id: "job_000000000abc",
      agent,
      namespace: "capsid",
      prs_opened: null,
      prs_merged: merged,
      commits: null,
      files_changed: null,
      tests_added: null,
      ci_green: null,
      blocked_count: 0,
      resumed_count: 0,
      duration_minutes: null,
      result_kind: "none" as const,
      verified: UNVERIFIED,
      skill_ids_offered: null,
      skill_ids_used: null,
      recorded_at: NOW.toISOString(),
    });
    await env.DB.batch([outcomeStatement(env.DB, row(DRIVER_ACTOR, null))]);
    await env.DB.batch([
      outcomeStatement(env.DB, row("agent:impostor", 999)),
      env.DB.prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('test', 'second-batch', 'capsid', NULL, '{}')"),
    ]);
    expect(await outcomeCount("job_000000000abc")).toBe(1);
    expect((await outcomeRow("job_000000000abc"))?.agent).toBe(DRIVER_ACTOR);
    const second = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'second-batch'").first<{ n: number }>();
    expect(second?.n, "the batch carrying the second outcome was aborted").toBe(1);
  });

  it("PLANT: the bar a job sets on a driver's history is enforced at the CLAIM", async () => {
    const posted = await post({ title: "needs a track record", min_record: { prs_merged: 2 } });
    const id = posted.job!.id;
    expect(posted.job!.min_record).toBe(JSON.stringify({ prs_merged: 2 }));

    // This driver has no record, so it is refused and the job STAYS QUEUED for one
    // that can do it rather than being failed or parked on a four-hour lease.
    const refused = await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/at least 2 merged pull requests/);
    expect((await jobRow(id))?.status).toBe("queued");

    // Give it a record the Worker verified. The same claim now succeeds, so the bar
    // is a bar and not a wall.
    await plantOutcome("job_history0001", 2, 2, FULLY_VERIFIED);
    const won = await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    expect(won.ok, won.refusal).toBe(true);
    expect(won.job?.id).toBe(id);
  });

  it("an UNVERIFIED merge count does not clear a bar", async () => {
    // What makes the bar mean anything. Otherwise a driver reports its own fifty
    // merges and claims the work reserved for an agent with a record.
    await plantOutcome("job_selfclaim01", 50, 50, UNVERIFIED);
    await post({ title: "still needs a real record", min_record: { prs_merged: 2 } });
    const refused = await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/has 0/);
  });

  it("a job with no bar is claimed without the record ever being read", async () => {
    // The record is computed from every outcome row, so reading it on a claim that
    // asks no question would put a table scan in front of the queue's hottest path.
    await post({ title: "no bar" });
    const base = jobsEnv() as unknown as { DB: D1Database };
    const read: string[] = [];
    const counting = {
      ...base,
      DB: {
        prepare(sql: string) {
          read.push(sql);
          return base.DB.prepare(sql);
        },
        batch: (statements: D1PreparedStatement[]) => base.DB.batch(statements),
      },
    } as unknown as Parameters<typeof claimJob>[0];
    const won = await claimJob(counting, DRIVER, NOW, { namespace: "capsid" });
    expect(won.ok, won.refusal).toBe(true);
    expect(read.length, "the claim issued no statements, so this proves nothing").toBeGreaterThan(0);
    expect(read.filter((sql) => /FROM job_outcomes/.test(sql))).toEqual([]);
  });

  it("improve_status carries a record per credential, and it is counts and rates only", async () => {
    // No scope argument, so this is the unrestricted internal caller and the inventory
    // is attached. The ?? [] is the optional type falling in line with the SCOPED case,
    // where improve_status omits the inventory entirely (audit 2026-09-13, finding 7),
    // not a branch this test can take: the assertion below would read nothing.
    await seedAgent("capsid-driver");
    const status = await improveStatus(jobsEnv() as never, "capsid");
    const agents = status.agents ?? [];
    // THE COUNT CHECK IS THE POINT. Without it this test passed by iterating an empty
    // array: the fixture seeds no agents table row, so every per-credential assertion
    // below was skipped and a regression that emptied the inventory would have been
    // reported as a pass. capsid/conventions.md calls this out by name, "an assertion
    // that can pass by reading nothing", and it had been true here since the test was
    // written.
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(agent.record).toBeDefined();
      expect(agent.record.actor).toBe(`agent:${agent.name}`);
      // A rate with no denominator is null, never a zero that would read as a bad
      // record for a credential that has no record.
      for (const rate of [agent.record.pr_merge_rate, agent.record.ci_green_rate]) {
        expect(rate === null || (rate >= 0 && rate <= 1)).toBe(true);
      }
      expect(Object.keys(agent.record).join(" ")).not.toMatch(/score|rating|trust/i);
    }
  });

  // ---- audit 2026-09-13, finding 10 ----------------------------------------------

  it("PLANT: re-verifying the last pull request marks prs_opened verified, which is what min_record reads", async () => {
    // The defect: reverify set verified.prs_merged and left verified.prs_opened alone,
    // and recordFor requires prs_opened before it counts a single merge. So a job
    // completed while GitHub was down, merged later and swept, had GitHub's merge count
    // on its outcome row and prs_merged 0 on the agent's record, and min_record kept
    // refusing the next claim. Real D1, real SQL, real json_set.
    await env.DB
      .prepare(
        `INSERT INTO job_outcomes (job_id, agent, namespace, prs_opened, prs_merged, blocked_count, resumed_count,
           result_kind, verified, recorded_at)
         VALUES ('job_unverified', 'agent:capsid-driver', 'capsid', 1, 0, 0, 0, 'pr', ?1, '2026-09-10T12:00:00.000Z')`
      )
      .bind(JSON.stringify({ prs_opened: false, prs_merged: false }))
      .run();
    await env.DB
      .prepare("INSERT INTO job_outcome_prs (job_id, pr_url, merged, merge_verified_at) VALUES ('job_unverified', ?1, NULL, NULL)")
      .bind("https://github.com/o/r/pull/9")
      .run();

    await env.DB.batch(reverifyStatements(env.DB, "job_unverified", "https://github.com/o/r/pull/9", true, NOW));

    const row = await env.DB
      .prepare("SELECT prs_opened, prs_merged, verified FROM job_outcomes WHERE job_id = 'job_unverified'")
      .first<{ prs_opened: number; prs_merged: number; verified: string }>();
    const verified = JSON.parse(String(row!.verified)) as Record<string, boolean>;
    expect(row!.prs_merged).toBe(1);
    expect(verified.prs_merged).toBe(true);
    expect(verified.prs_opened).toBe(true);
    expect(row!.prs_opened).toBe(1);
  });

  it("A JOB WITH AN UNREAD PULL REQUEST LEFT does NOT get prs_opened verified", async () => {
    // The other half, and the reason the CASE counts unread rows instead of flipping
    // the flag on any successful read: reading one pull request of two proves nothing
    // about the count.
    await env.DB
      .prepare(
        `INSERT INTO job_outcomes (job_id, agent, namespace, prs_opened, prs_merged, blocked_count, resumed_count,
           result_kind, verified, recorded_at)
         VALUES ('job_partial', 'agent:capsid-driver', 'capsid', 2, 0, 0, 0, 'pr', ?1, '2026-09-10T12:00:00.000Z')`
      )
      .bind(JSON.stringify({ prs_opened: false, prs_merged: false }))
      .run();
    for (const url of ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"]) {
      await env.DB
        .prepare("INSERT INTO job_outcome_prs (job_id, pr_url, merged, merge_verified_at) VALUES ('job_partial', ?1, NULL, NULL)")
        .bind(url)
        .run();
    }

    await env.DB.batch(reverifyStatements(env.DB, "job_partial", "https://github.com/o/r/pull/1", true, NOW));

    const row = await env.DB
      .prepare("SELECT verified FROM job_outcomes WHERE job_id = 'job_partial'")
      .first<{ verified: string }>();
    const verified = JSON.parse(String(row!.verified)) as Record<string, boolean>;
    expect(verified.prs_merged).toBe(true);
    expect(verified.prs_opened).toBe(false);
  });
});

// ---- audit 2026-09-25, F1-1: the transition and its records are one batch ----------

describe("a holder transition commits with every record of it, or not at all", () => {
  const NS = "sample";
  const PR = "https://github.com/example/sample/pull/3";

  beforeEach(async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
      .bind(NS, JSON.stringify([{ repo: "example/sample", label: "primary" }]))
      .run();
  });

  async function claimed(title: string) {
    const posted = await post({ namespace: NS, title });
    const id = posted.job!.id;
    const claim = await claimJob(jobsEnv(), DRIVER, NOW, { id });
    expect(claim.ok, claim.refusal).toBe(true);
    return id;
  }

  async function records(id: string) {
    // The transition's own audit row, which names the job id. The mirror's document
    // write carries a second row under the same action, without it.
    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'job-complete' AND path = ?1 AND json_extract(params, '$.job_id') = ?2"
    )
      .bind(`jobs/${id}.md`, id)
      .first<{ n: number }>();
    const prs = await env.DB.prepare("SELECT COUNT(*) AS n FROM job_outcome_prs WHERE job_id = ?1").bind(id).first<{ n: number }>();
    const mirror = await env.DB.prepare("SELECT body, status FROM documents WHERE namespace = ?1 AND path = ?2")
      .bind(NS, `jobs/${id}.md`)
      .first<{ body: string; status: string }>();
    return { outcomes: await outcomeCount(id), audit: audit?.n ?? 0, prs: prs?.n ?? 0, mirror };
  }

  it("PLANT: a complete whose GitHub token cannot be minted is done WITH its outcome, audit row and mirror", async () => {
    // No App key in this environment and no cached token, so ghFetch throws. That
    // throw used to land after the UPDATE had committed: the job was done, with no
    // outcome row, no audit row, a mirror still saying claimed, and a retry refused.
    const id = await claimed("token mint fails");
    const done = await completeJob(jobsEnv(), DRIVER, at("2026-09-10T13:00:00.000Z"), id, {
      result_summary: "landed",
      evidence: { prs: [PR] },
    });
    expect(done.ok, done.refusal).toBe(true);
    expect(done.outcome?.notes.join(" ")).toMatch(/GitHub App not configured/);
    expect((await jobRow(id))?.status).toBe("done");
    const after = await records(id);
    expect(after.outcomes).toBe(1);
    expect(after.audit).toBe(1);
    expect(after.prs).toBe(1);
    expect(after.mirror?.body).toContain("status: **done**");
    expect(after.mirror?.status).toBe("closed");
  });

  it("PLANT: a state change while GitHub is being read aborts the whole batch, and nothing is written", async () => {
    // The lease tick (or anything else) moving the row between the read and the batch.
    // Simulated inside the GitHub call, which is the window the verification opens.
    const id = await claimed("raced by the tick");
    await env.APP_KV.put("gh:token:v3:example/sample", "test-token");
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await env.DB.prepare(
        "UPDATE jobs SET status = 'queued', claimed_by = NULL, claimed_at = NULL, lease_expires = NULL, updated_at = ?2 WHERE id = ?1"
      )
        .bind(id, "2026-09-10T12:30:00.000Z")
        .run();
      return new Response("unavailable", { status: 503 });
    });
    let result;
    try {
      result = await completeJob(jobsEnv(), DRIVER, at("2026-09-10T13:00:00.000Z"), id, {
        result_summary: "landed",
        evidence: { prs: [PR] },
      });
    } finally {
      spy.mockRestore();
      await env.APP_KV.delete("gh:token:v3:example/sample");
    }
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/is queued, not claimed/);
    expect((await jobRow(id))?.status).toBe("queued");
    const after = await records(id);
    expect(after.outcomes).toBe(0);
    expect(after.audit).toBe(0);
    expect(after.prs).toBe(0);
    expect(after.mirror?.body).toContain("status: **claimed**");
  });

  it("PLANT: a record write that fails leaves the job claimed, not done with no record", async () => {
    // Any throw inside the batch. A trigger refuses the outcome insert; the UPDATE
    // before it in the same batch must roll back with it.
    const id = await claimed("record write fails");
    await env.DB.prepare(
      "CREATE TRIGGER planted_outcome_refusal BEFORE INSERT ON job_outcomes BEGIN SELECT RAISE(ABORT, 'planted'); END"
    ).run();
    try {
      await expect(
        completeJob(jobsEnv(), DRIVER, at("2026-09-10T13:00:00.000Z"), id, { result_summary: "landed" })
      ).rejects.toThrow(/planted/);
    } finally {
      await env.DB.prepare("DROP TRIGGER planted_outcome_refusal").run();
    }
    expect((await jobRow(id))?.status).toBe("claimed");
    expect((await records(id)).audit).toBe(0);
  });
});
