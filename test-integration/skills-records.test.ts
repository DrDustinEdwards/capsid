import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { alreadyAbstracted, FAILURE_NOTES_PER_SKILL, failureNoteStatements, MAX_OFFERED, offerSkills } from "../src/skills-records";

// THE SKILL QUERIES, AGAINST A REAL D1 AND A REAL FTS5 INDEX (job_3e1596235513).
//
// These replace five tests in test/skills-records.test.ts that read the module's
// source and matched the SQL's spelling. The unit fake answers the recommend query
// with the status and trigger filters applied whatever the SQL says, so it could not
// catch a handler that dropped one. SQLite can.

type Env = Parameters<typeof offerSkills>[0];
const ENV = env as unknown as Env;
const WORK = "a slow database query in a loader";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM improve_skills").run();
  await env.DB.prepare("DELETE FROM skill_failures").run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'improve/skills/%'").run();
});

async function skill(id: string, over: { status?: string; trigger?: string | null; source_attempt?: string; source_job?: string } = {}) {
  const path = `improve/skills/${id}.md`;
  await env.DB.prepare(
    "INSERT INTO documents (namespace, path, title, body, type, status) VALUES ('capsid', ?1, ?2, ?3, 'reference', 'published')"
  )
    .bind(path, id, "look for a slow database query in a loader")
    .run();
  await env.DB.prepare(
    `INSERT INTO improve_skills (id, source_namespace, title, body_ref, status, trigger_condition, source_attempt, source_job)
     VALUES (?1, 'sample', ?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(
      id,
      path,
      over.status ?? "candidate",
      over.trigger === undefined ? "a slow database query" : over.trigger,
      over.source_attempt ?? null,
      over.source_job ?? null
    )
    .run();
}

async function failure(skillId: string, note: string, createdAt: string) {
  await env.DB.prepare(
    "INSERT INTO skill_failures (skill, namespace, source_kind, source_id, note, created_at) VALUES (?1, 'sample', 'job', 'j', ?2, ?3)"
  )
    .bind(skillId, note, createdAt)
    .run();
}

describe("offerSkills", () => {
  it("offers at most MAX_OFFERED skills", async () => {
    for (const id of ["s1", "s2", "s3", "s4", "s5"]) await skill(id);
    const offered = await offerSkills(ENV, "sample", WORK);
    expect(MAX_OFFERED).toBe(3);
    expect(offered).toHaveLength(MAX_OFFERED);
  });

  it("never offers a retired skill", async () => {
    await skill("kept");
    await skill("gone", { status: "retired" });
    const offered = await offerSkills(ENV, "sample", WORK);
    expect(offered.map((s) => s.id)).toEqual(["kept"]);
  });

  it("never offers a skill with no trigger condition", async () => {
    await skill("with-trigger");
    await skill("no-trigger", { trigger: null });
    const offered = await offerSkills(ENV, "sample", WORK);
    expect(offered.map((s) => s.id)).toEqual(["with-trigger"]);
  });

  it("attaches the newest FAILURE_NOTES_PER_SKILL failure notes, newest first", async () => {
    await skill("noted");
    await failure("noted", "oldest", "2026-09-01 00:00:00");
    await failure("noted", "newest", "2026-09-03 00:00:00");
    await failure("noted", "middle", "2026-09-02 00:00:00");
    const [offered] = await offerSkills(ENV, "sample", WORK);
    expect(FAILURE_NOTES_PER_SKILL).toBe(2);
    expect(offered.recent_failures.map((f) => f.note)).toEqual(["newest", "middle"]);
  });
});

describe("alreadyAbstracted", () => {
  it("finds a RETIRED skill by its source, so a retired idea is not abstracted again", async () => {
    await skill("from-attempt", { status: "retired", source_attempt: "att_1" });
    await skill("from-job", { status: "retired", source_job: "job_1" });
    expect(await alreadyAbstracted(ENV, { kind: "attempt", id: "att_1" })).toEqual({ skill: "from-attempt", status: "retired" });
    expect(await alreadyAbstracted(ENV, { kind: "job", id: "job_1" })).toEqual({ skill: "from-job", status: "retired" });
    expect(await alreadyAbstracted(ENV, { kind: "job", id: "att_1" })).toBeNull();
  });
});

describe("failureNoteStatements", () => {
  it("writes the note and leaves the skill row exactly as it was", async () => {
    await skill("steady");
    const before = await env.DB.prepare("SELECT * FROM improve_skills WHERE id = 'steady'").first();
    await env.DB.batch(failureNoteStatements(env.DB, "sample", { kind: "job", id: "job_2" }, ["steady"], "it failed"));
    const after = await env.DB.prepare("SELECT * FROM improve_skills WHERE id = 'steady'").first();
    expect(after).toEqual(before);
    const notes = await env.DB.prepare("SELECT note FROM skill_failures WHERE skill = 'steady'").all<{ note: string }>();
    expect(notes.results.map((n) => n.note)).toEqual(["it failed"]);
  });
});
