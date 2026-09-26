import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { claimJob, completeJob, failJob, postJob, releaseJob } from "../src/jobs";
import { legacyAgent, type Agent } from "../src/agents";
import { defaultScopes } from "../src/agents-schema";
import { OFFER_ACTION } from "../src/job-skill-offers";

// The skills a job is offered, decided by the Worker at its first claim, recorded as
// an audit row, and the only offered list an outcome row may carry. Against a real D1
// and a real FTS5 index, because the offer is an FTS match.

const SECRET = "test-root-secret";
const POSTER = legacyAgent("write", "github:DrDustinEdwards");
const NOW = new Date("2026-09-26T06:00:00.000Z");
const LATER = new Date("2026-09-26T07:00:00.000Z");
const SKILL_BODY = "Reproduce the failure before fixing it: plant the violation and watch the guard go red.";

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

function driverAgent(actor = "agent:capsid-driver"): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  return { id: `agent_${actor.length}`, name: actor.slice("agent:".length), kind: "driver", actor, scopes, admin: false, row: null };
}

function seatAgent(): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  scopes.flags.can_merge = true;
  return { id: "agent_seat", name: "seat", kind: "seat", actor: "agent:seat", scopes, admin: false, row: null };
}

async function skill(id: string, body = SKILL_BODY, status = "candidate") {
  const path = `improve/skills/${id}.md`;
  await env.DB.prepare("INSERT INTO documents (namespace, path, title, body, type, status) VALUES ('capsid', ?1, ?2, ?3, 'reference', 'published')")
    .bind(path, id, body)
    .run();
  await env.DB.prepare(
    `INSERT INTO improve_skills (id, source_namespace, title, body_ref, status, trigger_condition) VALUES (?1, 'capsid', ?1, ?2, ?3, 'a reported defect')`
  )
    .bind(id, path, status)
    .run();
}

async function claimed(title: string, body = "the guard does not fail when the violation is planted") {
  const posted = await postJob(jobsEnv(), POSTER, NOW, { namespace: "capsid", title, body });
  expect(posted.ok, posted.refusal).toBe(true);
  const claim = await claimJob(jobsEnv(), driverAgent(), NOW, { id: posted.job!.id });
  expect(claim.ok, claim.refusal).toBe(true);
  return { id: posted.job!.id, claim };
}

async function offerRows(id: string) {
  const { results } = await env.DB.prepare("SELECT params FROM audit_log WHERE action = ?1 AND params LIKE ?2 ORDER BY id")
    .bind(OFFER_ACTION, `%${id}%`)
    .all<{ params: string }>();
  return (results ?? []).map((r) => JSON.parse(r.params) as { skills: Array<{ id: string; version: number }> });
}

async function outcome(id: string) {
  return env.DB.prepare("SELECT skill_ids_offered, skill_ids_used FROM job_outcomes WHERE job_id = ?1")
    .bind(id)
    .first<{ skill_ids_offered: string | null; skill_ids_used: string | null }>();
}

beforeEach(async () => {
  for (const table of ["jobs", "audit_log", "job_outcomes", "improve_skills", "skill_failures"]) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%' OR path LIKE 'improve/skills/%'").run();
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
    .bind("capsid", JSON.stringify([{ repo: "example/capsid", label: "primary" }]))
    .run();
});

describe("the offer at claim", () => {
  it("a claim whose work matches a skill returns it with its body, and records the offer with its version", async () => {
    await skill("reproduce-before-fixing");
    const { id, claim } = await claimed("fix the guard that passes on a planted violation");
    expect(claim.offered_skills?.map((s) => s.id)).toEqual(["reproduce-before-fixing"]);
    expect(claim.offered_skills?.[0].body).toBe(SKILL_BODY);
    expect(await offerRows(id)).toEqual([{ job_id: id, skills: [{ id: "reproduce-before-fixing", version: 1 }] }]);
  });

  it("a claim that matches nothing returns no skills, and still records an empty offer", async () => {
    await skill("reproduce-before-fixing", "an unrelated body about fonts and colours");
    const { id, claim } = await claimed("write the release notes", "summarise the changelog for readers");
    expect(claim.offered_skills).toEqual([]);
    expect(await offerRows(id)).toEqual([{ job_id: id, skills: [] }]);
  });

  it("a retired skill is never offered", async () => {
    await skill("retired-one", SKILL_BODY, "retired");
    const { claim } = await claimed("fix the guard that passes on a planted violation");
    expect(claim.offered_skills).toEqual([]);
  });

  it("a job keeps its first offer when it changes hands", async () => {
    await skill("first");
    const { id } = await claimed("fix the guard that passes on a planted violation");
    await skill("second");
    expect((await releaseJob(jobsEnv(), seatAgent(), LATER, id, "holder gone")).ok).toBe(true);
    const again = await claimJob(jobsEnv(), driverAgent("agent:capsid-driver-2"), LATER, { id });
    expect(again.ok, again.refusal).toBe(true);
    expect(again.offered_skills?.map((s) => s.id)).toEqual(["first"]);
    expect(await offerRows(id)).toHaveLength(1);
  });
});

describe("the outcome carries the Worker's offer", () => {
  it("complete with no skills named stores the recorded offer and nothing used", async () => {
    await skill("reproduce-before-fixing");
    const { id } = await claimed("fix the guard that passes on a planted violation");
    const done = await failJob(jobsEnv(), driverAgent(), LATER, id, "could not reproduce");
    expect(done.ok, done.refusal).toBe(true);
    expect(await outcome(id)).toEqual({ skill_ids_offered: '["reproduce-before-fixing"]', skill_ids_used: null });
  });

  it("the used skill is stored when it was offered", async () => {
    await skill("reproduce-before-fixing");
    const { id } = await claimed("fix the guard that passes on a planted violation");
    const failed = await failJob(jobsEnv(), driverAgent(), LATER, id, "tried and failed", { used: ["reproduce-before-fixing"] });
    expect(failed.ok, failed.refusal).toBe(true);
    expect(await outcome(id)).toEqual({ skill_ids_offered: '["reproduce-before-fixing"]', skill_ids_used: '["reproduce-before-fixing"]' });
  });

  it("a driver's offered list that differs from the Worker's record is refused", async () => {
    await skill("reproduce-before-fixing");
    await skill("never-offered", "an unrelated body about fonts and colours");
    const { id } = await claimed("fix the guard that passes on a planted violation");
    const refused = await failJob(jobsEnv(), driverAgent(), LATER, id, "x", { offered: ["never-offered"], used: [] });
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/Worker's record/);
    expect(await outcome(id)).toBeNull();
  });

  it("a used skill the job was not offered is refused", async () => {
    await skill("never-offered", "an unrelated body about fonts and colours");
    const { id } = await claimed("fix the guard that passes on a planted violation");
    const refused = await completeJob(jobsEnv(), driverAgent(), LATER, id, {
      result_summary: "done",
      result_ref: "https://github.com/example/capsid/pull/1",
      skills: { used: ["never-offered"] },
    });
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/cannot be credited/);
  });
});
