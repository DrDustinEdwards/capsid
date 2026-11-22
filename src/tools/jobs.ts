import { McpServer } from "@modelcontextprotocol/server";
import { JOBS_TOOL } from "../scope";
import { digestSinceFrom, readOvernightDigest } from "../overnight-digest";
import { readOvernightPlan } from "../overnight-plan";
import { readModelLearning } from "../model-learning";
import {
  beginJob,
  blockJob,
  claimJob,
  completeAsCaller,
  recordAsCaller,
  editJob,
  failAsCaller,
  jobVersions,
  listJobs,
  parkJob,
  postJob,
  releaseJob,
  resumeJob,
  supersedeJob,
  unparkJob,
  type JobResult,
} from "../jobs";
import { parseEvidence } from "../job-outcomes";
import { staleJobs } from "../stale-jobs";
import { jobTextRefusal, missingPartsWarning } from "../job-body-check";
import { checklistWarning } from "../job-checklist";
import { factCheckBody } from "../job-fact-check";
import { fail, ok, type ToolCtx } from "./docs";
import { JOBS_DEFINITION } from "./jobs-input";

import { errorMessage } from "@dustinedwards/site-runtime/log";

// The caller-facing body checks (src/job-body-check.ts): post refuses an unfilled placeholder
// and a claim read as false (src/job-fact-check.ts) here, edit inside editJob once the caller
// is known to be the seat, and both warn when a body lacks the five headed parts or states a
// claim that could not be checked.
function withWarnings(
  result: JobResult,
  body: string | undefined,
  facts: string[] = [],
): JobResult {
  if (!result.ok) return result;
  const missing = body === undefined ? null : missingPartsWarning(body);
  const long = body === undefined ? null : checklistWarning(body);
  const warnings = [
    ...(result.warnings ?? []),
    ...facts,
    ...(missing ? [missing] : []),
    ...(long ? [long] : []),
  ];
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
  ctx.ops.define("jobs", JOBS_DEFINITION, async (args) => {
    const now = new Date();
    try {
      if (args.stale !== undefined && args.action !== "list") {
        return fail(`stale is for action list only; ${args.action} does not take it.`);
      }
      if (args.action === "list") {
        // The read action needs the read grant. The registrar names no grant for
        // an "action" tool, so it is checked here, and a read the caller may not
        // make is refused for its own reason rather than by a neighboring check.
        const listRefusal = ctx.scope({
          tool: JOBS_TOOL,
          action: "list",
          grant: "read",
          namespace: args.namespace,
        });
        if (listRefusal) return fail(listRefusal);
        // The stale view (src/stale-jobs.ts). Its own view of the queue, so it does not
        // combine with another view, a status filter or one id. Narrowed to the namespace
        // the caller named; a caller scoped to one namespace must name it (the registrar).
        if (args.stale === true) {
          if (args.view !== undefined || args.status !== undefined || args.id !== undefined) {
            return fail(
              "stale: true is its own view of the queue; send it without view, status or id (namespace may narrow it).",
            );
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
        if (args.view === "plan")
          return ok(await readOvernightPlan(env, { namespace: args.namespace }, now));
        // Outcomes across every namespace, as a rate per kind and model: a caller scoped to
        // one namespace has no business reading the whole account's record.
        if (args.view === "models") {
          const wide = ctx.scope({
            tool: JOBS_TOOL,
            action: "list",
            grant: "read",
            namespace: "*",
          });
          if (wide)
            return fail(
              `the models view reads every namespace's outcomes, which this caller may not: ${wide}`,
            );
          return ok({ ok: true, action: "list", models: await readModelLearning(env.DB, now) });
        }
        if (args.view === "digest") {
          const since = digestSinceFrom(args.since, now);
          if (!since.ok) return fail(since.refusal);
          return ok(
            await readOvernightDigest(env, { namespace: args.namespace, since: since.since }, now),
          );
        }
        // The body only for ONE named job and a caller that could claim it anyway.
        // Asked through ctx.scope, the one shape a handler may use for a grant that
        // depends on the action.
        const withBody =
          Boolean(args.id) &&
          ctx.scope({
            tool: JOBS_TOOL,
            action: "list",
            grant: "write",
            namespace: args.namespace,
          }) === null;
        const listed = await listJobs(
          env,
          { namespace: args.namespace, status: args.status, id: args.id },
          { withBody },
        );
        // The versions earlier edits replaced carry old bodies, so they go to the same
        // caller the body does.
        if (withBody && args.id && listed.jobs?.length === 1)
          listed.versions = await jobVersions(env.DB, args.id);
        return ok(listed);
      }
      // Every other action changes the queue, so it needs the write grant, checked
      // here with the action so the tools axis can narrow it (a watcher scoped to
      // `capsid_work_jobs.post` may post and may not claim).
      const refusal = ctx.scope({
        tool: JOBS_TOOL,
        action: args.action,
        grant: "write",
        namespace: args.namespace,
      });
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
            withWarnings(
              await postJob(env, agent, now, {
                namespace: args.namespace,
                title: args.title,
                body: args.body,
                priority: args.priority,
                gate_required: args.gate_required,
                required_scopes: args.required_flags ? { flags: args.required_flags } : undefined,
                min_record: args.min_record,
                kind: args.kind,
              }),
              args.body,
              facts.warnings,
            ),
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
              raw: {
                evidence: args.evidence,
                claim: args.claim,
                result_summary: args.result_summary,
                result_ref: args.result_ref,
              },
            }),
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
              raw: {
                evidence: args.evidence,
                claim: args.claim,
                result_summary: args.result_summary,
                result_ref: args.result_ref,
              },
            }),
          );
        }
        case "fail": {
          if (!args.id) return fail("fail needs the job id.");
          return reply(
            await failAsCaller(env, agent, now, args.id, args.reason ?? "", {
              claim: args.claim,
              raw: { claim: args.claim, reason: args.reason },
            }),
          );
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
            }),
          );
        }
        case "resume": {
          if (!args.id) return fail("resume needs the job id.");
          return reply(
            await resumeJob(env, agent, now, args.id, args.reason ?? "", {
              approvedByPolicy: args.approved_by_policy,
              take: args.take,
              correction: args.correction,
              note: args.note,
            }),
          );
        }
        case "edit": {
          if (!args.id) return fail("edit needs the job id.");
          return reply(
            withWarnings(
              await editJob(env, agent, now, args.id, {
                title: args.title,
                body: args.body,
                priority: args.priority,
                gate_required: args.gate_required,
              }),
              args.body,
            ),
          );
        }
        case "park": {
          if (!args.id) return fail("park needs the job id.");
          return reply(await parkJob(env, agent, now, args.id, args.reason, args.until));
        }
        case "unpark": {
          if (!args.id) return fail("unpark needs the job id.");
          return reply(await unparkJob(env, agent, now, args.id));
        }
        case "supersede": {
          if (!args.id) return fail("supersede needs the job id.");
          return reply(
            await supersedeJob(env, agent, now, args.id, {
              reason: args.reason ?? "",
              replaced_by: args.replaced_by,
            }),
          );
        }
      }
      return fail(`unknown jobs action '${String(args.action as unknown as string)}'.`);
    } catch (err) {
      return fail(errorMessage(err));
    }
  });
}
