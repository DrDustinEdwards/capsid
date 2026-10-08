import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hintsFor } from "../tool-annotations";
import { z } from "zod";
import { bounded, MAX_BODY, MAX_RESUME_NOTE, MAX_TITLE, nsName, resultRef } from "../limits";
import { digestSinceFrom, readOvernightDigest, readOvernightPlan } from "../overnight-plan";
import { readModelLearning } from "../model-learning";
import { JOB_KINDS } from "../model-routing";
import { CORRECTION_CAP, JOB_ACTIONS, JOB_LEASE_SECONDS, JOB_STATUSES, isJobStatus } from "../jobs-schema";
import { SCOPE_FLAGS } from "../agents-schema";
import { blockJob, claimJob, completeAsCaller, failAsCaller, heartbeatJob, listJobs, postJob, releaseJob, resumeJob, supersedeJob, type JobResult } from "../jobs";
import { startSeatSession } from "../seat-start";
import { parseEvidence } from "../job-outcomes";
import { claimSchema } from "../job-claims";
import { fail, ok, type ToolCtx } from "./docs";

const MAX_JOB_ID = 64;

// How many pull requests one job may name as evidence. Each one costs a GitHub read
// inside `complete`, so the bound stops one call fanning out without limit.
const MAX_EVIDENCE_PRS = 10;

// A refusal is an error to the client (isError true), so a client that keys on
// isError does not read it as success. The body is the same JSON either way.
function reply(result: JobResult) {
  return result.ok ? ok(result) : { ...ok(result), isError: true };
}

export function registerJobTools(server: McpServer, ctx: ToolCtx): void {
  const { env, agent } = ctx;

  // The work queue's one tool, a ruled exception to the tool surface rule (CLAUDE.md;
  // capsid/decisions.md). Its actions share one tool because they are one subsystem
  // with one row shape, and a caller that has the tool has the whole lifecycle.
  server.registerTool(
    "jobs",
    {
      annotations: hintsFor("jobs"),
      description:
        `The work queue. Every job mirrors to <namespace>/jobs/<id>.md, rewritten on each transition. list needs the read grant; every other action needs the write grant. action "post" queues a job from namespace, title and body. The body is signed, and a driver refuses a body that does not verify. post is refused while a job with the same (namespace, title) is queued, claimed or blocked, and the refusal names that job. action "list" filters by namespace, status and id and returns each job's fields without the body; the body comes back from claim, or from list for one named id when the caller holds write. action "claim" takes the highest-priority queued job in a namespace, or a named id, with a ${JOB_LEASE_SECONDS / 3600}-hour lease. It returns offered_skills: up to three skills matched to the job's title and prompt, each with its instructions inline. The Worker records that offer at the job's first claim, and a later claim of the same job returns the same skills. Refused when the caller already holds as many claimed jobs as its claim limit (max_claims on the agents tool, 1 unless the admin raised it), when it holds a job on the repo this one would change and neither job is a design job (kind design), or when it lacks the job's required_flags or min_record. Each held job keeps its own lease. action "heartbeat" extends the lease. action "complete" needs result_summary and writes one job_outcomes row, verifying each pull request named in evidence or in a pull request result_ref against GitHub; the seat may complete a BLOCKED job another credential holds, which stays that holder's outcome; the response carries the row and a note for each check that could not run. block and complete that name a pull request of the namespace's repo (result_ref, evidence.prs, or a URL in the command) also read the files of every other open pull request there and, where any share a file, add one Overlaps line to the summary and return overlaps; a read that failed says not checked and never blocks the call. action "fail" needs a reason. action "block" needs a reason and the command the human must run, or question: true with the question as the reason (the Worker fixes the command as 'Answer in a resume note', and the seat answers with a resume note). complete, fail and block take an optional claim (what the agent says it did), recorded as sent in job_claims before anything is verified. action "resume" returns a blocked job to claimed with a fresh lease for the driver that blocked it, or for the caller with take. Without take, when that driver is at its claim limit or holds a job on the same repo, or the job was blocked by a shared identity (access:, github: or opkey:), the job goes back to queued instead. It needs reason and re-verifies the body's signature. resume, claim, heartbeat and list for one id return resume_note (reason, note, by, at). A plain resume by the job's own claimant is refused unless that caller is the admin or holds can_merge; the claimant may still resume with approved_by_policy for a branch push or a pull request. correction spends one correction; corrections are capped at ${CORRECTION_CAP} across every job posted for the same work, and past the cap resume is refused for everyone but the admin. action "supersede" ends a job replaced before any work was done (status superseded, no job_outcomes row); it needs reason. Allowed on a queued job for any caller that may write its namespace, and on a claimed job with no work recorded (no gate hit, resume, correction or result_ref) for the holder, the admin or a can_merge caller. action "start" starts a Claude Code session on GitHub's runners for one queued job in capsid or dustinedwards, by a repository_dispatch to that namespace's repo; it is for the admin or a can_merge caller, and is refused while the seat_start switch is off, for a repo that is not public, while a session for that repo is in flight, or at the cap. action "release" returns a claimed job held by another credential to the queue; it needs reason, is for the admin or a can_merge caller, and writes no job_outcomes row. heartbeat, complete and block act only on a claimed job this caller holds, the one the id names. fail does too, except for the admin or a can_merge caller, which may fail a job somebody else holds; that writes the holder's job_outcomes row. An expired lease returns the job to queued on the five-minute tick.`,
      inputSchema: {
        action: z.enum(JOB_ACTIONS).describe("post | list | claim | heartbeat | complete | fail | block | resume | supersede | release | start."),
        namespace: nsName.optional().describe('For post, the namespace the work belongs to. For list and claim, the namespace to filter or pick from.'),
        title: bounded(MAX_TITLE).optional().describe('For post: the title. One open job per (namespace, title).'),
        body: bounded(MAX_BODY).optional().describe('For post: the full prompt the driver executes. Signed on the way in.'),
        priority: z.number().int().optional().describe('For post: higher runs first. Defaults to 0.'),
        gate_required: z.boolean().optional().describe('For post: the work needs a human confirmation (a push, a deploy, a secret).'),
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
            'For list: "plan" returns the overnight plan, per repo the gate-free queued jobs in priority order that fit about 8 hours, with what was skipped and why (a hand-started session can follow it); "digest" returns the morning digest, the pull requests ready, what blocked and why, and each job\'s usage. "models" returns what the model routing has learned: per job kind and model, the share merged with green CI, corrections and cost, with the rule changes the evidence supports (never applied). All three are read-only. A caller scoped to one namespace names it; the plan is built over every namespace and narrowed to the one named.'
          ),
        since: bounded(40).optional().describe('For list with view "digest": the ISO time to report from. Defaults to the last 24 hours.'),
        id: bounded(MAX_JOB_ID).optional().describe('The job id: optional for claim, required for heartbeat, complete, fail, block, resume, supersede, release and start. For list, narrows to that job, with its body for a caller holding write.'),
        result_summary: bounded(MAX_TITLE).optional().describe('For complete: what happened, in one sentence.'),
        result_ref: resultRef.optional().describe('For complete: where the work landed, a document key or a PR URL.'),
        reason: bounded(MAX_TITLE).optional().describe('For fail and block: why. For resume: what was approved, in one line; recorded in the audit row and returned as resume_note. For supersede: why the job was replaced or withdrawn. For release: why the holder is not coming back.'),
        note: bounded(MAX_RESUME_NOTE)
          .optional()
          .describe(
            "For resume: the full approval when it is longer than a line. Recorded in the audit row and returned as resume_note.note and in the mirrored document. reason is still required."
          ),
        replaced_by: bounded(MAX_JOB_ID)
          .optional()
          .describe("For supersede: the id of the replacing job, which must exist, be in the same namespace and not be this job. Omit it for a withdrawal."),
        command: bounded(MAX_TITLE).optional().describe('For block: the exact command the human must run.'),
        question: z
          .boolean()
          .optional()
          .describe(
            "For block: true when the session needs an answer, not a command run. reason is the question; the Worker fixes the command as 'Answer in a resume note' (a command sent with it is refused). The job is marked a question in improve_status and the Portal's feed, and the seat answers with resume and a note, which every later claim, heartbeat and list for the job returns."
          ),
        approved_by_policy: bounded(32)
          .optional()
          .describe(
            "For resume: the signed gate policy version (capsid/policy/gates.md) the approval is made under. The blocked command must match a policy class (an additive migration, a branch push, opening a pull request) or the resume is refused. The admin or a can_merge caller may approve any class; a driver only its own job, and only a branch push or a pull request."
          ),
        take: z
          .boolean()
          .optional()
          .describe("For resume: the caller takes the lease instead of the driver that blocked the job. Runs every check a claim runs."),
        correction: z
          .boolean()
          .optional()
          .describe("For resume: sends the work back to be corrected and spends one correction. A plain resume or an admin resume spends none."),
        skills: z
          .object({
            offered: z.array(bounded(64)).max(16).optional().describe("Skill ids the recommend step offered this run."),
            used: z.array(bounded(64)).max(16).optional().describe("Skill ids this run actually followed. Must be a subset of offered."),
          })
          .optional()
          .describe(
            "For complete and fail: used names the offered skills this run actually followed. offered may be omitted: the Worker stores the offer it recorded at claim, and an offered list that differs from that record is refused, as is a used skill the job was not offered or an unknown id. Credit follows the outcome verified on GitHub, not this field."
          ),
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
            "For complete, fail and block: what the agent says it did, as an object or a JSON string. prs_opened and prs_merged (pull request URLs), tests {run, passed, failed, result: pass|fail|partial|not_run}, deploy_state (none|pending|deployed|verified|failed), files_touched (paths), usage {cost_usd, active_seconds, tokens {input, output, cache_read, cache_creation}} for this session only (self-reported), versions {model_id, client_name, client_version, permission_mode} (self-reported). Recorded as sent, apart from what the Worker verifies. An omitted field is NULL, never 0; an unknown key or a string that is not JSON is refused."
          ),
      },
    },
    async (args) => {
      const now = new Date();
      try {
        if (args.action === "list") {
          // The read action needs the read grant. The registrar names no grant for
          // an "action" tool, so it is checked here, and a read the caller may not
          // make is refused for its own reason rather than by a neighbouring check.
          // Every re-check here names the call's id as well as its action: a runner key
          // bound to one job is checked against the job the call names, and a re-check
          // with an action and no id reads as a call naming no job (src/scope.ts).
          const listRefusal = ctx.scope({ tool: "jobs", action: "list", grant: "read", namespace: args.namespace, jobId: args.id });
          if (listRefusal) return fail(listRefusal);
          if (args.view === "plan") return ok(await readOvernightPlan(env, { namespace: args.namespace }, now));
          // Outcomes across every namespace, as a rate per kind and model: a caller scoped to
          // one namespace has no business reading the whole account's record.
          if (args.view === "models") {
            const wide = ctx.scope({ tool: "jobs", action: "list", grant: "read", namespace: "*", jobId: args.id });
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
            Boolean(args.id) && ctx.scope({ tool: "jobs", action: "list", grant: "write", namespace: args.namespace, jobId: args.id }) === null;
          return ok(await listJobs(env, { namespace: args.namespace, status: args.status, id: args.id }, { withBody }));
        }
        // Every other action changes the queue, so it needs the write grant, checked
        // here with the action so the tools axis can narrow it (a watcher scoped to
        // `jobs.post` may post and may not claim).
        const refusal = ctx.scope({ tool: "jobs", action: args.action, grant: "write", namespace: args.namespace, jobId: args.id });
        if (refusal) return fail(refusal);
        switch (args.action) {
          case "post": {
            if (!args.namespace || !args.title || !args.body) {
              return fail("post needs namespace, title and body.");
            }
            return reply(
              await postJob(env, agent, now, {
                namespace: args.namespace,
                title: args.title,
                body: args.body,
                priority: args.priority,
                gate_required: args.gate_required,
                required_scopes: args.required_flags ? { flags: args.required_flags } : undefined,
                min_record: args.min_record,
                review_required: args.review_required,
                kind: args.kind,
              })
            );
          }
          case "claim":
            return reply(await claimJob(env, agent, now, { namespace: args.namespace, id: args.id }));
          case "heartbeat": {
            if (!args.id) return fail("heartbeat needs the job id.");
            return reply(await heartbeatJob(env, agent, now, args.id));
          }
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
                skills: args.skills,
                claim: args.claim,
                // As received, so job_claims.raw keeps the evidence the driver sent and
                // not parseEvidence's reading of it.
                raw: { evidence: args.evidence, claim: args.claim, result_summary: args.result_summary, result_ref: args.result_ref },
              })
            );
          }
          case "fail": {
            if (!args.id) return fail("fail needs the job id.");
            return reply(
              await failAsCaller(env, agent, now, args.id, args.reason ?? "", args.skills, {
                claim: args.claim,
                raw: { claim: args.claim, reason: args.reason },
              })
            );
          }
          case "start": {
            if (!args.id) return fail("start needs the job id.");
            return reply(await startSeatSession(env, agent, now, args.id));
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
          case "supersede": {
            if (!args.id) return fail("supersede needs the job id.");
            return reply(await supersedeJob(env, agent, now, args.id, { reason: args.reason ?? "", replaced_by: args.replaced_by }));
          }
        }
        return fail(`unknown jobs action '${args.action}'.`);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
