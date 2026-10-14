import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { alreadyAbstracted } from "../src/skills-records";
import { candidateSkills } from "../src/improve-skills";

// THE SKILL QUERIES, AGAINST A REAL D1 (job_3e1596235513).
//
// These replace five tests in test/skills-records.test.ts that read the module's
// source and matched the SQL's spelling. The unit fake answers the recommend query
// with the status and trigger filters applied whatever the SQL says, so it could not
// catch a handler that dropped one. SQLite can.

type Env = Parameters<typeof alreadyAbstracted>[0];
const ENV = env as unknown as Env;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM improve_skills").run();
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

describe("alreadyAbstracted", () => {
  it("finds a RETIRED skill by its source, so a retired idea is not abstracted again", async () => {
    await skill("from-attempt", { status: "retired", source_attempt: "att_1" });
    await skill("from-job", { status: "retired", source_job: "job_1" });
    expect(await alreadyAbstracted(ENV, { kind: "attempt", id: "att_1" })).toEqual({ skill: "from-attempt", status: "retired" });
    expect(await alreadyAbstracted(ENV, { kind: "job", id: "job_1" })).toEqual({ skill: "from-job", status: "retired" });
    expect(await alreadyAbstracted(ENV, { kind: "job", id: "att_1" })).toBeNull();
  });
});

describe("candidateSkills", () => {
  it("offers only candidate or live skills that claim the namespace or none", async () => {
    for (const [id, status, namespaces] of [
      ["retired", "retired", null],
      ["foxing-only", "live", '["foxing"]'],
      ["anywhere", "candidate", null],
      ["here-too", "live", '["capsid","foxing"]'],
    ] as const) {
      await skill(id, { status });
      await env.DB.prepare("UPDATE improve_skills SET namespaces = ?2 WHERE id = ?1").bind(id, namespaces).run();
    }
    // skill() writes source_namespace 'sample', so 'capsid' sees them as another namespace's skills.
    const offered = await candidateSkills(env.DB, "capsid", 10);
    expect(offered.map((s) => s.id).sort()).toEqual(["anywhere", "here-too"]);
  });
});
