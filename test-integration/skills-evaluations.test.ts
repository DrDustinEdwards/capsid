import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  EVALUATION_MEASURE,
  LAST_CYCLE_KEY,
  MIN_USED_RUNS,
  TRANSITIONS_KEY,
  evaluationStatement,
  runEvaluationCycle,
  writeEvaluations,
} from "../src/skills-evaluate";
import { improveControl } from "../src/improve-run";
import { claimJob, failJob, postJob } from "../src/jobs";
import { legacyAgent, type Agent } from "../src/agents";
import { defaultScopes } from "../src/agents-schema";

// The skills evaluation cycle against a real D1: the writer that turns verified job
// outcomes into skill_evaluations rows, the hold on status changes during the
// observation window, and the failure notes a used skill collects.

type Env = Parameters<typeof writeEvaluations>[0];
const ENV = env as unknown as Env;
const SKILL = "reproduce-before-fixing";
const PAST = "2026-09-01T00:00:00.000Z";
const NOW = new Date("2026-09-26T12:00:00.000Z");
const VERIFIED = JSON.stringify({ prs_opened: true, prs_merged: true, commits: true, files_changed: true, ci_green: true });
let serial = 0;

async function skill(status = "candidate", version = 1) {
  const path = `improve/skills/${SKILL}.md`;
  await env.DB.prepare("INSERT INTO documents (namespace, path, title, body, type, status) VALUES ('capsid', ?1, ?2, ?3, 'reference', 'published')")
    .bind(path, SKILL, "Reproduce the failure before fixing it: plant the violation and watch the guard go red.")
    .run();
  await env.DB.prepare(
    "INSERT INTO improve_skills (id, source_namespace, title, body_ref, status, trigger_condition, version) VALUES (?1, 'capsid', ?1, ?2, ?3, 'a reported defect', ?4)"
  )
    .bind(SKILL, path, status, version)
    .run();
}

// One finished job that was offered the skill: used or not, and a verified win, a
// verified loss, or unverified (no pull request).
async function run(opts: { used: boolean; result: "win" | "loss" | "unverified"; version?: number }) {
  serial += 1;
  const id = `job_${String(serial).padStart(12, "0")}`;
  await env.DB.prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('agent:d', 'job-skills-offered', 'capsid', ?1, ?2)")
    .bind(`jobs/${id}.md`, JSON.stringify({ job_id: id, skills: [{ id: SKILL, version: opts.version ?? 1 }] }))
    .run();
  const [opened, merged, ci, verified] =
    opts.result === "win" ? [1, 1, 1, VERIFIED] : opts.result === "loss" ? [1, 0, 0, VERIFIED] : [0, null, null, "{}"];
  await env.DB.prepare(
    `INSERT INTO job_outcomes (job_id, agent, namespace, prs_opened, prs_merged, ci_green, blocked_count, resumed_count, result_kind, verified, skill_ids_offered, skill_ids_used, recorded_at)
     VALUES (?1, 'agent:d', 'capsid', ?2, ?3, ?4, 0, 0, 'pr', ?5, ?6, ?7, ?8)`
  )
    .bind(id, opened, merged, ci, verified, JSON.stringify([SKILL]), opts.used ? JSON.stringify([SKILL]) : null, PAST)
    .run();
}

async function evaluations() {
  const { results } = await env.DB.prepare("SELECT delta, runs, verdict, probe_set_version, namespace FROM skill_evaluations WHERE skill = ?1").bind(SKILL).all();
  return results ?? [];
}

async function status() {
  return (await env.DB.prepare("SELECT status FROM improve_skills WHERE id = ?1").bind(SKILL).first<{ status: string }>())?.status;
}

beforeEach(async () => {
  for (const table of ["jobs", "audit_log", "job_outcomes", "improve_skills", "skill_evaluations", "skill_failures"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%' OR path LIKE 'improve/skills/%'").run();
  await env.APP_KV.delete(TRANSITIONS_KEY);
  await env.APP_KV.delete(LAST_CYCLE_KEY);
});

describe("the evaluation writer", () => {
  it("compares used runs with offered-but-unused runs and writes one evaluation", async () => {
    await skill();
    for (let i = 0; i < MIN_USED_RUNS; i++) await run({ used: true, result: "win" });
    await run({ used: false, result: "win" });
    await run({ used: false, result: "loss" });
    const written = await writeEvaluations(ENV);
    expect(written).toEqual([expect.objectContaining({ skill: SKILL, written: true })]);
    // 5 of 5 used runs won, 1 of 2 unused runs won: 1 - 0.5.
    expect(await evaluations()).toEqual([{ delta: 0.5, runs: 7, verdict: "positive", probe_set_version: EVALUATION_MEASURE, namespace: "*" }]);
    const audit = await env.DB.prepare("SELECT params FROM audit_log WHERE action = 'skill-evaluated'").first<{ params: string }>();
    expect(JSON.parse(audit!.params)).toMatchObject({ used_runs: 5, used_wins: 5, unused_runs: 2, unused_wins: 1 });
  });

  it("writes nothing below the minimum of used runs", async () => {
    await skill();
    for (let i = 0; i < MIN_USED_RUNS - 1; i++) await run({ used: true, result: "win" });
    await run({ used: false, result: "loss" });
    const [w] = await writeEvaluations(ENV);
    expect(w.written).toBe(false);
    expect(w.reason).toMatch(/needs 5/);
    expect(await evaluations()).toEqual([]);
  });

  it("writes nothing with no offered-but-unused run to compare against", async () => {
    await skill();
    for (let i = 0; i < MIN_USED_RUNS; i++) await run({ used: true, result: "win" });
    expect((await writeEvaluations(ENV))[0].reason).toMatch(/nothing to compare/);
    expect(await evaluations()).toEqual([]);
  });

  it("counts no run the Worker could not verify", async () => {
    await skill();
    for (let i = 0; i < MIN_USED_RUNS - 1; i++) await run({ used: true, result: "win" });
    await run({ used: true, result: "unverified" });
    await run({ used: false, result: "loss" });
    expect((await writeEvaluations(ENV))[0].written).toBe(false);
  });

  it("counts only offers made at the skill's current version", async () => {
    await skill("candidate", 2);
    for (let i = 0; i < MIN_USED_RUNS; i++) await run({ used: true, result: "win", version: 1 });
    await run({ used: false, result: "loss", version: 1 });
    expect((await writeEvaluations(ENV))[0].written).toBe(false);
  });

  it("does not count the same runs twice", async () => {
    await skill();
    for (let i = 0; i < MIN_USED_RUNS; i++) await run({ used: true, result: "win" });
    await run({ used: false, result: "loss" });
    await writeEvaluations(ENV);
    await writeEvaluations(ENV);
    expect(await evaluations()).toHaveLength(1);
  });
});

describe("status changes are held during the observation window", () => {
  async function twoPositive() {
    for (let i = 0; i < 2; i++) {
      await evaluationStatement(env.DB, { skill: SKILL, version: 1, namespace: "*", probeSetVersion: EVALUATION_MEASURE, delta: 0.5, runs: 7 }).run();
    }
  }

  it("holds by default: two positive evaluations do not promote the candidate", async () => {
    await skill();
    await twoPositive();
    const report = await runEvaluationCycle(ENV, NOW);
    expect(report.ran).toBe(true);
    expect(report.mode).toBe("hold");
    expect(report.held).toEqual([expect.objectContaining({ skill: SKILL, from: "candidate", to: "live" })]);
    expect(report.transitions).toEqual([]);
    expect(await status()).toBe("candidate");
  });

  it("applies once the switch says apply", async () => {
    await skill();
    await twoPositive();
    await env.APP_KV.put(TRANSITIONS_KEY, "apply");
    const report = await runEvaluationCycle(ENV, NOW);
    expect(report.transitions).toEqual([expect.objectContaining({ skill: SKILL, to: "live" })]);
    expect(await status()).toBe("live");
  });

  it("any value but apply holds", async () => {
    await skill();
    await twoPositive();
    await env.APP_KV.put(TRANSITIONS_KEY, "yes");
    expect((await runEvaluationCycle(ENV, NOW)).mode).toBe("hold");
    expect(await status()).toBe("candidate");
  });

  it("improve_run skill_transitions sets the switch, audits it, and refuses any other value", async () => {
    const result = await improveControl(ENV as never, "skill_transitions", { value: "apply" });
    expect(result).toEqual({ action: "skill_transitions", requested: "apply", mode: "apply" });
    expect(await env.APP_KV.get(TRANSITIONS_KEY)).toBe("apply");
    const audit = await env.DB.prepare("SELECT params FROM audit_log WHERE action = 'skill-transitions-set'").first<{ params: string }>();
    expect(JSON.parse(audit!.params)).toMatchObject({ mode: "apply" });
    await expect(improveControl(ENV as never, "skill_transitions", { value: "on" })).rejects.toThrow(/hold" or "apply/);
    expect(await env.APP_KV.get(TRANSITIONS_KEY)).toBe("apply");
  });
});

describe("failure notes", () => {
  function driverAgent(): Agent {
    const scopes = defaultScopes(["capsid"]);
    scopes.grants = ["read", "write"];
    return { id: "agent_d", name: "capsid-driver", kind: "driver", actor: "agent:capsid-driver", scopes, admin: false, row: null };
  }
  const jobsEnv = () => ({ ...env, IMPROVE_SCORE_SECRET: "test-root-secret" }) as unknown as Parameters<typeof postJob>[0];

  async function claimedJob(title: string) {
    await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES ('capsid', ?1)")
      .bind(JSON.stringify([{ repo: "example/capsid", label: "primary" }]))
      .run();
    const posted = await postJob(jobsEnv(), legacyAgent("write", "github:DrDustinEdwards"), NOW, { namespace: "capsid", title, body: "the guard passes on a planted violation" });
    const claimed = await claimJob(jobsEnv(), driverAgent(), NOW, { id: posted.job!.id });
    expect(claimed.offered_skills?.map((s) => s.id)).toEqual([SKILL]);
    return posted.job!.id;
  }

  async function notes() {
    const { results } = await env.DB.prepare("SELECT skill, source_kind, source_id, note FROM skill_failures").all();
    return results ?? [];
  }

  it("a failed job leaves a note on each skill it used", async () => {
    await skill();
    const id = await claimedJob("fix the guard that passes on a planted violation");
    expect((await failJob(jobsEnv(), driverAgent(), NOW, id, "could not reproduce it", { used: [SKILL] })).ok).toBe(true);
    expect(await notes()).toEqual([{ skill: SKILL, source_kind: "job", source_id: id, note: "could not reproduce it" }]);
  });

  it("a failed job that used no skill leaves no note", async () => {
    await skill();
    const id = await claimedJob("fix the guard that passes on a planted violation");
    expect((await failJob(jobsEnv(), driverAgent(), NOW, id, "gave up")).ok).toBe(true);
    expect(await notes()).toEqual([]);
  });
});
