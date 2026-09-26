import type { Env } from "./env";
import type { JobRow } from "./jobs-schema";
import { jobDocPath } from "./jobs-schema";
import { jobAudit } from "./jobs-mirror";
import { splitSignedTask } from "./improve-task";
import { offerSkills, type OfferedSkill } from "./skills-records";
import type { JobSkills } from "./job-outcomes";

// The skills a job is offered, decided by the Worker at its first claim and recorded
// as an audit row, so the offered side of the offered-to-used measure is the Worker's
// record rather than the driver's word (roadmap P0, P6). No migration: the row sits
// under the job's mirror path, the index every job audit row already uses.

export const OFFER_ACTION = "job-skills-offered";

// A skill body is handed over whole unless it is unreasonably long. The driver may be
// scoped to a namespace that cannot read capsid/improve/skills/, so the body travels
// with the offer.
const MAX_OFFERED_BODY = 20_000;

export interface OfferRecord {
  id: string;
  version: number;
}

export interface OfferedSkillWithBody extends OfferedSkill {
  body: string;
}

/** The offer recorded for this job at its first claim, or null when none was. */
async function recordedOffer(db: D1Database, job: Pick<JobRow, "id" | "namespace">): Promise<OfferRecord[] | null> {
  const row = await db
    .prepare("SELECT params FROM audit_log WHERE namespace = ?1 AND path = ?2 AND action = ?3 ORDER BY id ASC LIMIT 1")
    .bind(job.namespace, jobDocPath(job.id), OFFER_ACTION)
    .first<{ params: string | null }>();
  if (!row?.params) return null;
  // A row this module wrote and cannot read back is a fault, not an empty offer.
  const params = JSON.parse(row.params) as { skills?: unknown };
  if (!Array.isArray(params.skills)) throw new Error(`the ${OFFER_ACTION} row for ${job.id} carries no skills list`);
  return params.skills.map((s) => {
    const { id, version } = s as { id?: unknown; version?: unknown };
    if (typeof id !== "string" || typeof version !== "number") throw new Error(`the ${OFFER_ACTION} row for ${job.id} has a malformed entry`);
    return { id, version };
  });
}

async function bodyOf(db: D1Database, bodyRef: string): Promise<string> {
  const doc = await db
    .prepare("SELECT body FROM documents WHERE namespace = 'capsid' AND path = ?1")
    .bind(bodyRef)
    .first<{ body: string | null }>();
  const body = doc?.body ?? "";
  return body.length > MAX_OFFERED_BODY ? `${body.slice(0, MAX_OFFERED_BODY)}\n\n[truncated at ${MAX_OFFERED_BODY} characters]` : body;
}

// The text a job is matched on: its title and its prompt, without the signature
// frontmatter, whose hex would only add noise to the match.
function workText(job: Pick<JobRow, "title" | "body">): string {
  const split = splitSignedTask(job.body);
  return `${job.title}\n${split.body}`;
}

/**
 * The offer for a claim. The first claim decides it and returns the audit statement
 * that records it, to ride in the claim's guarded batch. A later claim (after a
 * resume, a release or an expired lease) returns the recorded skills and records
 * nothing, so a job keeps its first offer when it changes hands.
 */
export async function offerForClaim(
  env: Env,
  job: JobRow,
  actor: string
): Promise<{ skills: OfferedSkillWithBody[]; record: D1PreparedStatement | null }> {
  const recorded = await recordedOffer(env.DB, job);
  if (recorded) {
    const skills: OfferedSkillWithBody[] = [];
    for (const r of recorded) {
      const row = await env.DB.prepare(
        "SELECT id, title, status, version, trigger_condition, body_ref FROM improve_skills WHERE id = ?1"
      )
        .bind(r.id)
        .first<Omit<OfferedSkill, "recent_failures">>();
      if (!row) continue;
      skills.push({ ...row, version: r.version, recent_failures: [], body: await bodyOf(env.DB, row.body_ref) });
    }
    return { skills, record: null };
  }
  const offered = await offerSkills(env, job.namespace, workText(job));
  const skills: OfferedSkillWithBody[] = [];
  for (const s of offered) skills.push({ ...s, body: await bodyOf(env.DB, s.body_ref) });
  const record = jobAudit(env.DB, actor, OFFER_ACTION, job, {
    skills: skills.map((s) => ({ id: s.id, version: s.version })),
  });
  return { skills, record };
}

/**
 * The skills a finishing run is credited with. The offered list is the Worker's
 * record; a driver that also sends one must send the same set. Used must be within the
 * record. Returns the skills to store, or the refusal.
 */
export async function skillsForOutcome(
  db: D1Database,
  job: Pick<JobRow, "id" | "namespace">,
  reported: JobSkills | undefined
): Promise<{ skills: JobSkills } | { refusal: string }> {
  const offered = ((await recordedOffer(db, job)) ?? []).map((r) => r.id);
  const offeredSet = new Set(offered);
  if (reported?.offered !== undefined) {
    const said = [...new Set(reported.offered)].sort();
    const have = [...offeredSet].sort();
    if (said.length !== have.length || said.some((id, i) => id !== have[i])) {
      return {
        refusal: `${job.id} was offered ${have.length ? have.join(", ") : "no skills"} by this Worker, and the run reports ${said.length ? said.join(", ") : "none"}. The offer is the Worker's record; omit offered, or send exactly what claim returned.`,
      };
    }
  }
  const used = [...new Set(reported?.used ?? [])];
  const stray = used.filter((id) => !offeredSet.has(id));
  if (stray.length) {
    return {
      refusal: `${stray.join(", ")} named as used, but this Worker offered ${job.id} ${offered.length ? offered.join(", ") : "no skills"}. A skill the job was not offered cannot be credited to it.`,
    };
  }
  return { skills: { offered, used } };
}
