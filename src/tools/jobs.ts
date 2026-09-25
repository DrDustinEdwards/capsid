import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hintsFor } from "../tool-annotations";
import { z } from "zod";
import { bounded, MAX_BODY, MAX_RESUME_NOTE, MAX_TITLE, nsName, resultRef } from "../limits";
import { CORRECTION_CAP, JOB_ACTIONS, JOB_LEASE_SECONDS, JOB_STATUSES, isJobStatus } from "../jobs-schema";
import { SCOPE_FLAGS } from "../agents-schema";
import { blockJob, claimJob, completeJob, failJob, heartbeatJob, listJobs, postJob, resumeJob, supersedeJob, type JobResult } from "../jobs";
import { parseEvidence } from "../job-outcomes";
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
        `The work queue: post work from a chat, claim it from a machine, report back. The jobs table is the source of truth for status; every job also mirrors to <namespace>/jobs/<id>.md so brief and search see it, and that document is rewritten in the same batch as every transition. action "post" (write) queues a job: namespace, title, body (the full prompt the driver executes), optional priority (higher runs first) and gate_required when the work is known to need a human confirmation. The body is SIGNED with the same key and envelope as the improve loop's task documents, and the driver refuses a job whose body does not verify, so an edited row cannot steer a session holding local shell and repo credentials. One open job per (namespace, title): posting a duplicate while one is queued, claimed or BLOCKED is refused, and the refusal names the job that holds the title and its status. A blocked job counts as open because somebody is waiting on it. post also takes an optional min_record ({prs_merged: n}), the TRACK RECORD the work needs of its driver: the claim refuses an agent whose record is below the bar and leaves the job for one that clears it, measured against the same agent_record this Worker serves. action "list" (read) filters by namespace, status and id, and returns each job's id, namespace, title, status, priority, posted_by, claimed_by, lease_expires, gate_required, review_required, blocked and resumed counts, timestamps and result_summary, WITHOUT the body: the body is the signed prompt and comes back from claim, or from list when one job is named by id and the caller holds write. action "claim" (write) takes the highest-priority queued job in a namespace, or a named id, and sets a ${JOB_LEASE_SECONDS / 3600}-hour lease; it refuses if the caller already holds a claim anywhere, and exactly one caller wins a contested job because the claim is a keyed UPDATE with RETURNING. action "heartbeat" (write) extends the lease. action "complete" (write) needs result_summary and takes an optional result_ref (a document key or a PR URL) and an optional evidence object (prs, commits, files_changed, tests_added). Completing or failing a job writes ONE row to job_outcomes, and the Worker verifies what it can rather than storing what it was told: every pull request named in evidence is read from GitHub, so the merge count, the commit count and the file count stored are GitHub's, and the last one's head commit is checked for a CI conclusion. A field nobody reported is stored as NULL, never as 0. The response carries the row that was written and a note for every check that could not run. action "fail" (write) needs a reason. action "block" (write) is for a job that hit a gate and needs the human: it takes a reason and the exact command to run, and blocked jobs are what improve_status surfaces. action "resume" (write) is the way back: BLOCKED IS A PAUSE, NOT AN ENDING. Once the command is approved, resume moves the blocked job back to claimed with a fresh lease FOR THE DRIVER THAT BLOCKED IT, not for the caller, unless the caller passes take; it takes a required reason recording what was approved, and re-verifies the body's signature, because a blocked job sits in the table for as long as a human takes and resume hands it to a session with shell and repo credentials. It also takes an optional note, the seat's full approval (rulings, an ordered plan, several paragraphs), up to ${MAX_RESUME_NOTE} characters. The reason and the note are handed on IN FULL as resume_note (reason, note, by, at): resume returns it, and so do claim, heartbeat and list for one named id on any job that has been resumed, and the job's mirrored document carries it, so the driver that picks the job back up reads what was approved. Any write-grant caller may resume, deliberately: the seat that approves is routinely not the session that blocked. The one exception is the job's own claimant: a plain resume by the caller that blocked the job is refused, with or without take, unless that caller is the admin or holds can_merge, because a driver cannot approve its own gate; it may still use approved_by_policy for a branch push or a pull request. A plain resume does not spend the retry cap's budget; pass correction when the work is being sent back to be corrected. A plain resume may happen any number of times, but a CORRECTION is capped at ${CORRECTION_CAP} across every job posted for the same work: past that, resume is refused for everyone but the admin and the block carries the retry-cap reason, because a loop that has been corrected ${CORRECTION_CAP} times is a human decision rather than another round. improve_status reports both counts per blocked job. action "supersede" (write) closes a job the seat REPLACED before any work was done on it (a corrected or reposted body, a reorder, a withdrawal): it takes the id, a required reason, and replaced_by, the id of the job that replaces it in the same namespace, when there is one. It ends the job with status superseded and the summary "Superseded by <id>: <reason>" or "Superseded: <reason>". It is allowed on a queued job by any caller that may write its namespace, and on a claimed job only while no work is recorded (no gate hit, no resume, no correction, no result_ref) and only by the holder or the seat (admin or can_merge). Use it instead of claiming and failing a job to repost it. It writes NO job_outcomes row, so a superseded job counts in no agent record, failure count or skill score. heartbeat, complete, fail and block only fire for the claimed job THIS caller holds, so a lease the tick already expired cannot be finished out from under its new owner. An expired lease returns the job to queued on the five-minute tick. Every action is audit-logged with the caller's github: login or opkey: fingerprint.`,
      inputSchema: {
        action: z.enum(JOB_ACTIONS).describe("post | list | claim | heartbeat | complete | fail | block | resume | supersede."),
        namespace: nsName.optional().describe('For post, the namespace the work belongs to. For list and claim, the namespace to filter or pick from.'),
        title: bounded(MAX_TITLE).optional().describe('For post: the title. One open job per (namespace, title).'),
        body: bounded(MAX_BODY).optional().describe('For post: the full prompt the driver executes. Signed on the way in.'),
        priority: z.number().int().optional().describe('For post: higher runs first. Defaults to 0.'),
        gate_required: z.boolean().optional().describe('For post: the work is known to need a human confirmation (a push, a deploy, a secret). The driver stops at it rather than discovering the gate halfway through.'),
        review_required: z
          .boolean()
          .optional()
          .describe(
            "For post: this job's work needs a REVIEWER to speak before it reaches the seat. The driver cannot complete or block a job carrying a pull request until a comment on that pull request starts with 'REVIEW:' and ends with APPROVE, CHANGES or BLOCK. An APPROVE must also quote the pull request's current head sha (full, or a prefix of at least 7 hex characters), e.g. 'REVIEW: checked abc1234, reads right. APPROVE'; an APPROVE quoting no sha or an older head does not count, so a push after it needs a fresh review. APPROVE hands it on as now; CHANGES sends it back to the driver and spends a correction from the retry cap's budget; BLOCK stops it for the seat with the objection as the reason. The newest review wins, since a reviewer is allowed to change its mind."
          ),
        required_flags: z
          .array(z.enum(SCOPE_FLAGS))
          .optional()
          .describe(
            `For post: the blast-radius flags this job's work needs of the driver that claims it (${SCOPE_FLAGS.join(", ")}). The claim refuses an agent that does not hold them and leaves the job queued for one that does. Omit it for work that needs nothing unusual, which is most work.`
          ),
        min_record: z
          .object({ prs_merged: z.number().int().nonnegative() })
          .optional()
          .describe(
            "For post: the TRACK RECORD this job's work needs of the driver that claims it, as a minimum count of merged pull requests on that agent's record. The claim refuses an agent below the bar and leaves the job queued for one that clears it, checked against the same agent_record improve_status and the console show. Omit it for work that does not care, which is most work; a bar of 0 is no bar."
          ),
        status: bounded(32).optional().describe(`For list: one of ${JOB_STATUSES.join(" | ")}.`),
        id: bounded(MAX_JOB_ID).optional().describe('The job id, for claim (optional, to take a specific one), heartbeat, complete, fail, block, resume and supersede. For list, narrows to that one job, and a caller holding write then also gets its body.'),
        result_summary: bounded(MAX_TITLE).optional().describe('For complete: what happened, in a sentence the seat can read without opening the diff.'),
        result_ref: resultRef.optional().describe('For complete: where the work landed, a document key or a PR URL.'),
        reason: bounded(MAX_TITLE).optional().describe('For fail and block: why. For resume: what the human approved, in one line, which is what the audit row records and what the next holder of the job reads as resume_note. An approval longer than a line (rulings, a plan) goes in note, not here. For supersede: why the job was replaced or withdrawn.'),
        note: bounded(MAX_RESUME_NOTE)
          .optional()
          .describe(
            "For resume: the seat's full note, when the approval is more than a line: the rulings, an ordered plan, several paragraphs. Recorded in the audit row beside reason and handed to the next holder of the job in full, as resume_note.note and as a block in the job's mirrored document. reason is still required."
          ),
        replaced_by: bounded(MAX_JOB_ID)
          .optional()
          .describe("For supersede: the id of the job that replaces this one. It must exist, be in the same namespace, and not be the job itself. Omit it for a withdrawal."),
        command: bounded(MAX_TITLE).optional().describe('For block: the exact command the human must run. It goes into the summary the console shows.'),
        approved_by_policy: bounded(32)
          .optional()
          .describe(
            "For resume: the version of capsid/policy/gates.md this approval is made under. Pass it when a blocked command is approved on the signed gate policy rather than on a human having said yes. The Worker matches the command the job blocked on against the policy's classes (an additive migration, a branch push, opening a pull request) and REFUSES the resume when it matches none. The seat may approve any class; a driver may approve only its own blocked job, and only a branch push or a pull request. The audit row records which class matched and what it matched on."
          ),
        take: z
          .boolean()
          .optional()
          .describe("For resume: the caller takes the job's lease itself instead of returning the job to the driver that blocked it. Runs every check a claim runs."),
        correction: z
          .boolean()
          .optional()
          .describe("For resume: this resume sends the work back to be corrected, so it spends one correction from the retry cap's budget. A plain resume spends nothing. An admin resume never spends."),
        skills: z
          .object({
            offered: z.array(bounded(64)).max(16).optional().describe("Skill ids the recommend step offered this run."),
            used: z.array(bounded(64)).max(16).optional().describe("Skill ids this run actually followed. Must be a subset of offered."),
          })
          .optional()
          .describe(
            "For complete and fail: which skills this run was offered and which it used. NAMES ONLY. The credit direction is never taken from here: a win needs every named pull request merged and CI green as the WORKER read them off GitHub, a loss is a named PR that did not merge or CI red, and a run that named no pull request or could not be verified earns nothing in either direction. A skill id that does not exist is refused rather than dropped, and a skill named as used but not as offered is refused, because it did not come from the recommend step. Offered and used are stored separately on job_outcomes: the gap between them is how the recommend step itself is judged."
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
            // string.
            bounded(MAX_BODY),
          ])
          .optional()
          .describe(
            "For complete: what the work produced. Every field is optional and an omitted one is recorded as NULL, never as 0, because 'nobody counted' and 'the count was zero' are different facts. Naming pull requests is what unlocks verification: the Worker reads each one from GitHub and stores ITS merge state, commit count and file count rather than yours, and checks the last one's head commit for a CI conclusion. tests_added is never verifiable here and is stored as your claim."
          ),
      },
    },
    async (args) => {
      const now = new Date();
      try {
        if (args.action === "list") {
          // The read action needs the read grant. The registrar names no grant for
          // an "action" tool, so it is checked here.
          const listRefusal = ctx.scope({ tool: "jobs", action: "list", grant: "read", namespace: args.namespace });
          if (listRefusal) return fail(listRefusal);
          if (args.status !== undefined && !isJobStatus(args.status)) {
            return fail(`'${args.status}' is not a job status. One of: ${JOB_STATUSES.join(", ")}.`);
          }
          // The body only for ONE named job and a caller that could claim it anyway.
          // Asked through ctx.scope, the one shape a handler may use for a grant that
          // depends on the action.
          const withBody =
            Boolean(args.id) && ctx.scope({ tool: "jobs", action: "list", grant: "write", namespace: args.namespace }) === null;
          return ok(await listJobs(env, { namespace: args.namespace, status: args.status, id: args.id }, { withBody }));
        }
        // Every other action changes the queue, so it needs the write grant, checked
        // here with the action so the tools axis can narrow it (a watcher scoped to
        // `jobs.post` may post and may not claim).
        const refusal = ctx.scope({ tool: "jobs", action: args.action, grant: "write", namespace: args.namespace });
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
              await completeJob(env, agent, now, args.id, {
                result_summary: args.result_summary ?? "",
                result_ref: args.result_ref,
                evidence: parsedEvidence,
                skills: args.skills,
              })
            );
          }
          case "fail": {
            if (!args.id) return fail("fail needs the job id.");
            return reply(await failJob(env, agent, now, args.id, args.reason ?? "", args.skills));
          }
          case "block": {
            if (!args.id) return fail("block needs the job id.");
            return reply(await blockJob(env, agent, now, args.id, { reason: args.reason ?? "", command: args.command }));
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
