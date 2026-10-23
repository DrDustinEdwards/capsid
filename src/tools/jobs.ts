import { McpServer } from "@modelcontextprotocol/server";
import { JOBS_TOOL } from "../scope";
import { z } from "zod";
import { bounded, MAX_BODY, MAX_RESUME_NOTE, MAX_TITLE, nsName, resultRef } from "../limits";
import { digestSinceFrom, readOvernightDigest, readOvernightPlan } from "../overnight-plan";
import { readModelLearning } from "../model-learning";
import { JOB_KINDS } from "../model-routing";
import { CORRECTION_CAP, JOB_ACTIONS, JOB_STATUSES, isJobStatus } from "../jobs-schema";
import { SCOPE_FLAGS } from "../agents-schema";
import { beginJob, blockJob, claimJob, completeAsCaller, recordAsCaller, editJob, failAsCaller, jobVersions, listJobs, parkJob, postJob, releaseJob, resumeJob, supersedeJob, unparkJob, type JobResult } from "../jobs";
import { fireRoutine, setRoutine } from "../routine-fire";
import { parseEvidence } from "../job-outcomes";
import { claimSchema } from "../job-claims";
import { staleJobs } from "../stale-jobs";
import { jobTextRefusal, missingPartsWarning } from "../job-body-check";
import { factCheckBody } from "../job-fact-check";
import { fail, ok, type ToolCtx } from "./docs";

const MAX_JOB_ID = 64;

// How many pull requests one job may name as evidence. Each one costs a GitHub read
// inside `complete`, so the bound stops one call fanning out without limit.
const MAX_EVIDENCE_PRS = 10;

// The caller-facing body checks (src/job-body-check.ts): post refuses an unfilled placeholder
// and a claim read as false (src/job-fact-check.ts) here, edit inside editJob once the caller
// is known to be the seat, and both warn when a body lacks the five headed parts or states a
// claim that could not be checked.
function withWarnings(result: JobResult, body: string | undefined, facts: string[] = []): JobResult {
  if (!result.ok) return result;
  const missing = body === undefined ? null : missingPartsWarning(body);
  const warnings = [...(result.warnings ?? []), ...facts, ...(missing ? [missing] : [])];
  return warnings.length > 0 ? { ...result, warnings } : result;
}

// A refusal is an error to the client (isError true), so a client that keys on
// isError does not read it as success. The body is the same JSON either way.
function reply(result: JobResult) {
  return result.ok ? ok(result) : { ...ok(result), isError: true };
}

export function defineJobOperations(server: McpServer, ctx: ToolCtx): void {
  const { env, agent } = ctx;

  // The work queue's one tool, a ruled exception to the tool surface rule (CLAUDE.md).
  // Its actions share one tool because they are one subsystem
  // with one row shape, and a caller that has the tool has the whole lifecycle.
  ctx.ops.define(
    "jobs",
    {
      description:
        `The work queue. Each job mirrors to <namespace>/jobs/<id>.md. list needs the read grant; every other action needs the write grant. "Seat" below means the admin or a can_merge caller. Full rules: docs/work-queue.md.
post: queue a job from namespace, title and body. The body is signed; a driver refuses one that does not verify. Refused while another open job has the same (namespace, title), or when the title or body holds an unfilled placeholder (<ID>, {{...}}, TODO:, TBD) outside a code block; warns when the body lacks GOAL, DO, OUT OF SCOPE, DONE WHEN or DECIDED/RULES parts. A body stating as done that a PR merged, a version was tagged or published to npm is checked and refused when false.
list: filter by namespace, status and id, without bodies; one named id returns its body and edit versions to a writer. stale: true returns blocked or claimed jobs that look stuck (unchanged, resumed-not-completed, prs-settled, steps-seen). view: plan, digest or models.
claim: take the top queued job in a namespace, or a named id. The claim never expires. Returns the recommended model. Refused without the job's required_flags or min_record, or while the namespace's breaker is open.
begin: label a queued job started (who, when). Verifies the body's signature; never refuses otherwise.
complete: needs result_summary; writes one outcome row and verifies each named pull request against GitHub. Also closes a queued job nobody holds when it names the job's pull request (the pull request is the claim), and lets the seat close a blocked job another credential holds.
record: the seat's close of a queued job somebody else did, with the same review gate and evidence checks.
block: needs reason and the command the human must run, or question: true with the question as the reason, answered by a resume note.
Complete and block that name a pull request also report open pull requests sharing a file (overlaps); a failed read says not checked and never blocks.
fail: needs reason. The seat may fail a job somebody else holds.
complete, fail and block take an optional claim (what the agent says it did), recorded before anything is verified.
resume: returns a blocked job to claimed for its blocker, or to the caller with take; a job blocked by a shared identity (access:, github:, opkey:) goes back to queued. Needs reason and re-verifies the signature. A plain resume needs the seat; the claimant may resume on approved_by_policy for a branch push or a pull request. correction spends one correction; corrections are capped at ${CORRECTION_CAP} per piece of work, past which only the admin may resume.
supersede: end a job replaced before work began; needs reason. Any writer on a queued job; the holder or the seat on a claimed job with no work recorded.
release: the seat returns a job another credential holds to the queue; needs reason.
edit: the seat changes title, body, priority or gate_required of a queued or blocked job; the old version is kept.
park / unpark: the seat sets a queued job aside with a one-line reason, or returns it to queued. A parked job is never claimed or planned and holds no title slot.
routine: read a namespace's routine, or with routine_url set or clear ("off") its fire URL. Seat only.
fire: the seat starts a cloud session for one queued, verified job through its namespace's routine (token in ROUTINE_<NS>_TOKEN) and marks it started. Refusals name their cause (already started or fired, no routine or token, Anthropic's answer).
block and complete act only on a job this caller holds, except as stated above.`,
      inputSchema: {
        action: z.enum(JOB_ACTIONS).describe("post | list | claim | complete | record | fail | block | resume | supersede | release | begin | fire | routine | edit | park | unpark."),
        namespace: nsName.optional().describe('For post, the namespace the work belongs to. For list and claim, the namespace to filter or pick from. For routine, the namespace whose routine is read or set.'),
        title: bounded(MAX_TITLE).optional().describe('For post and edit: the title. One open job per (namespace, title).'),
        body: bounded(MAX_BODY).optional().describe('For post and edit: the full prompt the driver executes. Signed on the way in.'),
        priority: z.number().int().optional().describe('For post and edit: higher runs first. Defaults to 0 at post.'),
        gate_required: z.boolean().optional().describe('For post and edit: the work needs a human confirmation (a push, a deploy, a secret).'),
        review_required: z
          .boolean()
          .optional()
          .describe(
            "For post: complete and block on a job carrying a pull request are refused until a PR comment starts 'REVIEW:' and ends APPROVE, CHANGES or BLOCK; the newest counts. APPROVE must quote the current head sha (at least 7 hex characters). CHANGES sends the job back and spends a correction; BLOCK blocks it with the objection as the reason."
          ),
        required_flags: z
          .array(z.enum(SCOPE_FLAGS))
          .optional()
          .describe(
            `For post: the flags the claiming driver must hold (${SCOPE_FLAGS.join(", ")}). The claim refuses an agent without them and leaves the job queued.`
          ),
        min_record: z
          .object({ prs_merged: z.number().int().nonnegative() })
          .optional()
          .describe(
            "For post: the minimum merged pull requests on the claiming agent's record. The claim refuses an agent below it and leaves the job queued."
          ),
        kind: z
          .enum(JOB_KINDS)
          .optional()
          .describe(
            `For post: the job's kind (${JOB_KINDS.join(", ")}). Optional: when absent Capsid reads it from the poster and the title. The kind and the job's risk decide the model Capsid recommends; nobody names a model.`
          ),
        status: bounded(32).optional().describe(`For list: one of ${JOB_STATUSES.join(" | ")}.`),
        view: z
          .enum(["plan", "digest", "models"])
          .optional()
          .describe(
            'For list: "plan" returns the overnight plan, per repo the queued jobs in priority order that fit about 8 hours, gated ones included and marked gated (the session does the ordinary work and lists each risky step in its pull request), parked ones never, with what was skipped and why (a hand-started session can follow it); "digest" returns the morning digest, the pull requests ready, what blocked and why, and each job\'s usage. "models" returns what the model routing has learned: per job kind and model, the share merged with green CI, corrections and cost, with the rule changes the evidence supports and each trial arm\'s verdict against its kind\'s rule (never applied). All three are read-only. A caller scoped to one namespace names it; the plan is built over every namespace and narrowed to the one named.'
          ),
        stale: z
          .boolean()
          .optional()
          .describe(
            "For list: true returns the stale view, the blocked and claimed jobs that look stuck, each with rule (unchanged | resumed-not-completed | prs-settled | steps-seen) and a one-line reason. Read-only and costs no GitHub reads. Refused with view, status or id, and on any other action."
          ),
        since: bounded(40).optional().describe('For list with view "digest": the ISO time to report from. Defaults to the last 24 hours.'),
        id: bounded(MAX_JOB_ID).optional().describe('The job id: optional for claim, required for complete, fail, block, resume, supersede, release, begin, fire, edit, park and unpark. For list, narrows to that job, with its body for a caller holding write.'),
        result_summary: bounded(MAX_TITLE).optional().describe('For complete: what happened, in one sentence.'),
        result_ref: resultRef.optional().describe('For complete: where the work landed, a document key or a PR URL.'),
        reason: bounded(MAX_TITLE).optional().describe('For fail and block: why. For resume: what was approved, in one line; recorded in the audit row and returned as resume_note. For supersede: why the job was replaced or withdrawn. For park: one line saying when the job comes back. For release: why the holder is not coming back.'),
        note: bounded(MAX_RESUME_NOTE)
          .optional()
          .describe(
            "For resume: the full approval when it is longer than a line. Recorded in the audit row and returned as resume_note.note and in the mirrored document. reason is still required."
          ),
        replaced_by: bounded(MAX_JOB_ID)
          .optional()
          .describe("For supersede: the id of the replacing job, which must exist, be in the same namespace and not be this job. Omit it for a withdrawal."),
        command: bounded(MAX_TITLE).optional().describe('For block: the exact command the human must run.'),
        routine_url: bounded(256)
          .optional()
          .describe('For routine: the namespace\'s fire URL, https://api.anthropic.com/v1/claude_code/routines/trig_.../fire, or "off" to clear it. Omit it to read the routine.'),
        question: z
          .boolean()
          .optional()
          .describe(
            "For block: true when the session needs an answer, not a command run. reason is the question; the Worker fixes the command as 'Answer in a resume note' (a command sent with it is refused). The job is marked a question in capsid_run_improve action status and the Portal's feed, and the seat answers with resume and a note, which every later claim and list for the job returns."
          ),
        approved_by_policy: bounded(32)
          .optional()
          .describe(
            "For resume: the signed gate policy version (capsid/policy/gates.md) the approval is made under. The blocked command must match a policy class (an additive migration, a branch push, opening a pull request) or the resume is refused. The admin or a can_merge caller may approve any class; a driver only its own job, and only a branch push or a pull request."
          ),
        take: z
          .boolean()
          .optional()
          .describe("For resume: the caller takes the claim instead of the driver that blocked the job. Runs every check a claim runs."),
        correction: z
          .boolean()
          .optional()
          .describe("For resume: sends the work back to be corrected and spends one correction. A plain resume or an admin resume spends none."),
        evidence: z
          .union([
            z.object({
              prs: z.array(resultRef).max(MAX_EVIDENCE_PRS).optional().describe("Pull request URLs this job produced."),
              commits: z.number().int().nonnegative().optional(),
              files_changed: z.number().int().nonnegative().optional(),
              tests_added: z.number().int().nonnegative().optional(),
            }),
            // A JSON string is accepted too. An MCP client caches the tool schema at
            // connect time, so a session that connected before this parameter existed
            // refuses the object locally, and some clients flatten an object to a
            // string. Both are a caller that knows what it did and cannot say so in the
            // shape asked for; refusing them would leave the outcome row storing nulls.
            bounded(MAX_BODY),
          ])
          .optional()
          .describe(
            "For complete: what the work produced, as an object or a JSON string. An omitted field is stored as NULL, not 0. For each named pull request the stored merge state, commit count and file count are read from GitHub; tests_added is stored as given."
          ),
        // The same object-or-string union as evidence, for the same reason. The object
        // is strict (src/job-claims.ts), and the string form is parsed against the same
        // schema, so an unknown key is refused either way rather than dropped.
        claim: z
          .union([claimSchema, bounded(MAX_BODY)])
          .optional()
          .describe(
            "For complete, fail and block: what the agent says it did, as an object or a JSON string. prs_opened and prs_merged (pull request URLs), tests {run, passed, failed, result: pass|fail|partial|not_run}, reproduction {test, command, before {result: fail|pass|error, output}, after {result, output}} (the test that shows the issue, run before and after the fix), deploy_state (none|pending|deployed|verified|failed), files_touched (paths), usage {cost_usd, active_seconds, tokens {input, output, cache_read, cache_creation}} for this session only (self-reported), versions {model_id, client_name, client_version, permission_mode} (self-reported). Recorded as sent, apart from what the Worker verifies. An omitted field is NULL, never 0; an unknown key or a string that is not JSON is refused."
          ),
      },
    },
    async (args) => {
      const now = new Date();
      try {
        if (args.stale !== undefined && args.action !== "list") {
          return fail(`stale is for action list only; ${args.action} does not take it.`);
        }
        if (args.action === "list") {
          // The read action needs the read grant. The registrar names no grant for
          // an "action" tool, so it is checked here, and a read the caller may not
          // make is refused for its own reason rather than by a neighbouring check.
          const listRefusal = ctx.scope({ tool: JOBS_TOOL, action: "list", grant: "read", namespace: args.namespace });
          if (listRefusal) return fail(listRefusal);
          // The stale view (src/stale-jobs.ts). Its own view of the queue, so it does not
          // combine with another view, a status filter or one id. Narrowed to the namespace
          // the caller named; a caller scoped to one namespace must name it (the registrar).
          if (args.stale === true) {
            if (args.view !== undefined || args.status !== undefined || args.id !== undefined) {
              return fail("stale: true is its own view of the queue; send it without view, status or id (namespace may narrow it).");
            }
            const stale = await staleJobs(env, now, { namespace: args.namespace });
            return ok({
              ok: true,
              action: "list",
              stale: stale.rows,
              ...(stale.truncated ? { truncated: true } : {}),
              ...(stale.note ? { note: stale.note } : {}),
            });
          }
          if (args.view === "plan") return ok(await readOvernightPlan(env, { namespace: args.namespace }, now));
          // Outcomes across every namespace, as a rate per kind and model: a caller scoped to
          // one namespace has no business reading the whole account's record.
          if (args.view === "models") {
            const wide = ctx.scope({ tool: JOBS_TOOL, action: "list", grant: "read", namespace: "*" });
            if (wide) return fail(`the models view reads every namespace's outcomes, which this caller may not: ${wide}`);
            return ok({ ok: true, action: "list", models: await readModelLearning(env.DB, now) });
          }
          if (args.view === "digest") {
            const since = digestSinceFrom(args.since, now);
            if (!since.ok) return fail(since.refusal);
            return ok(await readOvernightDigest(env, { namespace: args.namespace, since: since.since }, now));
          }
          if (args.status !== undefined && !isJobStatus(args.status)) {
            return fail(`'${args.status}' is not a job status. One of: ${JOB_STATUSES.join(", ")}.`);
          }
          // The body only for ONE named job and a caller that could claim it anyway.
          // Asked through ctx.scope, the one shape a handler may use for a grant that
          // depends on the action.
          const withBody =
            Boolean(args.id) && ctx.scope({ tool: JOBS_TOOL, action: "list", grant: "write", namespace: args.namespace }) === null;
          const listed = await listJobs(env, { namespace: args.namespace, status: args.status, id: args.id }, { withBody });
          // The versions earlier edits replaced carry old bodies, so they go to the same
          // caller the body does.
          if (withBody && args.id && listed.jobs?.length === 1) listed.versions = await jobVersions(env.DB, args.id);
          return ok(listed);
        }
        // Every other action changes the queue, so it needs the write grant, checked
        // here with the action so the tools axis can narrow it (a watcher scoped to
        // `capsid_work_jobs.post` may post and may not claim).
        const refusal = ctx.scope({ tool: JOBS_TOOL, action: args.action, grant: "write", namespace: args.namespace });
        if (refusal) return fail(refusal);
        switch (args.action) {
          case "post": {
            if (!args.namespace || !args.title || !args.body) {
              return fail("post needs namespace, title and body.");
            }
            const unfilled = jobTextRefusal(args.title, args.body);
            if (unfilled) return reply({ ok: false, action: "post", refusal: unfilled });
            const facts = await factCheckBody(env, args.namespace, args.body);
            if (facts.refusal) return reply({ ok: false, action: "post", refusal: facts.refusal });
            return reply(
              withWarnings(await postJob(env, agent, now, {
                namespace: args.namespace,
                title: args.title,
                body: args.body,
                priority: args.priority,
                gate_required: args.gate_required,
                required_scopes: args.required_flags ? { flags: args.required_flags } : undefined,
                min_record: args.min_record,
                review_required: args.review_required,
                kind: args.kind,
              }), args.body, facts.warnings)
            );
          }
          case "claim":
            return reply(await claimJob(env, agent, now, { namespace: args.namespace, id: args.id }));
          case "complete": {
            if (!args.id) return fail("complete needs the job id.");
            // A string that does not parse is refused rather than ignored, so a row
            // never silently says nothing happened.
            const parsed = parseEvidence(args.evidence);
            if ("error" in parsed) return fail(parsed.error);
            const parsedEvidence = parsed.evidence;
            return reply(
              await completeAsCaller(env, agent, now, args.id, {
                result_summary: args.result_summary ?? "",
                result_ref: args.result_ref,
                evidence: parsedEvidence,
                claim: args.claim,
                // As received, so job_claims.raw keeps the evidence the driver sent and
                // not parseEvidence's reading of it.
                raw: { evidence: args.evidence, claim: args.claim, result_summary: args.result_summary, result_ref: args.result_ref },
              })
            );
          }
          case "record": {
            if (!args.id) return fail("record needs the job id.");
            const parsed = parseEvidence(args.evidence);
            if ("error" in parsed) return fail(parsed.error);
            return reply(
              await recordAsCaller(env, agent, now, args.id, {
                result_summary: args.result_summary ?? "",
                result_ref: args.result_ref,
                evidence: parsed.evidence,
                claim: args.claim,
                raw: { evidence: args.evidence, claim: args.claim, result_summary: args.result_summary, result_ref: args.result_ref },
              })
            );
          }
          case "fail": {
            if (!args.id) return fail("fail needs the job id.");
            return reply(
              await failAsCaller(env, agent, now, args.id, args.reason ?? "", {
                claim: args.claim,
                raw: { claim: args.claim, reason: args.reason },
              })
            );
          }
          case "fire": {
            if (!args.id) return fail("fire needs the job id.");
            return reply(await fireRoutine(env, agent, now, args.id));
          }
          case "routine": {
            return reply(await setRoutine(env, agent, args.namespace, args.routine_url));
          }
          case "begin": {
            if (!args.id) return fail("begin needs the job id.");
            return reply(await beginJob(env, agent, now, args.id));
          }
          case "release": {
            if (!args.id) return fail("release needs the job id.");
            return reply(await releaseJob(env, agent, now, args.id, args.reason ?? ""));
          }
          case "block": {
            if (!args.id) return fail("block needs the job id.");
            return reply(
              await blockJob(env, agent, now, args.id, {
                reason: args.reason ?? "",
                command: args.command,
                question: args.question,
                claim: args.claim,
                raw: { claim: args.claim, reason: args.reason, command: args.command },
              })
            );
          }
          case "resume": {
            if (!args.id) return fail("resume needs the job id.");
            return reply(await resumeJob(env, agent, now, args.id, args.reason ?? "", {
                approvedByPolicy: args.approved_by_policy,
                take: args.take,
                correction: args.correction,
                note: args.note,
              }));
          }
          case "edit": {
            if (!args.id) return fail("edit needs the job id.");
            return reply(
              withWarnings(await editJob(env, agent, now, args.id, {
                title: args.title,
                body: args.body,
                priority: args.priority,
                gate_required: args.gate_required,
              }), args.body)
            );
          }
          case "park": {
            if (!args.id) return fail("park needs the job id.");
            return reply(await parkJob(env, agent, now, args.id, args.reason));
          }
          case "unpark": {
            if (!args.id) return fail("unpark needs the job id.");
            return reply(await unparkJob(env, agent, now, args.id));
          }
          case "supersede": {
            if (!args.id) return fail("supersede needs the job id.");
            return reply(await supersedeJob(env, agent, now, args.id, { reason: args.reason ?? "", replaced_by: args.replaced_by }));
          }
        }
        return fail(`unknown jobs action '${String(args.action as unknown as string)}'.`);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
