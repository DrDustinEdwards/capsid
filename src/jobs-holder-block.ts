// fail and block: the holder's gate and failure transitions.
import type { Env } from "./env";
import type { Agent } from "./agents";
import {
  swallowedParamTag,
  swallowedTagRefusal,
  atCorrectionCap,
  cappedSummary,
} from "./jobs-schema";
import { parseClaim, type ClaimInput, type ClaimRaw } from "./job-claims";
import { checkOverlaps, overlapLine, prUrlsIn } from "./job-overlaps";
import {
  callerIsSeat,
  correctionsForWork,
  readJob,
  refuse,
  type JobResult,
} from "./jobs-transition";
import { actorKind, touchStatement } from "./job-touches";
import { breakerExemption } from "./fail-exemption";
import { holderTransition } from "./jobs-holder";

export async function failJob(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  reason: string,
  said: { claim?: ClaimInput; raw?: ClaimRaw } = {},
): Promise<JobResult> {
  if (!reason?.trim())
    return refuse(
      "fail",
      "fail needs a reason. A failed job with no reason is one nobody can retry or rule on.",
    );
  const failSwallowed = swallowedParamTag(reason);
  if (failSwallowed) return refuse("fail", swallowedTagRefusal("reason", failSwallowed));
  const failClaim = parseClaim(said.claim);
  if ("error" in failClaim) return refuse("fail", failClaim.error);
  const failRaw: ClaimRaw = said.raw ?? { claim: said.claim, reason };
  const held = await readJob(env.DB, id);
  const breakerExempt =
    held && held.claimed_by === agent.actor ? await breakerExemption(env, held, reason) : null;
  return holderTransition(env, agent, now, "fail", id, {
    status: "failed",
    result_summary: reason,
    breakerExempt,
    said: { claim: failClaim.claim, raw: failRaw },
  });
}

// A blocked job carries the exact command: a gate is work waiting on a human, who needs the
// command to run. blockJob writes this marker and commandFromSummary reads it back, so the
// format cannot drift.
export const RESUME_MARKER =
  "Run this, then send it back in with capsid_work_jobs action 'resume':";

/** Where a summary's resume marker starts and how long it is, or null with none. */
export function resumeMarkerIn(summary: string): { at: number; length: number } | null {
  const at = summary.indexOf(RESUME_MARKER);
  return at === -1 ? null : { at, length: RESUME_MARKER.length };
}

// A question block: a session that needs an answer blocks with question: true. The Worker
// fixes the command, and the summary starts with this prefix, which is how every reader tells
// it from a gate. No new status or column: the seat answers with resume and a note.
const QUESTION_PREFIX = "QUESTION: ";
const QUESTION_COMMAND = "Answer in a resume note";

/** Whether a blocked job's summary is a question block. */
export function isQuestionSummary(summary: string | null): boolean {
  return summary !== null && summary.startsWith(QUESTION_PREFIX);
}

/** The exact command a blocked job is waiting on, or null when it recorded none. */
export function commandFromSummary(summary: string | null): string | null {
  if (!summary) return null;
  const found = resumeMarkerIn(summary);
  if (!found) return null;
  const rest = summary.slice(found.at + found.length).trim();
  return rest.length > 0 ? rest : null;
}

export async function blockJob(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  args: {
    reason: string;
    command?: string;
    question?: boolean;
    claim?: ClaimInput;
    raw?: ClaimRaw;
  },
): Promise<JobResult> {
  if (!args.reason?.trim())
    return refuse(
      "block",
      args.question
        ? "a question block needs the question as its reason."
        : "block needs a reason: what gate was hit.",
    );
  // The command of a question is the Worker's, never the session's: a question that carried a
  // command would be a gate in disguise, and the seat answers by resuming with a note.
  if (args.question && args.command?.trim()) {
    return refuse(
      "block",
      `a question block takes no command: the Worker fixes it as '${QUESTION_COMMAND}'. Send the question as the reason, or drop question: true and block with the command.`,
    );
  }
  const blockClaim = parseClaim(args.claim);
  if ("error" in blockClaim) return refuse("block", blockClaim.error);
  const blockRaw: ClaimRaw = args.raw ?? {
    claim: args.claim,
    reason: args.reason,
    command: args.command,
  };
  const command = args.question ? QUESTION_COMMAND : args.command;
  const base = args.question ? `${QUESTION_PREFIX}${args.reason}` : args.reason;
  // Overlap warning (Track A D1): the pull requests this block names, in the job's result_ref
  // or as URLs in the command, against every other open one. The line sits before the resume
  // marker, so commandFromSummary still reads the command and nothing after it.
  const named = await readJob(env.DB, id);
  const overlaps = named
    ? await checkOverlaps(env, named.namespace, [
        ...(named.result_ref ? [named.result_ref.trim()] : []),
        ...prUrlsIn(command),
      ])
    : null;
  const overlap = overlaps ? overlapLine(overlaps) : null;
  const text = overlap
    ? `${base}

${overlap}`
    : base;
  const summary = command ? `${text}\n\n${RESUME_MARKER}\n\n    ${command}` : text;
  // The cap is applied where the block is written, so a capped job says so in result_summary,
  // the one field every reader looks at. The budget is read before the transition, which is
  // what makes this block count.
  const current = await readJob(env.DB, id);
  const capped =
    current !== null &&
    atCorrectionCap(await correctionsForWork(env.DB, current.namespace, current.title));
  return holderTransition(env, agent, now, "block", id, {
    status: "blocked",
    result_summary: capped ? cappedSummary(summary) : summary,
    overlaps,
    bumpBlocked: true,
    // The gate is the start of a wait for someone else, which the resume that ends it
    // measures from. The reason and command as the driver gave them, before the cap
    // wording is added to the summary.
    touches: (job) => [
      touchStatement(env.DB, {
        job_id: job.id,
        namespace: job.namespace,
        kind: "gate",
        actor: agent.actor,
        actor_kind: actorKind(agent.actor, { seat: callerIsSeat(agent) }),
        detail: {
          reason: args.reason,
          command: command ?? null,
          ...(args.question ? { question: true } : {}),
        },
        sinceGate: false,
        at: now.toISOString(),
      }),
    ],
    said: { claim: blockClaim.claim, raw: blockRaw },
  });
}
