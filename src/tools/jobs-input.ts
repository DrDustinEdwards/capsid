import { z } from "zod";
import { bounded, MAX_BODY, MAX_RESUME_NOTE, MAX_TITLE, nsName, resultRef } from "../limits";
import { JOB_KINDS } from "../model-routing";
import { CORRECTION_CAP, JOB_ACTIONS, JOB_STATUSES } from "../jobs-schema";
import { SCOPE_FLAGS } from "../agents-schema";
import { claimSchema } from "../job-claims";

const MAX_JOB_ID = 64;

// Each pull request costs a GitHub read inside `complete`, so the bound stops one call fanning out.
const MAX_EVIDENCE_PRS = 10;

export const JOBS_DEFINITION = {
  description: `The work queue. Each job mirrors to <namespace>/jobs/<id>.md. list needs the read grant; every other action needs the write grant. "Seat" below means the admin or a can_merge caller. Full rules: docs/work-queue.md.
post: queue a job from namespace, title and body. The body is signed; a driver refuses one that does not verify. Refused while another open job has the same (namespace, title), or when the title or body holds an unfilled placeholder (<ID>, {{...}}, TODO:, TBD) outside a code block; warns when the body lacks GOAL, DO, OUT OF SCOPE, DONE WHEN or DECIDED/RULES parts. A body stating as done that a PR merged, a version was tagged or published to npm is checked and refused when false.
list: filter by namespace, status and id, without bodies; one named id returns its body and edit versions to a writer. stale: true returns blocked or claimed jobs that look stuck (unchanged, resumed-not-completed, prs-settled, steps-seen). view: plan, digest or models.
claim: take the top queued job in a namespace, or a named id. The claim never expires. Returns the recommended model. Refused without the job's required_flags or min_record, or while the namespace's breaker is open.
begin: label a queued job started (who, when). Verifies the body's signature; never refuses otherwise.
complete: needs result_summary; writes one outcome row and verifies each named pull request against GitHub. Refused until CI has passed on the head of each one it names: running waits, red is refused, and no passing check on a code change is not green. Also closes a queued job nobody holds when it names the job's pull request (the pull request is the claim), and lets the seat close a blocked job another credential holds.
record: the seat's close of a queued job somebody else did, with the same review gate and evidence checks.
block: needs reason and the command the human must run, or question: true with the question as the reason, answered by a resume note.
Complete and block that name a pull request also report open pull requests sharing a file (overlaps); a failed read says not checked and never blocks.
fail: needs reason. The seat may fail a job somebody else holds.
complete, fail and block take an optional claim (what the agent says it did), recorded before anything is verified.
resume: returns a blocked job to claimed for its blocker, or to the caller with take; a job blocked by a shared identity (access:, github:) goes back to queued. Needs reason and re-verifies the signature. A plain resume needs the seat; the claimant may resume on approved_by_policy for a branch push or a pull request. correction spends one correction; corrections are capped at ${CORRECTION_CAP} per piece of work, past which only the admin may resume.
supersede: end a job replaced before work began; needs reason. Any writer on a queued job; the holder or the seat on a claimed job with no work recorded.
release: the seat returns a job another credential holds to the queue; needs reason.
edit: the seat changes title, body, priority or gate_required of a queued or blocked job; the old version is kept.
park / unpark: the seat sets a queued job aside with a one-line reason, or returns it to queued. A parked job is never claimed or planned and holds no title slot. park with until returns the job to the queue on its own once that time passes (the five-minute tick).
block and complete act only on a job this caller holds, except as stated above.`,
  inputSchema: {
    action: z
      .enum(JOB_ACTIONS)
      .describe(
        "post | list | claim | complete | record | fail | block | resume | supersede | release | begin | edit | park | unpark.",
      ),
    namespace: nsName
      .optional()
      .describe(
        "For post, the namespace the work belongs to. For list and claim, the namespace to filter or pick from.",
      ),
    title: bounded(MAX_TITLE)
      .optional()
      .describe("For post and edit: the title. One open job per (namespace, title)."),
    body: bounded(MAX_BODY)
      .optional()
      .describe("For post and edit: the full prompt the driver executes. Signed on the way in."),
    priority: z
      .number()
      .int()
      .optional()
      .describe("For post and edit: higher runs first. Defaults to 0 at post."),
    gate_required: z
      .boolean()
      .optional()
      .describe(
        "For post and edit: the work needs a human confirmation (a push, a deploy, a secret).",
      ),
    required_flags: z
      .array(z.enum(SCOPE_FLAGS))
      .optional()
      .describe(
        `For post: the flags the claiming driver must hold (${SCOPE_FLAGS.join(", ")}). The claim refuses an agent without them and leaves the job queued.`,
      ),
    min_record: z
      .strictObject({ prs_merged: z.number().int().nonnegative() })
      .optional()
      .describe(
        "For post: the minimum merged pull requests on the claiming agent's record. The claim refuses an agent below it and leaves the job queued.",
      ),
    kind: z
      .enum(JOB_KINDS)
      .optional()
      .describe(
        `For post: the job's kind (${JOB_KINDS.join(", ")}). Optional: when absent Capsid reads it from the poster and the title. The kind and the job's risk decide the model Capsid recommends; nobody names a model.`,
      ),
    status: z
      .enum(JOB_STATUSES)
      .optional()
      .describe(`For list: one of ${JOB_STATUSES.join(" | ")}.`),
    view: z
      .enum(["plan", "digest", "models"])
      .optional()
      .describe(
        'For list: "plan" returns the overnight plan, per repo the queued jobs in priority order that fit about 8 hours, gated ones included and marked gated (the session does the ordinary work and lists each risky step in its pull request), parked ones never, with what was skipped and why (a hand-started session can follow it); "digest" returns the morning digest, the pull requests ready, what blocked and why, and each job\'s usage. "models" returns what the model routing has learned: per job kind and model, the share merged with green CI, corrections and cost, with the rule changes the evidence supports and each trial arm\'s verdict against its kind\'s rule (never applied). All three are read-only. A caller scoped to one namespace names it; the plan is built over every namespace and narrowed to the one named.',
      ),
    stale: z
      .boolean()
      .optional()
      .describe(
        "For list: true returns the stale view, the blocked and claimed jobs that look stuck, each with rule (unchanged | resumed-not-completed | prs-settled | steps-seen) and a one-line reason. Read-only and costs no GitHub reads. Refused with view, status or id, and on any other action.",
      ),
    since: bounded(40)
      .optional()
      .describe(
        'For list with view "digest": the ISO time to report from. Defaults to the last 24 hours.',
      ),
    id: bounded(MAX_JOB_ID)
      .optional()
      .describe(
        "The job id: optional for claim, required for complete, fail, block, resume, supersede, release, begin, edit, park and unpark. For list, narrows to that job, with its body for a caller holding write.",
      ),
    result_summary: bounded(MAX_TITLE)
      .optional()
      .describe("For complete: what happened, in one sentence."),
    result_ref: resultRef
      .optional()
      .describe("For complete: where the work landed, a document key or a PR URL."),
    reason: bounded(MAX_TITLE)
      .optional()
      .describe(
        "For fail and block: why. For resume: what was approved, in one line; recorded in the audit row and returned as resume_note. For supersede: why the job was replaced or withdrawn. For park: one line saying when the job comes back. For release: why the holder is not coming back.",
      ),
    until: bounded(40)
      .optional()
      .describe(
        "For park: when the job comes back on its own, a date (2026-12-01, the start of that UTC day) or a time with its zone (2026-12-01T15:00:00Z), after now and within a year. The five-minute tick returns it to the queue then; without it the job waits for unpark.",
      ),
    note: bounded(MAX_RESUME_NOTE)
      .optional()
      .describe(
        "For resume: the full approval when it is longer than a line. Recorded in the audit row and returned as resume_note.note and in the mirrored document. reason is still required.",
      ),
    replaced_by: bounded(MAX_JOB_ID)
      .optional()
      .describe(
        "For supersede: the id of the replacing job, which must exist, be in the same namespace and not be this job. Omit it for a withdrawal.",
      ),
    command: bounded(MAX_TITLE)
      .optional()
      .describe("For block: the exact command the human must run."),
    question: z
      .boolean()
      .optional()
      .describe(
        "For block: true when the session needs an answer, not a command run. reason is the question; the Worker fixes the command as 'Answer in a resume note' (a command sent with it is refused). The job is marked a question in capsid_read_status action status and the Portal's feed, and the seat answers with resume and a note, which every later claim and list for the job returns.",
      ),
    approved_by_policy: bounded(32)
      .optional()
      .describe(
        "For resume: the signed gate policy version (capsid/policy/gates.md) the approval is made under. The blocked command must match a policy class (an additive migration, a branch push, opening a pull request) or the resume is refused. The admin or a can_merge caller may approve any class; a driver only its own job, and only a branch push or a pull request.",
      ),
    take: z
      .boolean()
      .optional()
      .describe(
        "For resume: the caller takes the claim instead of the driver that blocked the job. Runs every check a claim runs.",
      ),
    correction: z
      .boolean()
      .optional()
      .describe(
        "For resume: sends the work back to be corrected and spends one correction. A plain resume or an admin resume spends none.",
      ),
    evidence: z
      .union([
        z.strictObject({
          prs: z
            .array(resultRef)
            .max(MAX_EVIDENCE_PRS)
            .optional()
            .describe("Pull request URLs this job produced."),
          commits: z.number().int().nonnegative().optional(),
          files_changed: z.number().int().nonnegative().optional(),
          tests_added: z.number().int().nonnegative().optional(),
        }),
        // A JSON string is accepted too: a client that cached the schema before this parameter
        // existed refuses the object locally, and some clients flatten an object to a string;
        // refusing both would leave the outcome row storing nulls.
        bounded(MAX_BODY),
      ])
      .optional()
      .describe(
        "For complete: what the work produced, as an object or a JSON string. An omitted field is stored as NULL, not 0. For each named pull request the stored merge state, commit count and file count are read from GitHub; tests_added is stored as given.",
      ),
    // Same union as evidence; the string is parsed against the same strict schema, so an unknown
    // key is refused either way.
    claim: z
      .union([claimSchema, bounded(MAX_BODY)])
      .optional()
      .describe(
        "For complete, fail and block: what the agent says it did, as an object or a JSON string. prs_opened and prs_merged (pull request URLs), tests {run, passed, failed, result: pass|fail|partial|not_run}, deploy_state (none|pending|deployed|verified|failed), files_touched (paths), usage {cost_usd, active_seconds, tokens {input, output, cache_read, cache_creation}} for this session only (self-reported), versions {model_id, client_name, client_version, permission_mode} (self-reported). Recorded as sent, apart from what the Worker verifies. An omitted field is NULL, never 0; an unknown key or a string that is not JSON is refused.",
      ),
  },
};
