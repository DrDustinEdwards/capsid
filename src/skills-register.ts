import type { Env } from "./env";
import { skillPath } from "./improve-schema";
import { improveDocStatements, priorDoc } from "./improve-state";
import { normalizeDashes } from "./normalize";
import { auditStatement } from "./store-guards";
import { alreadyAbstracted, shouldCreateCandidate } from "./skills-records";

// Registering a candidate skill by hand, beside recordSkill in ./improve-skills,
// which runs only when an improve attempt is kept.
//
// Admin only (improve_run's default in TOOL_ACTION_GRANTS, src/scope.ts): a driver
// registering its own skill would be judging its own run.
//
// The source is a job, and the job row decides the rest: the namespace comes from
// the job, its outcome must pass shouldCreateCandidate, and a job that already
// produced a skill is refused. The result is always a candidate at version 1.

const SKILL_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;

export interface SkillRegistration {
  id: string;
  title: string;
  trigger_condition: string;
  termination_test: string;
  composition_interface: string;
  // NULL means any namespace, the same as the column.
  namespaces: string[] | null;
  // Stored as the document improve/skills/<id>.md, which edits are bounded against.
  body: string;
  source_job: string;
}

export type RegisterResult =
  | {
      ok: true;
      action: "register_skill";
      skill: { id: string; status: "candidate"; version: 1; source_namespace: string; source_job: string; body_ref: string };
    }
  | { ok: false; action: "register_skill"; error: string };

export async function registerSkill(env: Env, actor: string, input: SkillRegistration): Promise<RegisterResult> {
  const refuse = (error: string): RegisterResult => ({ ok: false, action: "register_skill", error });

  if (!SKILL_ID.test(input.id)) {
    return refuse(`skill id '${input.id}' must be 3 to 64 lowercase letters, digits or hyphens, starting with a letter or digit.`);
  }
  for (const field of ["title", "trigger_condition", "termination_test", "composition_interface", "body", "source_job"] as const) {
    if (input[field].trim().length === 0) return refuse(`${field} is empty. Every declared field of the package is required.`);
  }
  if (input.namespaces !== null && input.namespaces.length === 0) {
    return refuse("namespaces is an empty list, which would match nothing. Pass null for any namespace.");
  }

  const job = await env.DB.prepare("SELECT id, namespace, status FROM jobs WHERE id = ?1")
    .bind(input.source_job)
    .first<{ id: string; namespace: string; status: string }>();
  if (!job) return refuse(`no job '${input.source_job}'. A registered skill names the job it was abstracted from.`);
  if (job.status !== "done") {
    return refuse(`job ${job.id} is ${job.status}, not done. A skill is abstracted from work that finished.`);
  }

  const outcome = await env.DB.prepare("SELECT prs_merged, ci_green FROM job_outcomes WHERE job_id = ?1")
    .bind(job.id)
    .first<{ prs_merged: number | null; ci_green: number | null }>();
  const verdict = shouldCreateCandidate({
    kind: "job",
    id: job.id,
    prsMerged: outcome?.prs_merged ?? null,
    ciGreen: outcome?.ci_green ?? null,
  });
  if (!verdict.create) return refuse(verdict.reason);

  const prior = await alreadyAbstracted(env, { kind: "job", id: job.id });
  if (prior) {
    return refuse(`job ${job.id} already produced skill ${prior.skill} (${prior.status}). One source, one skill, retired ones included.`);
  }
  const taken = await env.DB.prepare("SELECT id FROM improve_skills WHERE id = ?1").bind(input.id).first<{ id: string }>();
  if (taken) return refuse(`skill id '${input.id}' is already registered.`);

  const path = skillPath(input.id);
  const docStatements = await improveDocStatements(env.DB, {
    namespace: "capsid",
    path,
    title: input.title,
    type: "reference",
    tags: "improve,skill",
    action: "skill-body-written",
    actor,
    prior: await priorDoc(env.DB, "capsid", path),
    body: input.body,
  });

  const title = normalizeDashes(input.title, "title");
  const namespaces = input.namespaces === null ? null : JSON.stringify(input.namespaces);

  // A plain INSERT with no ON CONFLICT: if the id was taken between the check above
  // and this batch, the primary key aborts the whole batch, document included.
  await env.DB.batch([
    ...docStatements,
    env.DB
      .prepare(
        `INSERT INTO improve_skills (id, source_namespace, title, body_ref, source_job, status, version,
           trigger_condition, namespaces, termination_test, composition_interface)
         VALUES (?1, ?2, ?3, ?4, ?5, 'candidate', 1, ?6, ?7, ?8, ?9)`
      )
      .bind(
        input.id,
        job.namespace,
        title,
        path,
        job.id,
        input.trigger_condition,
        namespaces,
        input.termination_test,
        input.composition_interface
      ),
    auditStatement(env.DB, actor, "skill-registered", "capsid", path, {
      skill: input.id,
      source_job: job.id,
      source_namespace: job.namespace,
      namespaces,
      status: "candidate",
      version: 1,
    }),
  ]);

  return {
    ok: true,
    action: "register_skill",
    skill: { id: input.id, status: "candidate", version: 1, source_namespace: job.namespace, source_job: job.id, body_ref: path },
  };
}
