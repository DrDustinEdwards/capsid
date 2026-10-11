import { AWAITING_SEAT_KEY, type AwaitingSeat } from "./auto-merge-tick";
import type { Env } from "./env";
import { ghFetch, resolveRepo } from "./github/client";
import { auditStatement } from "./store-guards";

// THE APPROVAL RECORD (docs/design/design-merge-pipeline.md section 3, PR 3; Dustin's
// DECIDE of 2026-10-09). The `approve_pr` control (src/controls.ts) records that Dustin
// approved one or more pull requests at the head sha he saw; it never merges. The
// executor in the auto-merge tick (PR 4) merges an approved pull request once its CI is
// green on that sha, and voids the approval on a new push, red CI or after 7 days.
//
// What may be approved is what the tick classed (src/merge-class.ts) into the
// awaiting-seat set: `approve` (and `auto`, which the tick merges anyway). `typed`, any
// money path, only alone and only with its number typed as confirm (design section 8:
// never batched, never automatic). `seat` and `wait`, and a pull request the tick has not
// classed, are refused. A batch holding one refused pull request is refused whole, so
// nothing is half-approved.
//
// Every write is in one D1 batch: a void of the pull request's open approval, if any
// (`UPDATE ... WHERE id = ? AND status = 'approved' RETURNING id`, CLAUDE.md path mutation
// rule), the new row, and an audit row for each.

const MAX_PRS = 20;
const SHA = /^[0-9a-f]{7,40}$/;

export interface ApprovalParams {
  namespace?: string;
  repo?: string;
  prs?: string;
  shas?: string;
  confirm?: string;
  reason?: string;
  undo?: string;
}

interface OpenApproval {
  id: number;
  pr: number;
  head_sha: string;
}

/** One pull request as the plan found it. */
interface Target {
  number: number;
  head_sha: string;
  class: string;
  // The tick's path class for it (src/merge-class.ts), the unit promotion counts in
  // (src/merge-units.ts). Null on an undo, which writes no row.
  path_class: string | null;
  open: OpenApproval | null;
}

export type ApprovalPlan =
  | { ok: true; repo: string; namespace: string; undo: boolean; surface: "portal" | "chat" | "typed"; targets: Target[]; changes: string[]; audit: string[] }
  | { ok: false; refusal: string };

function numbers(raw: string | undefined): number[] | string {
  const parts = (raw ?? "").split(/[\s,]+/).filter(Boolean);
  if (!parts.length) return "approve_pr needs prs: the pull request numbers, comma-separated (\"312,315\").";
  if (parts.length > MAX_PRS) return `approve_pr takes at most ${MAX_PRS} pull requests at once; got ${parts.length}.`;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[1-9][0-9]{0,9}$/.test(p)) return `'${p}' is not a pull request number.`;
    if (out.includes(Number(p))) return `#${p} is named twice.`;
    out.push(Number(p));
  }
  return out;
}

async function awaitingSet(env: Env): Promise<AwaitingSeat[] | string> {
  try {
    const raw = await env.APP_KV.get(AWAITING_SEAT_KEY);
    return raw ? (JSON.parse(raw) as AwaitingSeat[]) : [];
  } catch (err) {
    return `the awaiting-seat set could not be read (${err instanceof Error ? err.message : String(err)}), so no class is known and nothing is approved.`;
  }
}

/** A pull request's head and state, read from GitHub now, never from a cache. */
async function readHead(env: Env, owner: string, repo: string, number: number): Promise<{ sha: string; state: string; merged: boolean } | string> {
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls/${number}`);
  if (!resp.ok) return `#${number} could not be read from GitHub (${resp.status}).`;
  const pr = (await resp.json()) as { head?: { sha?: string }; state?: string; merged?: boolean };
  if (!pr.head?.sha) return `#${number}: GitHub answered with no head sha.`;
  return { sha: pr.head.sha, state: pr.state ?? "unknown", merged: pr.merged === true };
}

/** What approve_pr (or its Undo) will do, from the state now. Reads only. */
export async function planApproval(env: Env, actor: string, p: ApprovalParams, surface: "portal" | "chat", click: string): Promise<ApprovalPlan> {
  const refused = (refusal: string): ApprovalPlan => ({ ok: false, refusal });
  const undo = p.undo === "true";
  if (!p.namespace) return refused("approve_pr needs the namespace whose repo holds the pull requests.");
  const nums = numbers(p.prs);
  if (typeof nums === "string") return refused(nums);
  let owner: string, name: string, full: string;
  try {
    ({ owner, repo: name, full } = await resolveRepo(env, p.namespace, p.repo));
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err));
  }
  const { results } = await env.DB.prepare(`SELECT id, pr, head_sha FROM pr_approvals WHERE repo = ?1 AND status = 'approved'`).bind(full).all<OpenApproval>();
  const openBy = new Map((results ?? []).map((r) => [r.pr, r]));

  if (undo) {
    const missing = nums.filter((n) => !openBy.has(n));
    if (missing.length) return refused(`${missing.map((n) => `#${n}`).join(", ")} ${missing.length === 1 ? "has" : "have"} no open approval to undo: it was merged, voided or never approved.`);
    const targets = nums.map((n) => ({ number: n, head_sha: openBy.get(n)!.head_sha, class: "", path_class: null, open: openBy.get(n)! }));
    return {
      ok: true,
      repo: full,
      namespace: p.namespace,
      undo: true,
      surface,
      targets,
      changes: targets.map((t) => `${full}#${t.number}: the approval at ${t.head_sha.slice(0, 7)} -> voided, "undone". The executor will not merge it.`),
      audit: [`pr-approval-voided by ${actor}`, click],
    };
  }

  const shas = (p.shas ?? "").split(/[\s,]+/).filter(Boolean);
  const awaiting = await awaitingSet(env);
  if (typeof awaiting === "string") return refused(awaiting);
  const heads = await Promise.all(nums.map((n) => readHead(env, owner, name, n)));
  const problems: string[] = [];
  const targets: Target[] = [];
  nums.forEach((n, i) => {
    const head = heads[i]!;
    if (typeof head === "string") return void problems.push(head);
    if (head.merged || head.state !== "open") return void problems.push(`#${n} is ${head.merged ? "merged" : head.state}, not open.`);
    const seen = shas[i];
    // The head Dustin saw, named by the caller: a push since then is a change nobody approved.
    if (!seen) return void problems.push(`#${n} needs the head sha you reviewed (shas, in the order of prs). Its head is ${head.sha} now.`);
    if (!SHA.test(seen) || !head.sha.startsWith(seen)) return void problems.push(`#${n}'s head is ${head.sha}, not ${seen}: something was pushed since you looked. Review it again.`);
    const row = awaiting.find((a) => a.repo === full && a.number === n);
    const cls = row?.class ?? null;
    if (!row || !cls) return void problems.push(`#${n} has no class: the tick has not classed it into the awaiting-seat set yet, so nothing says what kind of approval it needs.`);
    if (cls === "seat") return void problems.push(`#${n} is class seat (${(row.class_reasons ?? []).join("; ") || "a step outside a merge"}): it stays with the seat.`);
    if (cls === "wait") return void problems.push(`#${n} is class wait (${(row.class_reasons ?? []).join("; ") || "CI or draft"}): nobody acts yet.`);
    targets.push({ number: n, head_sha: head.sha, class: cls, path_class: row.path_class ?? null, open: openBy.get(n) ?? null });
  });
  if (problems.length) return refused(`${nums.length > 1 ? "Nothing in the batch was approved. " : ""}${problems.join(" ")}`);
  const typed = targets.filter((t) => t.class === "typed");
  if (typed.length && targets.length > 1) {
    return refused(`${typed.map((t) => `#${t.number}`).join(", ")} touches a money path (class typed), which is never batched. Nothing in the batch was approved; approve it alone, with its number typed as confirm.`);
  }
  if (typed.length && p.confirm !== String(typed[0]!.number)) {
    return refused(`#${typed[0]!.number} touches a money path (class typed): type its number as confirm to approve it.`);
  }
  const replaced = targets.filter((t) => t.open);
  return {
    ok: true,
    repo: full,
    namespace: p.namespace,
    undo: false,
    surface: typed.length ? "typed" : surface,
    targets,
    changes: [
      ...targets.map((t) => `${full}#${t.number} (class ${t.class}): approved at ${t.head_sha.slice(0, 7)}. The executor merges it once CI is green on that sha; a new push, red CI or 7 days voids it.`),
      ...replaced.map((t) => `${full}#${t.number}: the earlier approval at ${t.open!.head_sha.slice(0, 7)} -> voided, "replaced".`),
      "Nothing is merged now: approve_pr never merges.",
    ],
    audit: [`pr-approved by ${actor}`, ...(replaced.length ? [`pr-approval-voided by ${actor}`] : []), click],
  };
}

/** The writes of a plan, in one batch. Returns the result's one-line summary. */
export async function performApproval(env: Env, actor: string, plan: Extract<ApprovalPlan, { ok: true }>, reason: string | null, now: Date): Promise<string> {
  const at = now.toISOString();
  const batchId = plan.targets.length > 1 ? crypto.randomUUID() : null;
  const statements: D1PreparedStatement[] = [];
  const voids = plan.undo ? plan.targets : plan.targets.filter((t) => t.open);
  const voidAt: number[] = [];
  for (const t of voids) {
    voidAt.push(statements.length);
    statements.push(
      env.DB.prepare(`UPDATE pr_approvals SET status = 'voided', closed_at = ?2, close_reason = ?3 WHERE id = ?1 AND status = 'approved' RETURNING id`).bind(
        t.open!.id,
        at,
        plan.undo ? "undone" : "replaced"
      ),
      auditStatement(env.DB, actor, "pr-approval-voided", plan.namespace, null, { repo: plan.repo, pr: t.number, head_sha: t.open!.head_sha, close_reason: plan.undo ? "undone" : "replaced" })
    );
  }
  if (!plan.undo) {
    for (const t of plan.targets) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO pr_approvals (repo, pr, head_sha, class, status, approved_by, surface, batch_id, reason, approved_at, namespace, path_class)
           VALUES (?1, ?2, ?3, ?4, 'approved', ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
        ).bind(plan.repo, t.number, t.head_sha, t.class, actor, plan.surface, batchId, reason, at, plan.namespace, t.path_class),
        auditStatement(env.DB, actor, "pr-approved", plan.namespace, null, { repo: plan.repo, pr: t.number, head_sha: t.head_sha, class: t.class, surface: plan.surface, batch_id: batchId })
      );
    }
  }
  const results = await env.DB.batch(statements);
  // Each void must have moved its row: one that did not was merged, voided or replaced
  // between the preview and now, and the batch's other rows are already written.
  const moved = voidAt.filter((i) => (results[i]?.results?.length ?? 0) > 0).length;
  const nums = plan.targets.map((t) => `#${t.number}`).join(", ");
  if (plan.undo) return `Undid the approval of ${plan.repo} ${nums}${moved < voids.length ? ` (${voids.length - moved} had already ended)` : ""}.`;
  return `Approved ${plan.repo} ${nums}. The executor merges ${plan.targets.length === 1 ? "it" : "each"} once CI is green on the approved sha.`;
}
